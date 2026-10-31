/**
 * Wire format of the agent-memory edge function (v0.9.4, spec §38).
 *
 * This file is the single mapping layer between the camelCase JSON the CLI
 * and SDK speak and the snake_case rows of agent_memory_entries
 * (migration 20261030220000). Everything here is pure, so it is tested
 * without a database.
 */

export const MEMORY_CATEGORIES = ["PREFERENCE", "PATTERN", "CONTEXT", "CACHE"] as const;
export const ACCESS_SCOPES = ["CREATOR_GENE_ONLY", "SAME_DOMAIN", "ALL_GENES", "DEPLOYER_CONFIGURED"] as const;
export const SHARE_POLICIES = ["PRIVATE", "ANONYMIZED_SHARE", "KNOWLEDGE_GENE"] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];
export type AccessScope = (typeof ACCESS_SCOPES)[number];
export type SharePolicy = (typeof SHARE_POLICIES)[number];

export type MemoryErrorCode =
  | "MEMORY_NOT_FOUND"
  | "MEMORY_ACCESS_DENIED"
  | "MEMORY_QUOTA_EXCEEDED"
  | "MEMORY_INVALID_INPUT"
  /** Storage or database failure; fixed message, never the raw error. */
  | "MEMORY_STORAGE_ERROR";

/** Thrown anywhere in the function; the handler turns it into a response. */
export class MemoryError extends Error {
  /**
   * @param expired entries purged for expiry before the refusal:
   *   a refused call's purge stands and is reported in the error.
   */
  constructor(readonly code: MemoryErrorCode, message: string, readonly expired: { entryId: string }[] = []) {
    super(message);
    this.name = "MemoryError";
  }
}

export const HTTP_STATUS: Record<MemoryErrorCode, number> = {
  MEMORY_INVALID_INPUT: 400,
  MEMORY_ACCESS_DENIED: 403,
  MEMORY_NOT_FOUND: 404,
  MEMORY_QUOTA_EXCEEDED: 413,
  MEMORY_STORAGE_ERROR: 500,
};

/** Same bounds as the migration's CHECKs and rotifer-core MAX_KEY_BYTES. */
export const MAX_KEY_BYTES = 1024;
export const MAX_QUOTA_BYTES = 100 * 1024 * 1024;
export const MAX_QUERY_LIMIT = 1000;
/** Decoded value bytes; same as the migration's CHECK. */
export const MAX_VALUE_BYTES = 1024 * 1024;
/** Bytes of a whole response body. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_QUERY_LIMIT = 100;
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** A calling gene is named by its v2 id, v2:<64 lowercase hex>. */
export const V2_GENE_ID_RE = /^v2:[0-9a-f]{64}$/;

export interface CallerGene {
  geneId: string;
  domain: string;
}

export interface MemoryAccessPolicy {
  readScope: AccessScope;
  writeScope: AccessScope;
  sharePolicy: SharePolicy;
}

/** §38.1 MemoryEntry as it crosses the wire. */
export interface MemoryEntryJson {
  entryId: string;
  category: MemoryCategory;
  key: string;
  value: string;
  createdBy: string;
  lastAccessedBy: string | null;
  createdAt: string;
  updatedAt: string;
  accessPolicy: MemoryAccessPolicy;
  retentionPolicy: RetentionPolicy | null;
}

/** A row of agent_memory_entries as PostgREST or to_jsonb returns it. */
export interface EntryRow {
  entry_id: string;
  agent_id: string;
  category: MemoryCategory;
  key: string;
  value: string; // bytea as "\x<hex>"
  created_by: string;
  created_by_domain: string | null;
  last_accessed_by: string | null;
  created_at: string;
  updated_at: string;
  read_scope: AccessScope;
  write_scope: AccessScope;
  share_policy: SharePolicy;
  retention_policy: RetentionPolicy | null;
}

/**
 * queryMemory filter: since inclusive, until exclusive, both on
 * updatedAt; limit defaults to 100, at most 1000; results newest first.
 */
