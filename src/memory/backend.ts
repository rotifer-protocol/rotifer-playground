/**
 * Where AgentMemory is kept, behind one interface.
 *
 * The store is rotifer-napi (SQLite in rotifer-core, in the project's
 * `.rotifer/playground.db`). NapiMemoryBackend adapts
 * its memoryRead / memoryWrite / memoryQuery / memoryDelete. There is no
 * other production store: without the native binding, memory calls fail with
 * MEMORY_STORAGE_ERROR.
 *
 * JsonFileMemoryBackend is a test double. It implements the same rules —
 * validation, permission scopes, eviction order, size limits, audit and
 * telemetry lines in rotifer-core's shapes — so the SDK can be tested where
 * the native store is not built, and parity tests can hold the two side by
 * side. It is not exported from the package, and nothing in the CLI uses it.
 *
 * Everything that crosses this interface is the wire JSON shape
 * (MemoryEntryJson), because that is what napi and the WASM host calls pass.
 * A backend records its own denials (audit + §17); the SDK layer above
 * records the denials it raises itself (DataPolicy).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { MemoryAuditAction, MemoryAuditLine, MemoryAuditSink } from "./audit.js";
import { MAX_RETENTION_DAYS, checkAccessPolicy, checkKey, checkRetentionPolicy, decodeValue, entryIdFor, entrySize, isV2GeneId, toTimestamp } from "./codec.js";
import { accessDeniedEvent, type MemoryOperation, type MemoryTelemetrySink } from "./telemetry.js";
import {
  DEFAULT_ACCESS_POLICY,
  MEMORY_ERROR_CODES,
  MEMORY_MAX_QUERY_RESPONSE_BYTES,
  MEMORY_MAX_VALUE_BYTES,
  MEMORY_QUERY_DEFAULT_LIMIT,
  MEMORY_QUERY_MAX_LIMIT,
  MemoryError,
  isMemoryCategory,
  type AccessScope,
  type MemoryAccessPolicy,
  type MemoryCategory,
  type MemoryEntryJson,
  type MemoryErrorCode,
  type MemoryFilter,
  type RetentionPolicy,
} from "./types.js";

/** Who is asking: the agent, and the gene inside it making the call. */
export interface MemoryCaller {
  agentId: string;
  /** Content-derived gene id (createdBy / lastAccessedBy). */
  geneId: string;
  /** The calling gene's phenotype domain (SAME_DOMAIN checks). */
  domain: string;
}

export interface MemoryWriteRequest {
  key: string;
  /** Standard base64. */
  value: string;
  category: MemoryCategory;
  /** Omitted: a new entry gets the default; an update keeps the stored one. */
  accessPolicy?: MemoryAccessPolicy;
  /** Omitted: a new entry gets null (inherit); an update keeps the stored one. null resets to inherit (creator only). */
  retentionPolicy?: RetentionPolicy | null;
}

/**
 * The store. Each call checks the caller's scope first and
 * throws MemoryError with a memory error code; every state change is audited.
 */
export interface MemoryBackend {
  read(caller: MemoryCaller, key: string, category: MemoryCategory | null): MemoryEntryJson | null;
  write(caller: MemoryCaller, request: MemoryWriteRequest): MemoryEntryJson;
  query(caller: MemoryCaller, filter: MemoryFilter): MemoryEntryJson[];
  delete(caller: MemoryCaller, key: string): void;
  /** Bytes the agent's memory counts against its quota, and the quota. */
  usage(agentId: string): { totalSize: number; quota: number };
}

/** What the deployer configured for an agent's memory (agent record). */
export interface AgentMemoryConfig {
  /** Bytes. */
  quota: number;
}

// ── rotifer-napi ─────────────────────────────────────────────────

/**
 * The AgentMemory methods of rotifer-napi's PlaygroundBinding (v0.9.4).
 * Requests are the wire JSON; errors are thrown as "CODE: message".
 */
