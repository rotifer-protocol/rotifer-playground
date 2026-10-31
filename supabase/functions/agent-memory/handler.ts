/**
 * agent-memory request handling: register / write / read / query / delete
 * (v0.9.4; spec §38.2).
 *
 *   POST /functions/v1/agent-memory/<op>   body: camelCase JSON (wire.ts)
 *   200  { memory } | { entry, evicted } | { entry } | { entries } | { deleted }
 *   4xx  { error: { code, message } }   code from wire.ts
 *
 * The handler takes a MemoryStore so it can be tested without a database;
 * store.ts is the Supabase implementation, which runs every query as the
 * signed-in caller under RLS.
 */

import { canRead } from "./access.ts";
import {
  bytesToBytea,
  type CallerGene,
  type EntryRow,
  DEFAULT_QUERY_LIMIT,
  HTTP_STATUS,
  MAX_RESPONSE_BYTES,
  mapDbError,
  MemoryError,
  type MemoryFilter,
  type MemoryRequest,
  parseRequest,
  type RetentionPolicy,
  rowToEntry,
  toRfc3339,
  V2_GENE_ID_RE,
} from "./wire.ts";

export interface ContainerRow {
  agent_id: string;
  quota_bytes: number;
  total_size: number;
  created_at: string;
}

export interface EvictedEntry {
  entryId: string;
  key: string;
  category: string;
  sizeBytes: number;
}

/** An entry purged because its retention ran out: id only, no key. */
export interface ExpiredEntry {
  entryId: string;
}

export interface WriteParams {
  agentId: string;
  key: string;
  /** "\x<hex>" */
  value: string;
  category: string;
  callerGeneId: string;
  callerDomain: string;
  readScope: string | null;
  writeScope: string | null;
  sharePolicy: string | null;
  retentionPolicy: RetentionPolicy | null;
  setRetention: boolean;
}

/** Every method throws DbError for a database error. */
export interface MemoryStore {
  registerContainer(agentId: string, quota: number | undefined): Promise<void>;
  getContainer(agentId: string): Promise<ContainerRow | null>;
  /**
   * agent_memory_read: purge, readScope check and lastAccessedBy in one
   * transaction. Null for a missing key or another category.
   */
  readEntry(
    agentId: string,
    key: string,
    category: string | undefined,
    caller: CallerGene,
  ): Promise<{ entry: EntryRow | null; expired: ExpiredEntry[] }>;
  /** Readable by `caller`, filtered, newest first, at most `limit` (agent_memory_query). */
  listEntries(
    agentId: string,
    filter: MemoryFilter,
    caller: CallerGene,
    limit: number,
  ): Promise<{ entries: EntryRow[]; expired: ExpiredEntry[] }>;
  /** agent_memory_write: writeScope, policy rules, quota and eviction, atomically. */
  write(p: WriteParams): Promise<{ entry: EntryRow; evicted: EvictedEntry[]; expired: ExpiredEntry[] }>;
  /** agent_memory_delete: checks writeScope and deletes in one transaction. */
  deleteEntry(
    agentId: string,
    key: string,
    caller: CallerGene,
  ): Promise<{ entryId: string; key: string; expired: ExpiredEntry[] }>;
}

export class DbError extends Error {
  constructor(readonly sqlstate: string | undefined, message: string) {
    super(message);
    this.name = "DbError";
  }
}