/** Spec §30.2 RetentionPolicy, exactly these fields. */
export interface RetentionPolicy {
  maxRetentionDays: number | null;
  autoDeleteOnTermination: boolean;
  anonymizationSupported: boolean;
}

/** Same upper bound as agent_memory_retention_policy_valid. */
export const MAX_RETENTION_DAYS = 2147483647;

export interface MemoryFilter {
  category?: MemoryCategory;
  keyPrefix?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export type MemoryRequest =
  | { op: "register"; agentId: string; quota?: number }
  | {
    op: "write";
    agentId: string;
    caller: CallerGene;
    key: string;
    value: Uint8Array;
    category: MemoryCategory;
    accessPolicy?: MemoryAccessPolicy;
    /** undefined = keep (or null on create); null = reset to inherit; object = set. */
    retentionPolicy?: RetentionPolicy | null;
  }
  | { op: "read"; agentId: string; caller: CallerGene; key: string; category?: MemoryCategory }
  | { op: "query"; agentId: string; caller: CallerGene; filter: MemoryFilter }
  | { op: "delete"; agentId: string; caller: CallerGene; key: string };

export const OPS = ["register", "write", "read", "query", "delete"] as const;

// ── bytes ────────────────────────────────────────────────────

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Standard alphabet, padded; anything else is refused. */
export function base64ToBytes(s: string): Uint8Array {
  if (!BASE64_RE.test(s)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "value must be standard padded base64");
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Postgres bytea text form, as PostgREST and to_jsonb render it. */
export function byteaToBytes(s: string): Uint8Array {
  if (!/^\\x(?:[0-9a-fA-F]{2})*$/.test(s)) {
    throw new Error(`unexpected bytea text from the database: ${s.slice(0, 16)}`);
  }
  const hex = s.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToBytea(bytes: Uint8Array): string {
  let hex = "\\x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

// ── rows → wire ──────────────────────────────────────────────

/** RFC 3339 UTC with milliseconds, the form rotifer-core writes. */
export function toRfc3339(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) throw new Error(`unexpected timestamp from the database: ${ts}`);
  return d.toISOString();
}

export function rowToEntry(row: EntryRow): MemoryEntryJson {
  return {
    entryId: row.entry_id,
    category: row.category,
    key: row.key,
    value: bytesToBase64(byteaToBytes(row.value)),
    createdBy: row.created_by,
    lastAccessedBy: row.last_accessed_by,
    createdAt: toRfc3339(row.created_at),
    updatedAt: toRfc3339(row.updated_at),
    accessPolicy: {
      readScope: row.read_scope,
      writeScope: row.write_scope,
      sharePolicy: row.share_policy,
    },
    retentionPolicy: row.retention_policy,
  };
}

// ── request validation ───────────────────────────────────────

function invalid(message: string): never {
  throw new MemoryError("MEMORY_INVALID_INPUT", message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyFields(obj: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) invalid(`unknown field '${k}' in ${where}`);
  }
}

function agentIdOf(v: unknown): string {
  if (typeof v !== "string" || !AGENT_ID_RE.test(v)) {
    invalid("agentId must be 1-128 characters of letters, digits, '.', '_', ':' or '-'");
  }
  return v;
}

function keyOf(v: unknown): string {
  if (typeof v !== "string") invalid("key must be a string");
  const bytes = new TextEncoder().encode(v).length;
  if (bytes < 1 || bytes > MAX_KEY_BYTES) invalid(`key must be 1-${MAX_KEY_BYTES} bytes of UTF-8`);
  if (v.includes("\0")) invalid("key must not contain NUL");
  return v;
}

function oneOf<T extends string>(v: unknown, values: readonly T[], name: string): T {
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) {
    invalid(`${name} must be one of ${values.join(", ")} (uppercase)`);
  }
  return v as T;
}

function callerOf(v: unknown): CallerGene {
  if (!isPlainObject(v)) invalid("caller must be an object { geneId, domain }");
  onlyFields(v, ["geneId", "domain"], "caller");
  const { geneId, domain } = v;
  if (typeof geneId !== "string" || geneId.length < 1 || geneId.length > 256) {
    invalid("caller.geneId must be a 1-256 character string");
  }
  if (typeof domain !== "string" || domain.length < 1 || domain.length > 256) {
    invalid("caller.domain must be a 1-256 character string");
  }
  return { geneId, domain };
}

function accessPolicyOf(v: unknown): MemoryAccessPolicy {
  if (!isPlainObject(v)) invalid("accessPolicy must be an object");
  onlyFields(v, ["readScope", "writeScope", "sharePolicy"], "accessPolicy");
  return {
    readScope: oneOf(v.readScope, ACCESS_SCOPES, "accessPolicy.readScope"),
    writeScope: oneOf(v.writeScope, ACCESS_SCOPES, "accessPolicy.writeScope"),
    sharePolicy: oneOf(v.sharePolicy, SHARE_POLICIES, "accessPolicy.sharePolicy"),
  };
}

function retentionOf(v: unknown): RetentionPolicy | null {
  if (v === null) return null;
  const shape =
    "retentionPolicy must be null or exactly { maxRetentionDays: positive integer or null, autoDeleteOnTermination: boolean, anonymizationSupported: boolean }";
  if (!isPlainObject(v)) invalid(shape);
  const keys = Object.keys(v);
  if (
    keys.length !== 3 || !("maxRetentionDays" in v) || !("autoDeleteOnTermination" in v) ||
    !("anonymizationSupported" in v)
  ) invalid(shape);
  const days = v.maxRetentionDays;
  if (
    days !== null &&
    (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_RETENTION_DAYS)
  ) invalid(shape);
  if (typeof v.autoDeleteOnTermination !== "boolean" || typeof v.anonymizationSupported !== "boolean") invalid(shape);
  return {
    maxRetentionDays: days as number | null,
    autoDeleteOnTermination: v.autoDeleteOnTermination,
    anonymizationSupported: v.anonymizationSupported,
  };
}

function timestampOf(v: unknown, name: string): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) ||
    Number.isNaN(new Date(v).getTime())) {
    invalid(`${name} must be an RFC 3339 timestamp`);
  }
  return new Date(v).toISOString();
}