export interface NativeMemoryApi {
  memoryRead(agentId: string, callerGeneId: string, callerDomain: string, requestJson: string): unknown;
  memoryWrite(agentId: string, callerGeneId: string, callerDomain: string, requestJson: string): unknown;
  memoryQuery(agentId: string, callerGeneId: string, callerDomain: string, requestJson: string): unknown;
  memoryDelete(agentId: string, callerGeneId: string, callerDomain: string, requestJson: string): unknown;
  /** The whole AgentMemory (wire JSON): the deployer's view. */
  memoryGet(agentId: string): unknown;
  memoryCreate(agentId: string, quotaBytes?: number): unknown;
  /** The agent's DataPolicy retention in days, inherited by entries with no retentionPolicy; null: unlimited. */
  memorySetDataPolicyRetention(agentId: string, days: number | null): unknown;
}

export function hasNativeMemory(binding: unknown): binding is NativeMemoryApi {
  const b = binding as Partial<NativeMemoryApi> | null;
  return (
    !!b &&
    typeof b.memoryRead === "function" &&
    typeof b.memoryWrite === "function" &&
    typeof b.memoryQuery === "function" &&
    typeof b.memoryDelete === "function" &&
    typeof b.memoryGet === "function" &&
    typeof b.memoryCreate === "function" &&
    typeof b.memorySetDataPolicyRetention === "function"
  );
}

/** The napi store, behind MemoryBackend. Its errors become MemoryError. */
export class NapiMemoryBackend implements MemoryBackend {
  constructor(private readonly native: NativeMemoryApi) {}

  read(caller: MemoryCaller, key: string, category: MemoryCategory | null): MemoryEntryJson | null {
    const request = category === null ? { key } : { key, category };
    return this.call("memoryRead", caller, request) as MemoryEntryJson | null;
  }

  write(caller: MemoryCaller, request: MemoryWriteRequest): MemoryEntryJson {
    return this.call("memoryWrite", caller, request) as MemoryEntryJson;
  }

  query(caller: MemoryCaller, filter: MemoryFilter): MemoryEntryJson[] {
    return this.call("memoryQuery", caller, filter) as MemoryEntryJson[];
  }

  delete(caller: MemoryCaller, key: string): void {
    this.call("memoryDelete", caller, { key });
  }

  usage(agentId: string): { totalSize: number; quota: number } {
    try {
      const memory = this.native.memoryGet(agentId) as { totalSize: number; quota: number };
      return { totalSize: memory.totalSize, quota: memory.quota };
    } catch (err) {
      throw asMemoryError(err);
    }
  }

  private call(method: "memoryRead" | "memoryWrite" | "memoryQuery" | "memoryDelete", caller: MemoryCaller, request: unknown): unknown {
    try {
      return this.native[method](caller.agentId, caller.geneId, caller.domain, JSON.stringify(request));
    } catch (err) {
      throw asMemoryError(err);
    }
  }
}

/**
 * napi throws "MEMORY_X: message" → MemoryError(code, message). Anything else
 * the binding throws is a storage failure, not a pass-through.
 */
export function asMemoryError(err: unknown): MemoryError {
  if (err instanceof MemoryError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const match = /^(MEMORY_[A-Z_]+): ([\s\S]*)$/.exec(message);
  if (match && (MEMORY_ERROR_CODES as readonly string[]).includes(match[1])) {
    return new MemoryError(match[1] as MemoryErrorCode, match[2]);
  }
  return new MemoryError("MEMORY_STORAGE_ERROR", message);
}

// ── test double ──────────────────────────────────────────────────

/** An entry as stored: the wire shape plus the creator's domain (not a wire field). */
interface StoredEntry extends MemoryEntryJson {
  creatorDomain: string;
}

interface StoredMemory {
  agentId: string;
  createdAt: string;
  entries: StoredEntry[];
  /**
   * The agent's DataPolicy retention in days (§30.2), which an entry with no
   * retentionPolicy of its own inherits; null or absent:
   * unlimited. Set by setDataPolicyRetention, as napi's
   * memorySetDataPolicyRetention sets it.
   */
  retentionDays?: number | null;
}

const DEPLOYER_CONFIGURED_DENIAL =
  "DEPLOYER_CONFIGURED resolves from the agent's DataPolicy (§30.2); DataPolicy defines no memory scope yet, so it is treated as not configured and denied";

/** The order quota pressure evicts in (spec §38.1 MUST); PREFERENCE never. */
const EVICTION_ORDER: MemoryCategory[] = ["CACHE", "PATTERN", "CONTEXT"];

/** "oldest" is updatedAt ascending, then entryId ascending. */
function oldestFirst(a: MemoryEntryJson, b: MemoryEntryJson): number {
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);
}

