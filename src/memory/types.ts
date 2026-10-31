/**
 * AgentMemory types — spec §38.1, shared by every binding.
 *
 * Field names are the spec's camelCase and enum values the spec's UPPERCASE
 * strings, with no case folding anywhere: Rust, WASM host calls and the cloud
 * table carry the same strings, and one lowercased copy is how the bindings
 * drift apart.
 *
 * Two shapes of an entry:
 *   - MemoryEntry      what a gene sees: `value` is bytes (Uint8Array);
 *   - MemoryEntryJson  what crosses JSON (napi, host calls, cloud): `value`
 *                      is standard base64, padded.
 * toEntryJson / fromEntryJson are the only conversion between them.
 */

export const MEMORY_CATEGORIES = ["PREFERENCE", "PATTERN", "CONTEXT", "CACHE"] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const ACCESS_SCOPES = ["CREATOR_GENE_ONLY", "SAME_DOMAIN", "ALL_GENES", "DEPLOYER_CONFIGURED"] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

export const SHARE_POLICIES = ["PRIVATE", "ANONYMIZED_SHARE", "KNOWLEDGE_GENE"] as const;
export type SharePolicy = (typeof SHARE_POLICIES)[number];

export interface MemoryAccessPolicy {
  readScope: AccessScope;
  writeScope: AccessScope;
  sharePolicy: SharePolicy;
}

/** What `writeMemory` uses when the caller gives no policy. */
export const DEFAULT_ACCESS_POLICY: Readonly<MemoryAccessPolicy> = Object.freeze({
  readScope: "SAME_DOMAIN",
  writeScope: "SAME_DOMAIN",
  sharePolicy: "PRIVATE",
});

/** Spec §30.2 RetentionPolicy. */
export interface RetentionPolicy {
  /** null = no limit. */
  maxRetentionDays: number | null;
  autoDeleteOnTermination: boolean;
  anonymizationSupported: boolean;
}

export interface MemoryEntry {
  /** Lowercase hex SHA-256 of `agentId + "\0" + key` (entryIdFor). */
  entryId: string;
  category: MemoryCategory;
  key: string;
  value: Uint8Array;
  /** Content-derived gene id of the gene that created the entry. */
  createdBy: string;
  lastAccessedBy: string | null;
  /** RFC 3339 UTC. */
  createdAt: string;
  /** RFC 3339 UTC. */
  updatedAt: string;
  accessPolicy: MemoryAccessPolicy;
  /** null = inherit the agent's DataPolicy retention. */
  retentionPolicy: RetentionPolicy | null;
}

export type MemoryEntryJson = Omit<MemoryEntry, "value"> & { value: string };

export interface AgentMemory {
  agentId: string;
  entries: MemoryEntry[];
  /** Bytes of key + value over all entries (the quota's unit). */
  totalSize: number;
  /** Bytes. */
  quota: number;
  createdAt: string;
}

/**
 * queryMemory's filter (final). Every field is optional
 * and they combine with AND:
 *   - category   one MemoryCategory;
 *   - keyPrefix  a plain prefix of the key, not a pattern;
 *   - since      RFC 3339, inclusive, compared with `updatedAt`;
 *   - until      RFC 3339, exclusive, compared with `updatedAt`;
 *   - limit      default 100, capped at 1000.
 * Results come newest first (`updatedAt` descending, ties by `entryId`).
 * Unknown fields are MEMORY_INVALID_INPUT; no alias names are accepted.
 */
export interface MemoryFilter {
  category?: MemoryCategory;
  keyPrefix?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export const MEMORY_FILTER_FIELDS = ["category", "keyPrefix", "since", "until", "limit"] as const;
export const MEMORY_QUERY_DEFAULT_LIMIT = 100;
export const MEMORY_QUERY_MAX_LIMIT = 1000;

/**
 * Shared across bindings. MEMORY_STORAGE_ERROR is a
 * storage / IO failure, a missing native binding, or a database error; it is
 * never folded into MEMORY_INVALID_INPUT.
 */
export const MEMORY_ERROR_CODES = [
  "MEMORY_NOT_FOUND",
  "MEMORY_ACCESS_DENIED",
  "MEMORY_QUOTA_EXCEEDED",
  "MEMORY_INVALID_INPUT",
  "MEMORY_STORAGE_ERROR",
] as const;
export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

/**
 * A memory error. `code` is one of the five; `message` is the explanation
 * alone, without the code in front (a no-agent-context message
 * starts with "no agent context").
 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
  }
}

/** A single value, after base64 decoding. */
export const MEMORY_MAX_VALUE_BYTES = 1024 * 1024;
/** One queryMemory response, serialized. */
export const MEMORY_MAX_QUERY_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 10 MB of key + value. */
export const DEFAULT_MEMORY_QUOTA_BYTES = 10 * 1024 * 1024;

export function isMemoryCategory(value: unknown): value is MemoryCategory {
  return typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value);
}

export function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === "string" && (ACCESS_SCOPES as readonly string[]).includes(value);
}

export function isSharePolicy(value: unknown): value is SharePolicy {
  return typeof value === "string" && (SHARE_POLICIES as readonly string[]).includes(value);
}