function filterOf(v: unknown): MemoryFilter {
  if (v === undefined) return {};
  if (!isPlainObject(v)) invalid("filter must be an object");
  onlyFields(v, ["category", "keyPrefix", "since", "until", "limit"], "filter");
  const f: MemoryFilter = {};
  if (v.category !== undefined) f.category = oneOf(v.category, MEMORY_CATEGORIES, "filter.category");
  if (v.keyPrefix !== undefined) {
    if (typeof v.keyPrefix !== "string" || v.keyPrefix.includes("\0")) invalid("filter.keyPrefix must be a string");
    f.keyPrefix = v.keyPrefix;
  }
  if (v.since !== undefined) f.since = timestampOf(v.since, "filter.since");
  if (v.until !== undefined) f.until = timestampOf(v.until, "filter.until");
  if (v.limit !== undefined) {
    if (typeof v.limit !== "number" || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > MAX_QUERY_LIMIT) {
      invalid(`filter.limit must be an integer 1-${MAX_QUERY_LIMIT}`);
    }
    f.limit = v.limit;
  }
  return f;
}

/** Parses and validates one request; `op` comes from the URL path. */
export function parseRequest(op: string, body: unknown): MemoryRequest {
  if (!(OPS as readonly string[]).includes(op)) {
    invalid(`unknown operation '${op}'; use one of ${OPS.join(", ")}`);
  }
  if (!isPlainObject(body)) invalid("the request body must be a JSON object");

  switch (op) {
    case "register": {
      onlyFields(body, ["agentId", "quota"], "register");
      const req: MemoryRequest = { op, agentId: agentIdOf(body.agentId) };
      if (body.quota !== undefined) {
        const q = body.quota;
        if (typeof q !== "number" || !Number.isInteger(q) || q <= 0) {
          invalid("quota must be a positive whole number of bytes");
        }
        if (q > MAX_QUOTA_BYTES) {
          invalid(`quota ${q} is over this Cloud's limit of ${MAX_QUOTA_BYTES} bytes (100 MiB) per agent`);
        }
        req.quota = q;
      }
      return req;
    }
    case "write": {
      onlyFields(body, ["agentId", "caller", "key", "value", "category", "accessPolicy", "retentionPolicy"], "write");
      if (typeof body.value !== "string") invalid("value must be a base64 string");
      const value = base64ToBytes(body.value);
      if (value.length > MAX_VALUE_BYTES) {
        invalid(`value is ${value.length} bytes; the limit is ${MAX_VALUE_BYTES} (1 MiB)`);
      }
      const req: MemoryRequest = {
        op,
        agentId: agentIdOf(body.agentId),
        caller: callerOf(body.caller),
        key: keyOf(body.key),
        value,
        category: oneOf(body.category, MEMORY_CATEGORIES, "category"),
      };
      if (body.accessPolicy !== undefined && body.accessPolicy !== null) {
        req.accessPolicy = accessPolicyOf(body.accessPolicy);
      }
      if ("retentionPolicy" in body) req.retentionPolicy = retentionOf(body.retentionPolicy);
      return req;
    }
    case "read": {
      onlyFields(body, ["agentId", "caller", "key", "category"], "read");
      const req: MemoryRequest = {
        op,
        agentId: agentIdOf(body.agentId),
        caller: callerOf(body.caller),
        key: keyOf(body.key),
      };
      if (body.category !== undefined && body.category !== null) {
        req.category = oneOf(body.category, MEMORY_CATEGORIES, "category");
      }
      return req;
    }
    case "query": {
      onlyFields(body, ["agentId", "caller", "filter"], "query");
      return { op, agentId: agentIdOf(body.agentId), caller: callerOf(body.caller), filter: filterOf(body.filter) };
    }
    default: {
      onlyFields(body, ["agentId", "caller", "key"], "delete");
      return { op: "delete", agentId: agentIdOf(body.agentId), caller: callerOf(body.caller), key: keyOf(body.key) };
    }
  }
}