/** Query results are updatedAt descending, ties by entryId. */
function newestFirst(a: MemoryEntryJson, b: MemoryEntryJson): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0);
}

/**
 * Complete test double: one JSON file per agent under
 * `<root>/.rotifer/memory/<agentId>.json`. Audit lines go to the given sink
 * before the file is replaced, and a failed audit or file write fails the
 * call with MEMORY_STORAGE_ERROR. Not safe for concurrent
 * writers across processes — it is not a production store.
 */
export class JsonFileMemoryBackend implements MemoryBackend {
  private readonly now: () => number;

  constructor(
    private readonly root: string,
    private readonly configFor: (agentId: string) => AgentMemoryConfig,
    private readonly telemetry: MemoryTelemetrySink,
    private readonly audit: MemoryAuditSink,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  read(caller: MemoryCaller, key: string, category: MemoryCategory | null): MemoryEntryJson | null {
    this.requireIdentity(caller, "read", key);
    checkKey(key);
    if (category !== null && !isMemoryCategory(category)) {
      throw new MemoryError("MEMORY_INVALID_INPUT", `unknown category '${String(category)}'`);
    }
    const memory = this.loadLive(caller.agentId);
    const entry = memory.entries.find((e) => e.key === key);
    if (!entry || (category !== null && entry.category !== category)) return null;
    this.requireScope(caller, memory, entry, "read", "read");
    // A read is not a state change: lastAccessedBy moves, nothing is audited.
    entry.lastAccessedBy = caller.geneId;
    this.save(memory, []);
    return publicEntry(entry);
  }

  write(caller: MemoryCaller, request: MemoryWriteRequest): MemoryEntryJson {
    this.requireIdentity(caller, "write", request.key);
    // The double checks its own input: it is used directly by tests, and a
    // store that trusted its caller would let a bad base64 or enum through.
    checkKey(request.key);
    if (!isMemoryCategory(request.category)) {
      throw new MemoryError("MEMORY_INVALID_INPUT", `unknown category '${String(request.category)}'`);
    }
    const value = decodeValue(request.value);
    if (value.byteLength > MEMORY_MAX_VALUE_BYTES) {
      throw new MemoryError(
        "MEMORY_INVALID_INPUT",
        `value is ${value.byteLength} bytes; a memory value is at most ${MEMORY_MAX_VALUE_BYTES} bytes (1 MiB)`,
      );
    }
    const accessPolicy = request.accessPolicy === undefined ? undefined : checkAccessPolicy(request.accessPolicy);
    const retentionPolicy = request.retentionPolicy === undefined ? undefined : checkRetentionPolicy(request.retentionPolicy);

    const memory = this.loadLive(caller.agentId);
    const { quota } = this.configFor(caller.agentId);
    const entryId = entryIdFor(caller.agentId, request.key);
    const existing = memory.entries.find((e) => e.key === request.key);
    if (existing) {
      this.requireScope(caller, memory, existing, "write", "write");
      // Only the creator may change an
      // entry's accessPolicy or retentionPolicy, null included. Another gene
      // with write access may overwrite the value; if it passes a policy, it
      // must be the stored one — a different one is refused, never ignored.
      if (caller.geneId !== existing.createdBy) {
        if (accessPolicy !== undefined && !samePolicy(existing.accessPolicy, accessPolicy)) {
          this.deny(caller, memory, existing, "write", "only the creating gene may change an entry's accessPolicy");
        }
        if (retentionPolicy !== undefined && !sameRetention(existing.retentionPolicy, retentionPolicy)) {
          this.deny(caller, memory, existing, "write", "only the creating gene may change an entry's retentionPolicy");
        }
      }
    }

    const nextAccess = accessPolicy ?? existing?.accessPolicy ?? { ...DEFAULT_ACCESS_POLICY };
    // A scope that resolves from DataPolicy is refused when
    // written — §30.2 defines none yet, so nothing could ever pass it.
    if (accessPolicy !== undefined && (accessPolicy.readScope === "DEPLOYER_CONFIGURED" || accessPolicy.writeScope === "DEPLOYER_CONFIGURED")) {
      this.deny(caller, memory, { entryId, category: request.category }, "write", DEPLOYER_CONFIGURED_DENIAL);
    }
    const nextRetention = retentionPolicy === undefined ? (existing?.retentionPolicy ?? null) : retentionPolicy;
    const size = entrySize(request.key, value);
    const others = memory.entries.filter((e) => e !== existing);
    const used = others.reduce((sum, e) => sum + storedSize(e), 0);

    // Plan the eviction before touching anything: a write that cannot fit
    // even after evicting everything evictable changes nothing.
    const evictions: StoredEntry[] = [];
    let free = quota - used;
    for (const category of EVICTION_ORDER) {
      if (size <= free) break;
      for (const candidate of others.filter((e) => e.category === category).sort(oldestFirst)) {
        if (size <= free) break;
        evictions.push(candidate);
        free += storedSize(candidate);
      }
    }
    if (size > free) {
      this.writeAudit([this.line(caller, memory, "quota_rejected", entryId, request.category, 0, "MEMORY_QUOTA_EXCEEDED", used)]);
      throw new MemoryError(
        "MEMORY_QUOTA_EXCEEDED",
        `writing '${request.key}' (${size} bytes) does not fit the agent's ${quota}-byte quota even after evicting CACHE, PATTERN and CONTEXT entries`,
      );
    }

    // Each evict line's totalSize is what the memory holds right after that
    // eviction (never above the quota); the write's line has the final total
    // — as rotifer-core records them.
    const lines: MemoryAuditLine[] = [];
    let held = used + (existing ? storedSize(existing) : 0);
    for (const evicted of evictions) {
      held -= storedSize(evicted);
      lines.push(this.line(caller, memory, "evict", evicted.entryId, evicted.category, -storedSize(evicted), null, held));
    }
    const totalAfter = used + size - evictions.reduce((sum, e) => sum + storedSize(e), 0);
    lines.push(
      this.line(caller, memory, existing ? "update" : "write", entryId, request.category, size - (existing ? storedSize(existing) : 0), null, totalAfter),
    );

    const at = toTimestamp(this.now());
    const next: StoredEntry = existing
      ? {
          // The update keeps createdBy, and the stored policies unless the
          // creator passed new ones.
          ...existing,
          category: request.category,
          value: request.value,
          // A write records its writer.
          lastAccessedBy: caller.geneId,
          updatedAt: at,
          accessPolicy: nextAccess,
          retentionPolicy: nextRetention,
        }
      : {
          entryId,
          category: request.category,
          key: request.key,
          value: request.value,
          createdBy: caller.geneId,
          // A new entry's lastAccessedBy is its writer.
          lastAccessedBy: caller.geneId,
          createdAt: at,
          updatedAt: at,
          accessPolicy: nextAccess,
          retentionPolicy: nextRetention,
          creatorDomain: caller.domain,
        };
    const updated: StoredMemory = {
      ...memory,
      entries: [...others.filter((e) => !evictions.includes(e)), next],
    };
    // Audit first, then commit: if the audit cannot be
    // written, nothing changes.
    this.save(updated, lines);
    return publicEntry(next);
  }

  query(caller: MemoryCaller, filter: MemoryFilter): MemoryEntryJson[] {
    this.requireIdentity(caller, "query", null);
    const memory = this.loadLive(caller.agentId);
    const since = filter.since === undefined ? -Infinity : Date.parse(filter.since);
    const until = filter.until === undefined ? Infinity : Date.parse(filter.until);
    const limit = Math.min(filter.limit ?? MEMORY_QUERY_DEFAULT_LIMIT, MEMORY_QUERY_MAX_LIMIT);
    const hits = memory.entries
      .filter((e) => {
        if (filter.category && e.category !== filter.category) return false;
        if (filter.keyPrefix !== undefined && !e.key.startsWith(filter.keyPrefix)) return false;
        const t = Date.parse(e.updatedAt);
        if (t < since || t >= until) return false;
        // A query returns what the caller may read; it does not report the rest.
        return this.mayAccess(caller, e, "read");
      })
      .sort(newestFirst)
      .slice(0, limit);
    // Refuse rather than truncate.
    if (Buffer.byteLength(JSON.stringify(hits.map(publicEntry)), "utf8") > MEMORY_MAX_QUERY_RESPONSE_BYTES) {
      throw new MemoryError("MEMORY_INVALID_INPUT", "result too large; lower limit or narrow the filter");
    }
    // A query is a scan and records no reader — it changes nothing.
    return hits.map(publicEntry);
  }

  delete(caller: MemoryCaller, key: string): void {
    this.requireIdentity(caller, "delete", key);
    checkKey(key);
    const memory = this.loadLive(caller.agentId);
    const entry = memory.entries.find((e) => e.key === key);
    if (!entry) throw new MemoryError("MEMORY_NOT_FOUND", `no memory entry '${key}'`);
    this.requireScope(caller, memory, entry, "write", "delete");
    const remaining = memory.entries.filter((e) => e !== entry);
    const total = remaining.reduce((sum, e) => sum + storedSize(e), 0);
    this.save({ ...memory, entries: remaining }, [
      this.line(caller, memory, "delete", entry.entryId, entry.category, -storedSize(entry), null, total),
    ]);
  }

  /** Like napi's memoryGet, which it stands for: expired entries are purged first. */
  usage(agentId: string): { totalSize: number; quota: number } {
    const memory = this.loadLive(agentId);
    return { totalSize: memory.entries.reduce((sum, e) => sum + storedSize(e), 0), quota: this.configFor(agentId).quota };
  }

  /**
   * napi's memorySetDataPolicyRetention: the agent's own retention, which an
   * entry with no retentionPolicy inherits; null is unlimited. An integer
   * 1..2147483647 or null, else MEMORY_INVALID_INPUT; an agent without memory
   * is MEMORY_NOT_FOUND. Audited as retention_changed.
   */
  setDataPolicyRetention(agentId: string, days: number | null): void {
    if (days !== null && !(Number.isInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS)) {
      throw new MemoryError("MEMORY_INVALID_INPUT", `maxRetentionDays ${days} is not an integer from 1 to ${MAX_RETENTION_DAYS}`);
    }
    if (!existsSync(this.pathFor(agentId))) throw new MemoryError("MEMORY_NOT_FOUND", `agent ${agentId} has no memory`);
    const memory = this.load(agentId);
    this.save({ ...memory, retentionDays: days }, [
      {
        ts: toTimestamp(this.now()),
        kind: "agent_memory",
        action: "retention_changed",
        agentId,
        entryId: null,
        category: null,
        geneId: null,
        sizeDelta: 0,
        totalSize: memory.entries.reduce((sum, e) => sum + storedSize(e), 0),
        quota: this.configFor(agentId).quota,
        error: null,
      },
    ]);
  }

  /** Bytes of key + value + retention currently stored for the agent. */
  totalSize(agentId: string): number {
    return this.usage(agentId).totalSize;
  }

  // ── permission ───────────────────────────

  private mayAccess(caller: MemoryCaller, entry: StoredEntry, mode: "read" | "write"): boolean {
    const scope: AccessScope = mode === "read" ? entry.accessPolicy.readScope : entry.accessPolicy.writeScope;
    switch (scope) {
      case "CREATOR_GENE_ONLY":
        return caller.geneId === entry.createdBy;
      case "SAME_DOMAIN":
        return caller.domain === entry.creatorDomain;
      case "ALL_GENES":
        return true;
      // §30.2 DataPolicy defines no memory scope, so this is
      // always "not configured", which denies.
      case "DEPLOYER_CONFIGURED":
      default:
        return false;
    }
  }

  private requireScope(
    caller: MemoryCaller,
    memory: StoredMemory,
    entry: StoredEntry,
    mode: "read" | "write",
    operation: MemoryOperation,
  ): void {
    if (this.mayAccess(caller, entry, mode)) return;
    const scope = mode === "read" ? entry.accessPolicy.readScope : entry.accessPolicy.writeScope;
    this.deny(
      caller,
      memory,
      entry,
      operation,
      // DEPLOYER_CONFIGURED says why; any other refusal
      // does not describe the stored entry's policy to the caller.
      scope === "DEPLOYER_CONFIGURED" ? DEPLOYER_CONFIGURED_DENIAL : `this gene may not ${mode} it`,
    );
  }

  /**
   * Every call comes from a gene with a v2 id, which is
   * what createdBy / lastAccessedBy record. Any other caller is refused —
   * audited with geneId null (and the entry, when the call named a key) and
   * reported — before anything is read or written.
   */
  private requireIdentity(caller: MemoryCaller, operation: MemoryOperation, key: string | null): void {
    if (isV2GeneId(caller.geneId)) return;
    const entryId = typeof key === "string" && key.length > 0 ? entryIdFor(caller.agentId, key) : null;
    const message = `the calling gene has no content-derived (v2) id, so it may not use agent memory`;
    const { totalSize, quota } = this.usage(caller.agentId);
    this.writeAudit([
      {
        ts: toTimestamp(this.now()),
        kind: "agent_memory",
        action: "access_denied",
        agentId: caller.agentId,
        entryId,
        category: null,
        geneId: null,
        sizeDelta: 0,
        totalSize,
        quota,
        error: "MEMORY_ACCESS_DENIED",
      },
    ]);
    this.telemetry(
      accessDeniedEvent({ agentId: caller.agentId, geneId: null, entryId, operation, message, timestamp: toTimestamp(this.now()) }),
    );
    throw new MemoryError("MEMORY_ACCESS_DENIED", message);
  }

  private deny(
    caller: MemoryCaller,
    memory: StoredMemory,
    entry: { entryId: string; category: MemoryCategory },
    operation: MemoryOperation,
    why: string,
  ): never {
    const error = new MemoryError("MEMORY_ACCESS_DENIED", `gene ${caller.geneId} may not access entry ${entry.entryId}: ${why}`);
    this.writeAudit([this.line(caller, memory, "access_denied", entry.entryId, entry.category, 0, "MEMORY_ACCESS_DENIED")]);
    this.telemetry(
      accessDeniedEvent({
        agentId: caller.agentId,
        geneId: caller.geneId,
        entryId: entry.entryId,
        operation,
        message: error.message,
        timestamp: toTimestamp(this.now()),
      }),
    );
    throw error;
  }

  // ── storage ────────────────────────────────────────────────

  private pathFor(agentId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(agentId)) {
      throw new MemoryError("MEMORY_INVALID_INPUT", `agentId '${agentId}' is not a safe file name`);
    }
    return join(this.root, ".rotifer", "memory", `${agentId}.json`);
  }