export async function dispatch(req: MemoryRequest, store: MemoryStore): Promise<unknown> {
  // Checked before anything is read or recorded. The
  // database RPCs check it again.
  if (req.op !== "register" && !V2_GENE_ID_RE.test(req.caller.geneId)) {
    throw new MemoryError("MEMORY_ACCESS_DENIED", "the caller is not a v2 gene id (v2:<64 lowercase hex>)");
  }
  switch (req.op) {
    case "register": {
      await store.registerContainer(req.agentId, req.quota);
      const c = await store.getContainer(req.agentId);
      if (!c) throw new MemoryError("MEMORY_NOT_FOUND", `agent ${req.agentId} could not be registered`);
      return {
        memory: {
          agentId: c.agent_id,
          quota: Number(c.quota_bytes),
          totalSize: Number(c.total_size),
          createdAt: toRfc3339(c.created_at),
        },
      };
    }

    case "write": {
      // The default DataPolicy has no anonymization support and
      // this version cannot change it, so only PRIVATE may be written. The
      // database refuses it too; this says why before any query.
      if (req.accessPolicy && req.accessPolicy.sharePolicy !== "PRIVATE") {
        throw new MemoryError(
          "MEMORY_ACCESS_DENIED",
          `sharePolicy ${req.accessPolicy.sharePolicy} needs a DataPolicy with anonymization support, which this version does not have; use PRIVATE`,
        );
      }
      // Nothing can configure DEPLOYER_CONFIGURED yet, so
      // it cannot be set.
      if (
        req.accessPolicy &&
        (req.accessPolicy.readScope === "DEPLOYER_CONFIGURED" || req.accessPolicy.writeScope === "DEPLOYER_CONFIGURED")
      ) {
        throw new MemoryError(
          "MEMORY_ACCESS_DENIED",
          "DEPLOYER_CONFIGURED cannot be set: this version has no DataPolicy field to configure it (§30.2)",
        );
      }
      // writeScope and the creator-only policy rule are checked by
      // agent_memory_write under its row lock, in the same
      // transaction as the purge, so a refusal leaves nothing purged.
      const { entry, evicted, expired } = await store.write({
        agentId: req.agentId,
        key: req.key,
        value: bytesToBytea(req.value),
        category: req.category,
        callerGeneId: req.caller.geneId,
        callerDomain: req.caller.domain,
        readScope: req.accessPolicy?.readScope ?? null,
        writeScope: req.accessPolicy?.writeScope ?? null,
        sharePolicy: req.accessPolicy?.sharePolicy ?? null,
        retentionPolicy: req.retentionPolicy ?? null,
        setRetention: req.retentionPolicy !== undefined,
      });
      return { entry: rowToEntry(entry), evicted, expired };
    }

    case "read": {
      const { entry, expired } = await store.readEntry(req.agentId, req.key, req.category, req.caller);
      return { entry: entry ? rowToEntry(entry) : null, expired };
    }

    case "query": {
      // The database filters by scope and prefix before LIMIT, so the limit
      // counts only readable entries. The same checks run again here as a
      // second line; they drop nothing the database returned correctly.
      const limit = req.filter.limit ?? DEFAULT_QUERY_LIMIT;
      const { entries: rows, expired } = await store.listEntries(req.agentId, req.filter, req.caller, limit);
      const prefix = req.filter.keyPrefix;
      const readable = rows.filter((r) =>
        (prefix === undefined || r.key.startsWith(prefix)) && canRead(r, req.caller)
      );
      return { entries: readable.slice(0, limit).map(rowToEntry), expired };
    }

    case "delete": {
      // agent_memory_delete purges, checks writeScope and deletes in one
      // transaction; a missing key is MEMORY_NOT_FOUND.
      const { entryId, key, expired } = await store.deleteEntry(req.agentId, req.key, req.caller);
      return { deleted: { entryId, key }, expired };
    }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The serialized body of a successful response, refused with
 * MEMORY_INVALID_INPUT when it is over 4 MiB — a query
 * is never cut short silently; the caller narrows the filter or the limit.
 */
export function boundedBody(body: unknown): string {
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_RESPONSE_BYTES) {
    throw new MemoryError(
      "MEMORY_INVALID_INPUT",
      `the response would be ${bytes} bytes; the limit is ${MAX_RESPONSE_BYTES} (4 MiB) — narrow the filter or lower limit`,
    );
  }
  return text;
}

/** Every error response carries "expired" ([] when nothing was purged). */
export function errorResponse(e: MemoryError): Response {
  return json(HTTP_STATUS[e.code], { error: { code: e.code, message: e.message }, expired: e.expired });
}

/** The role claim of a JWT the gateway has already verified (index.ts). */
export function jwtRole(authorization: string | null): string | null {
  const m = /^Bearer\s+([^.]+)\.([^.]+)\.[^.]+$/.exec(authorization ?? "");
  if (!m) return null;
  try {
    const b64 = m[2].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "=")));
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

/** The operation is the last path segment: /functions/v1/agent-memory/write → "write". */
export function opFromUrl(url: string): string {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const i = parts.lastIndexOf("agent-memory");
  return i >= 0 && i + 1 < parts.length ? parts[i + 1] : "";
}

export async function handle(request: Request, store: MemoryStore): Promise<Response> {
  if (request.method !== "POST") {
    return json(405, { error: { code: "MEMORY_INVALID_INPUT", message: "use POST" } });
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new MemoryError("MEMORY_INVALID_INPUT", "the request body must be JSON");
    }
    const req = parseRequest(opFromUrl(request.url), body);
    const text = boundedBody(await dispatch(req, store));
    return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    if (e instanceof MemoryError) return errorResponse(e);
    if (e instanceof DbError) {
      const mapped = mapDbError(e.sqlstate, e.message);
      if (mapped) return errorResponse(mapped);
    }
    // MEMORY_STORAGE_ERROR with a fixed message; the details go
    // to the function log only.
    console.error("agent-memory: storage error", e);
    return errorResponse(new MemoryError("MEMORY_STORAGE_ERROR", "the memory store failed; try again later"));
  }
}
