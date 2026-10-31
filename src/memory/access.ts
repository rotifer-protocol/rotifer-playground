/**
 * GeneMemoryAccess — spec §38.2, the interface a gene reads and writes its
 * agent's memory through (–S4, S6).
 *
 * A gene gets one bound to its agent and to itself: every call carries the
 * gene's identity, so the store can check the entry's scope.
 * The methods return the result and throw MemoryError carrying a memory
 * code (MEMORY_NOT_FOUND / MEMORY_ACCESS_DENIED / MEMORY_QUOTA_EXCEEDED /
 * MEMORY_INVALID_INPUT); an absent entry on read is `null`, not an error, as
 * §38.2 types it (`-> MemoryEntry?`).
 *
 * Synchronous on purpose. The WASM host functions (rotifer.readMemory …,
 * the host functions) are synchronous calls from the guest, and so is the
 * rotifer-napi store; a gene written against this interface needs no
 * `async express()`, which Javy rejects (E0025) — so the same gene source can
 * move from the Node path to a Native artifact.
 */
import type { MemoryBackend, MemoryCaller } from "./backend.js";
import { checkAccessPolicy, checkKey, checkRetentionPolicy, encodeValue, entryIdFor, fromEntryJson, isV2GeneId, parseTimestamp } from "./codec.js";
import { dataPolicyViolation, type DataPolicy } from "./data-policy.js";
import { accessDeniedEvent, type MemoryTelemetrySink } from "./telemetry.js";
import type { MemoryAuditSink } from "./audit.js";
import {
  DEFAULT_ACCESS_POLICY,
  MEMORY_FILTER_FIELDS,
  MEMORY_MAX_VALUE_BYTES,
  MemoryError,
  isMemoryCategory,
  type MemoryAccessPolicy,
  type MemoryCategory,
  type MemoryEntry,
  type MemoryFilter,
  type RetentionPolicy,
} from "./types.js";

export interface GeneMemoryAccess {
  /** The entry under `key`, or null. With `category`, only an entry of that category. */
  readMemory(key: string, category?: MemoryCategory): MemoryEntry | null;
  /**
   * Write or update the entry under `key`; returns the stored entry.
   *
   * A new entry's `accessPolicy` defaults to SAME_DOMAIN read and write,
   * PRIVATE sharing, and its `retentionPolicy` to null (inherit the agent's
   * DataPolicy). An update keeps the entry's creator and its stored
   * policies; only the creating gene may change them. Another gene passing
   * a policy different from the stored one gets MEMORY_ACCESS_DENIED
   * — leave the policies out when overwriting someone else's
   * entry.
   */
  writeMemory(
    key: string,
    value: Uint8Array,
    category: MemoryCategory,
    accessPolicy?: MemoryAccessPolicy,
    retentionPolicy?: RetentionPolicy | null,
  ): MemoryEntry;
  /** The entries this gene may read that match every given filter field, newest first. */
  queryMemory(filter?: MemoryFilter): MemoryEntry[];
  /** Delete the entry under `key` (needs its write scope). */
  deleteMemory(key: string): void;
}

export interface GeneMemoryAccessOptions {
  backend: MemoryBackend;
  caller: MemoryCaller;
  dataPolicy: DataPolicy;
  /** §17 sink for the denials this layer raises (DataPolicy); the backend records its own. */
  telemetry: MemoryTelemetrySink;
  /** Audit sink for the same denials: a refusal is audited, not only reported. */
  audit: MemoryAuditSink;
}