  // ── retention ────────────────────────────────

  /**
   * An entry expires once now >= updatedAt + maxRetentionDays. Only an entry
   * with no retentionPolicy inherits the agent's; its own maxRetentionDays:
   * null is unlimited.
   */
  private isExpired(entry: StoredEntry, memory: StoredMemory): boolean {
    const days = entry.retentionPolicy === null ? (memory.retentionDays ?? null) : entry.retentionPolicy.maxRetentionDays;
    // Compare elapsed seconds with days × 86400; never add days
    // to a timestamp (that overflows other bindings at the i32 upper bound).
    return days !== null && (this.now() - Date.parse(entry.updatedAt)) / 1000 >= days * 86_400;
  }

  /**
   * The agent's memory with its expired entries purged first — removed,
   * audited one "expired" line each (no key, geneId null), in entryId order —
   * before the call that asked for it, which may still be refused: as
   * rotifer-core does it at the start of each call's transaction.
   */
  private loadLive(agentId: string): StoredMemory {
    const memory = this.load(agentId);
    const expired = memory.entries
      .filter((e) => this.isExpired(e, memory))
      .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
    if (expired.length === 0) return memory;
    const remaining = memory.entries.filter((e) => !expired.includes(e));
    let held = memory.entries.reduce((sum, e) => sum + storedSize(e), 0);
    const lines = expired.map((e): MemoryAuditLine => {
      held -= storedSize(e);
      return {
        ts: toTimestamp(this.now()),
        kind: "agent_memory",
        action: "expired",
        agentId,
        entryId: e.entryId,
        category: e.category,
        geneId: null,
        sizeDelta: -storedSize(e),
        totalSize: held,
        quota: this.configFor(agentId).quota,
        error: null,
      };
    });
    const purged = { ...memory, entries: remaining };
    this.save(purged, lines);
    return purged;
  }

