import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildZip } from "../helpers/build-zip.js";
import { assertOnlyRegularFiles, assertSafeZip, UnsafeArchiveError } from "../../src/utils/zip-safety.js";

const file = (name: string) => ({ name, content: "x" });

describe("assertSafeZip reads the archive before anything is extracted", () => {
  it("accepts an ordinary package, including nested paths and dots in names", () => {
    expect(() => assertSafeZip(buildZip([file("SKILL.md"), file("a/b/c..d.md"), file(".hidden")]))).not.toThrow();
  });

  it("accepts a directory entry", () => {
    expect(() => assertSafeZip(buildZip([{ name: "dir/", content: "", mode: 0o040755 }]))).not.toThrow();
  });

  it.each([
    ["parent segment", "../x"],
    ["parent segment in the middle", "a/../../x"],
    ["backslash parent segment", "..\\x"],
    ["absolute path", "/etc/x"],
    ["backslash absolute path", "\\etc\\x"],
    ["drive letter", "C:\\x"],
    ["drive letter with a forward slash", "c:/x"],
  ])("refuses %s", (_label, name) => {
    expect(() => assertSafeZip(buildZip([file("SKILL.md"), file(name)]))).toThrow(UnsafeArchiveError);
  });

  it("refuses an entry with the link bits set", () => {
    const zip = buildZip([file("SKILL.md"), { name: "x", content: "/etc/passwd", mode: 0o120777 }]);
    expect(() => assertSafeZip(zip)).toThrow(/link/i);
  });

  it("refuses a name holding a NUL byte", () => {
    expect(() => assertSafeZip(buildZip([file("a\0b")]))).toThrow(UnsafeArchiveError);
  });

  it("refuses bytes that are not a zip", () => {
    expect(() => assertSafeZip(Buffer.from("not a zip"))).toThrow(UnsafeArchiveError);
  });

  it("refuses trailing bytes after the archive, where a second reader could disagree", () => {
    const zip = Buffer.concat([buildZip([file("SKILL.md")]), Buffer.from("trailing")]);
    expect(() => assertSafeZip(zip)).toThrow(UnsafeArchiveError);
  });

  it("refuses an end record that claims more entries than the directory holds", () => {
    const zip = buildZip([file("SKILL.md")]);
    zip.writeUInt16LE(2, zip.length - 22 + 10);
    expect(() => assertSafeZip(zip)).toThrow(UnsafeArchiveError);
  });

  it("refuses a central directory offset past the end of the file", () => {
    const zip = buildZip([file("SKILL.md")]);
    zip.writeUInt32LE(0xfffffff0, zip.length - 22 + 16);
    expect(() => assertSafeZip(zip)).toThrow(UnsafeArchiveError);
  });
});

describe("assertOnlyRegularFiles checks what extraction actually produced", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "rotifer-zipsafe-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("accepts files and directories", () => {
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "a", "f"), "x");
    expect(() => assertOnlyRegularFiles(dir)).not.toThrow();
  });

  it("refuses a link, even a nested one that points inside", () => {
    mkdirSync(join(dir, "a"));
    writeFileSync(join(dir, "f"), "x");
    symlinkSync(join(dir, "f"), join(dir, "a", "l"));
    expect(() => assertOnlyRegularFiles(dir)).toThrow(UnsafeArchiveError);
  });

  it("refuses a dangling link", () => {
    symlinkSync(join(dir, "missing"), join(dir, "l"));
    expect(() => assertOnlyRegularFiles(dir)).toThrow(UnsafeArchiveError);
  });
});
