/**
 * Conversions at the AgentMemory boundary: entry ids, base64
 * values, the JSON shape of an entry, timestamps and the quota size syntax.
 * Anything that does not parse is MEMORY_INVALID_INPUT, never coerced.
 */
import { createHash } from "node:crypto";
import {
  MemoryError,
  isAccessScope,
  isMemoryCategory,
  isSharePolicy,
  type MemoryAccessPolicy,
  type MemoryEntry,
  type MemoryEntryJson,
  type RetentionPolicy,
} from "./types.js";

/** Lowercase hex SHA-256 of `agentId + "\0" + key`. Updates keep the id. */
export function entryIdFor(agentId: string, key: string): string {
  return createHash("sha256").update(`${agentId}\0${key}`, "utf8").digest("hex");
}

// Standard alphabet, padded: the same in every binding.
// Buffer.from(…, "base64") would also accept base64url, missing padding and
// stray characters, and silently decode something else.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function encodeValue(value: Uint8Array): string {
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
}

export function decodeValue(base64: unknown): Uint8Array {
  if (typeof base64 !== "string" || !BASE64.test(base64)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "value must be standard base64 (A–Z a–z 0–9 + /, padded)");
  }
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** Keys are UTF-8 text without NUL (the entry id uses "\0" as its separator). */
export const MAX_KEY_BYTES = 1024;

export function checkKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "key must be a non-empty string");
  }
  if (key.includes("\0")) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "key must not contain a NUL character");
  }
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `key is longer than ${MAX_KEY_BYTES} bytes`);
  }
  return key;
}

export function checkAccessPolicy(policy: unknown): MemoryAccessPolicy {
  const p = policy as Partial<MemoryAccessPolicy> | null;
  if (!p || typeof p !== "object") {
    throw new MemoryError("MEMORY_INVALID_INPUT", "accessPolicy must be an object");
  }
  if (!isAccessScope(p.readScope)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `unknown readScope '${String(p.readScope)}'`);
  }
  if (!isAccessScope(p.writeScope)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `unknown writeScope '${String(p.writeScope)}'`);
  }
  if (!isSharePolicy(p.sharePolicy)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `unknown sharePolicy '${String(p.sharePolicy)}'`);
  }
  return { readScope: p.readScope, writeScope: p.writeScope, sharePolicy: p.sharePolicy };
}

/** A retentionPolicy is at most 4 KiB of JSON. */
/** Spec §30.2 `Int`: maxRetentionDays is 1..2147483647. */
export const MAX_RETENTION_DAYS = 2147483647;
const RETENTION_FIELDS = ["maxRetentionDays", "autoDeleteOnTermination", "anonymizationSupported"];

export function checkRetentionPolicy(policy: unknown): RetentionPolicy | null {
  if (policy === null || policy === undefined) return null;
  const unknown = typeof policy === "object" ? Object.keys(policy as object).filter((k) => !RETENTION_FIELDS.includes(k)) : [];
  if (unknown.length > 0) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `unknown retentionPolicy field(s) ${unknown.join(", ")}`);
  }
  const p = policy as Partial<RetentionPolicy>;
  const days = p.maxRetentionDays;
  if (
    typeof p !== "object" ||
    !(days === null || (Number.isInteger(days) && (days as number) >= 1 && (days as number) <= MAX_RETENTION_DAYS)) ||
    typeof p.autoDeleteOnTermination !== "boolean" ||
    typeof p.anonymizationSupported !== "boolean"
  ) {
    throw new MemoryError(
      "MEMORY_INVALID_INPUT",
      `retentionPolicy must be {maxRetentionDays: integer 1..${MAX_RETENTION_DAYS} | null, autoDeleteOnTermination: boolean, anonymizationSupported: boolean} or null`,
    );
  }
  return {
    maxRetentionDays: days as number | null,
    autoDeleteOnTermination: p.autoDeleteOnTermination,
    anonymizationSupported: p.anonymizationSupported,
  };
}