  private load(agentId: string): StoredMemory {
    const path = this.pathFor(agentId);
    if (!existsSync(path)) return { agentId, createdAt: toTimestamp(this.now()), entries: [] };
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as StoredMemory;
    } catch (err) {
      throw new MemoryError("MEMORY_STORAGE_ERROR", `could not read agent memory: ${(err as NodeJS.ErrnoException).code ?? "unreadable"}`);
    }
  }

  /** Audit lines first, then the file; a failure in either is MEMORY_STORAGE_ERROR. */
  private save(memory: StoredMemory, lines: MemoryAuditLine[]): void {
    const path = this.pathFor(memory.agentId);
    if (!existsSync(path)) {
      lines = [
        {
          ts: toTimestamp(this.now()),
          kind: "agent_memory",
          action: "memory_created",
          agentId: memory.agentId,
          entryId: null,
          category: null,
          geneId: null,
          sizeDelta: 0,
          totalSize: 0,
          quota: this.configFor(memory.agentId).quota,
          error: null,
        },
        ...lines,
      ];
    }
    this.writeAudit(lines);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Write-then-rename, so a crash mid-write leaves the old file whole; a
      // temp name per write, so two writers never share one.
      const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(memory, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      throw new MemoryError("MEMORY_STORAGE_ERROR", `could not save agent memory: ${(err as NodeJS.ErrnoException).code ?? "error"}`);
    }
  }

  private writeAudit(lines: MemoryAuditLine[]): void {
    for (const line of lines) this.audit(line);
  }

  private line(
    caller: MemoryCaller,
    memory: StoredMemory,
    action: MemoryAuditAction,
    entryId: string,
    category: MemoryCategory | null,
    sizeDelta: number,
    error: MemoryErrorCode | null,
    totalSize?: number,
  ): MemoryAuditLine {
    return {
      ts: toTimestamp(this.now()),
      kind: "agent_memory",
      action,
      agentId: memory.agentId,
      entryId,
      category,
      geneId: caller.geneId,
      sizeDelta,
      totalSize: totalSize ?? memory.entries.reduce((sum, e) => sum + storedSize(e), 0),
      quota: this.configFor(memory.agentId).quota,
      error,
    };
  }
}

function storedSize(entry: MemoryEntryJson): number {
  return entrySize(entry.key, Buffer.from(entry.value, "base64"));
}

function samePolicy(a: MemoryAccessPolicy, b: MemoryAccessPolicy): boolean {
  return a.readScope === b.readScope && a.writeScope === b.writeScope && a.sharePolicy === b.sharePolicy;
}

function sameRetention(a: RetentionPolicy | null, b: RetentionPolicy | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.maxRetentionDays === b.maxRetentionDays &&
    a.autoDeleteOnTermination === b.autoDeleteOnTermination &&
    a.anonymizationSupported === b.anonymizationSupported
  );
}

function publicEntry(entry: StoredEntry): MemoryEntryJson {
  const { creatorDomain: _internal, ...json } = entry;
  return { ...json };
}