export function createGeneMemoryAccess(options: GeneMemoryAccessOptions): GeneMemoryAccess {
  const { backend, caller, dataPolicy, telemetry, audit } = options;

  /**
   * A DataPolicy refusal: MEMORY_ACCESS_DENIED, audited and reported to §17
   * before it is thrown. The audit line comes first and is not best-effort:
   * if it cannot be written the call fails with MEMORY_STORAGE_ERROR.
   */
  function refuse(key: string, category: MemoryCategory, violation: string): never {
    const error = new MemoryError("MEMORY_ACCESS_DENIED", `the agent's DataPolicy does not allow this write: ${violation}`);
    const { totalSize, quota } = backend.usage(caller.agentId);
    audit({
      ts: new Date().toISOString(),
      kind: "agent_memory",
      action: "access_denied",
      agentId: caller.agentId,
      entryId: entryIdFor(caller.agentId, key),
      category,
      geneId: caller.geneId,
      sizeDelta: 0,
      totalSize,
      quota,
      error: "MEMORY_ACCESS_DENIED",
    });
    telemetry(
      accessDeniedEvent({
        agentId: caller.agentId,
        geneId: caller.geneId,
        entryId: entryIdFor(caller.agentId, key),
        operation: "write",
        message: error.message,
      }),
    );
    throw error;
  }

  return {
    readMemory(key, category) {
      checkKey(key);
      if (category !== undefined && !isMemoryCategory(category)) {
        throw new MemoryError("MEMORY_INVALID_INPUT", `unknown category '${String(category)}'`);
      }
      const json = backend.read(caller, key, category ?? null);
      return json ? fromEntryJson(json) : null;
    },

    writeMemory(key, value, category, accessPolicy, retentionPolicy) {
      checkKey(key);
      if (!(value instanceof Uint8Array)) {
        throw new MemoryError("MEMORY_INVALID_INPUT", "value must be bytes (Uint8Array)");
      }
      if (value.byteLength > MEMORY_MAX_VALUE_BYTES) {
        throw new MemoryError(
          "MEMORY_INVALID_INPUT",
          `value is ${value.byteLength} bytes; a memory value is at most ${MEMORY_MAX_VALUE_BYTES} bytes (1 MiB)`,
        );
      }
      if (!isMemoryCategory(category)) {
        throw new MemoryError("MEMORY_INVALID_INPUT", `unknown category '${String(category)}'`);
      }
      // Omitted stays omitted on the wire: for an update it means "keep the
      // stored policy", which the store resolves.
      const policy = accessPolicy === undefined ? undefined : checkAccessPolicy(accessPolicy);
      const retention = retentionPolicy === undefined ? undefined : checkRetentionPolicy(retentionPolicy);
      // A caller without a v2 id is refused and recorded by the store itself
      //; there is no gene to hold to a DataPolicy.
      const violation = isV2GeneId(caller.geneId) ? dataPolicyViolation(dataPolicy, policy ?? DEFAULT_ACCESS_POLICY, retention ?? null) : null;
      if (violation) refuse(key, category, violation);
      return fromEntryJson(
        backend.write(caller, {
          key,
          value: encodeValue(value),
          category,
          ...(policy === undefined ? {} : { accessPolicy: policy }),
          ...(retention === undefined ? {} : { retentionPolicy: retention }),
        }),
      );
    },

    queryMemory(filter = {}) {
      checkFilter(filter);
      return backend.query(caller, filter).map(fromEntryJson);
    },

    deleteMemory(key) {
      checkKey(key);
      backend.delete(caller, key);
    },
  };
}

/** The five fields, nothing else, each well-formed. */
function checkFilter(filter: unknown): void {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "filter must be an object");
  }
  const f = filter as Record<string, unknown>;
  const unknown = Object.keys(f).filter((k) => !(MEMORY_FILTER_FIELDS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new MemoryError(
      "MEMORY_INVALID_INPUT",
      `unknown filter field(s) ${unknown.join(", ")}; a MemoryFilter has ${MEMORY_FILTER_FIELDS.join(", ")}`,
    );
  }
  if (f.category !== undefined && !isMemoryCategory(f.category)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", `unknown category '${String(f.category)}'`);
  }
  if (f.keyPrefix !== undefined && typeof f.keyPrefix !== "string") {
    throw new MemoryError("MEMORY_INVALID_INPUT", "keyPrefix must be a string");
  }
  if (f.since !== undefined) parseTimestamp(f.since, "since");
  if (f.until !== undefined) parseTimestamp(f.until, "until");
  if (f.limit !== undefined && !(Number.isInteger(f.limit) && (f.limit as number) > 0)) {
    throw new MemoryError("MEMORY_INVALID_INPUT", "limit must be a positive whole number (default 100, at most 1000 are returned)");
  }
}