/** RFC 3339 UTC, as timestamps go on the wire. */
export function toTimestamp(ms: number): string {
  return new Date(ms).toISOString();
}

// RFC 3339 date-time: full date, full time, seconds, optional fraction, and
// an explicit offset ("Z" or ±hh:mm). Date.parse alone accepts "2026" and
// rolls "2026-02-30" over into March.
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function parseTimestamp(value: unknown, field: string): number {
  const bad = () => new MemoryError("MEMORY_INVALID_INPUT", `${field} must be an RFC 3339 timestamp, e.g. 2026-10-30T12:00:00Z`);
  const m = typeof value === "string" ? RFC3339.exec(value) : null;
  if (!m) throw bad();
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) throw bad();
  const ms = Date.parse(value as string);
  if (Number.isNaN(ms)) throw bad();
  return ms;
}

export function toEntryJson(entry: MemoryEntry): MemoryEntryJson {
  return { ...entry, value: encodeValue(entry.value) };
}

/** Parse an entry received over JSON; refuses anything outside the wire format. */
export function fromEntryJson(json: unknown): MemoryEntry {
  const j = json as Partial<MemoryEntryJson> | null;
  if (!j || typeof j !== "object") throw new MemoryError("MEMORY_INVALID_INPUT", "entry must be an object");
  if (!isMemoryCategory(j.category)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `unknown category '${String(j.category)}'`);
  }
  if (typeof j.entryId !== "string" || !/^[0-9a-f]{64}$/.test(j.entryId)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "entryId must be 64 lowercase hex characters");
  }
  if (typeof j.createdBy !== "string" || j.createdBy.length === 0) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "createdBy must be a gene id");
  }
  parseTimestamp(j.createdAt, "createdAt");
  parseTimestamp(j.updatedAt, "updatedAt");
  return {
    entryId: j.entryId,
    category: j.category,
    key: checkKey(j.key),
    value: decodeValue(j.value),
    createdBy: j.createdBy,
    lastAccessedBy: typeof j.lastAccessedBy === "string" ? j.lastAccessedBy : null,
    createdAt: j.createdAt as string,
    updatedAt: j.updatedAt as string,
    accessPolicy: checkAccessPolicy(j.accessPolicy),
    retentionPolicy: checkRetentionPolicy(j.retentionPolicy),
  };
}

const QUOTA_UNITS: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

/**
 * `--memory-quota`: a positive number with a KB / MB /
 * GB suffix (binary units, case-insensitive), e.g. `512KB`, `10MB`, `1.5GB`.
 * Zero, negative and unit-less values are refused rather than guessed.
 */
export function parseMemoryQuota(input: string): number {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*(KB|MB|GB)\s*$/i.exec(input);
  if (!match) {
    throw new MemoryError(
      "MEMORY_INVALID_INPUT",
      `memory quota '${input}' is not a size; use a number with KB, MB or GB, e.g. 10MB`,
    );
  }
  const bytes = Math.floor(Number(match[1]) * QUOTA_UNITS[match[2].toUpperCase()]);
  if (!(bytes > 0)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `memory quota must be greater than zero (got '${input}')`);
  }
  // Past 2^53 a JS number stops counting bytes exactly; the store (u64)
  // would get a different quota from the one asked for.
  if (!Number.isSafeInteger(bytes)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `memory quota '${input}' is too large`);
  }
  return bytes;
}

/**
 * What the quota counts: the UTF-8 bytes of the key and the
 * value's bytes — never JS string length. The retentionPolicy is bounded by
 * its §30.2 schema and not counted.
 */
export function entrySize(key: string, value: Uint8Array): number {
  return Buffer.byteLength(key, "utf8") + value.byteLength;
}

/** A gene id as a caller's must be: "v2:" and 64 lowercase hex digits. */
export function isV2GeneId(id: unknown): boolean {
  return typeof id === "string" && /^v2:[0-9a-f]{64}$/.test(id);
}