// ── database errors → contract codes ─────────────────────────

/** Database messages a client may see verbatim, besides MEMORY_* ones. */
const CLOSED_ACCOUNT = "this account is closed and can no longer write";

/**
 * Maps a Postgres error (SQLSTATE + message, as supabase-js reports it) to a
 * contract error, or null when it is not one the caller can act on.
 *
 * Only messages the migration wrote for clients (MEMORY_* prefixed, and the
 * closed-account guard's) pass through. Anything else gets a fixed message:
 * raw Postgres errors name constraints and columns and can quote key values
 * ("Key (owner_id, agent_id)=(…)").
 */
export function mapDbError(code: string | undefined, message: string | undefined): MemoryError | null {
  const msg = message ?? "";
  const prefixed = /^(MEMORY_(?:NOT_FOUND|ACCESS_DENIED|QUOTA_EXCEEDED|INVALID_INPUT)): ?(.*)$/s.exec(msg);
  if (prefixed) return new MemoryError(prefixed[1] as MemoryErrorCode, prefixed[2]);
  switch (code) {
    case "53400":
      return new MemoryError("MEMORY_QUOTA_EXCEEDED", "the agent's memory quota is full");
    case "42501":
      return new MemoryError("MEMORY_ACCESS_DENIED", msg === CLOSED_ACCOUNT ? msg : "not allowed for this account");
    case "23503":
      return new MemoryError("MEMORY_NOT_FOUND", "the agent has no memory registered for this account");
    case "22023":
    case "22P02":
    case "23514":
      return new MemoryError("MEMORY_INVALID_INPUT", "a value is out of range or malformed");
    default:
      return null;
  }
}
