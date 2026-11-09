import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A downloaded archive is someone else's upload. These two checks stop it from
 * reaching outside its own files: one reads the archive before anything is
 * written, the other inspects what extraction really produced, in case
 * `unzip` read the archive differently than this parser did.
 */
export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

const END_RECORD = 0x06054b50;
const END_RECORD_SIZE = 22;
const CENTRAL_ENTRY = 0x02014b50;
const CENTRAL_ENTRY_SIZE = 46;
const MAX_COMMENT = 0xffff;
const FILE_TYPE_MASK = 0o170000;
const SYMLINK_TYPE = 0o120000;

function unreadable(reason: string): UnsafeArchiveError {
  return new UnsafeArchiveError(`the archive could not be read safely (${reason})`);
}

/** Finds the end record the way `unzip` does: the last signature in the tail. */
function findEndRecord(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - END_RECORD_SIZE - MAX_COMMENT);
  for (let i = zip.length - END_RECORD_SIZE; i >= lowest; i--) {
    if (zip.readUInt32LE(i) === END_RECORD) return i;
  }
  throw unreadable("no end-of-archive record");
}

function checkEntryName(name: string): void {
  const shown = JSON.stringify(name);
  if (name.includes("\0")) throw new UnsafeArchiveError(`entry ${shown} has a NUL byte in its name`);
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new UnsafeArchiveError(`entry ${shown} has an absolute path`);
  }
  if (normalized.split("/").includes("..")) {
    throw new UnsafeArchiveError(`entry ${shown} climbs out of the archive`);
  }
}

/**
 * Throws UnsafeArchiveError when the zip holds a link, a path that leaves the
 * extraction directory, or a structure this parser cannot vouch for. Bytes it
 * cannot read are refused rather than handed to `unzip` on trust.
 */
export function assertSafeZip(zip: Buffer): void {
  if (zip.length < END_RECORD_SIZE) throw unreadable("too short");

  const end = findEndRecord(zip);
  if (end + END_RECORD_SIZE + zip.readUInt16LE(end + 20) !== zip.length) {
    throw unreadable("bytes after the end of the archive");
  }

  const count = zip.readUInt16LE(end + 10);
  const offset = zip.readUInt32LE(end + 16);
  if (offset >= end && count > 0) throw unreadable("directory outside the file");

  let pos = offset;
  for (let i = 0; i < count; i++) {
    if (pos + CENTRAL_ENTRY_SIZE > end || zip.readUInt32LE(pos) !== CENTRAL_ENTRY) {
      throw unreadable("directory shorter than it claims");
    }
    const nameLength = zip.readUInt16LE(pos + 28);
    const extraLength = zip.readUInt16LE(pos + 30);
    const commentLength = zip.readUInt16LE(pos + 32);
    const mode = zip.readUInt32LE(pos + 38) >>> 16;
    const nameEnd = pos + CENTRAL_ENTRY_SIZE + nameLength;
    if (nameEnd > end) throw unreadable("entry name past the directory");

    const name = zip.toString("utf-8", pos + CENTRAL_ENTRY_SIZE, nameEnd);
    checkEntryName(name);
    if ((mode & FILE_TYPE_MASK) === SYMLINK_TYPE) {
      throw new UnsafeArchiveError(`entry ${JSON.stringify(name)} is a symbolic link`);
    }
    pos = nameEnd + extraLength + commentLength;
  }
}

/** Throws UnsafeArchiveError when `dir` holds anything but regular files and directories. */
export function assertOnlyRegularFiles(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      assertOnlyRegularFiles(path);
    } else if (!stat.isFile()) {
      const kind = stat.isSymbolicLink() ? "a symbolic link" : "not a regular file";
      throw new UnsafeArchiveError(`extracted entry ${JSON.stringify(entry)} is ${kind}`);
    }
  }
}
