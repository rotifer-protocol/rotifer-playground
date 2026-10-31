/**
 * NapiMemoryBackend: the SDK over rotifer-napi's memoryRead / memoryWrite /
 * memoryQuery / memoryDelete. Against a stand-in with
 * the binding's calling convention — (agentId, callerGeneId, callerDomain,
 * requestJson), errors thrown as "MEMORY_X: message" — so the request shapes
 * and the error mapping are pinned here; tests/unit/memory-parity.test.ts
 * runs the real addon.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DATA_POLICY,
  MemoryError,
  NapiMemoryBackend,
  asMemoryError,
  createGeneMemoryAccess,
  hasNativeMemory,
  type MemoryAuditLine,
  type NativeMemoryApi,
} from "../../src/memory/index.js";

const AGENT = "agent-1";
const GENE = "v2:" + "a".repeat(64);
const ENTRY = {
  entryId: "e".repeat(64),
  category: "PREFERENCE",
  key: "lang",
  value: Buffer.from("zh").toString("base64"),
  createdBy: GENE,
  lastAccessedBy: GENE,
  createdAt: "2026-10-30T12:00:00.000Z",
  updatedAt: "2026-10-30T12:00:00.000Z",
  accessPolicy: { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" },
  retentionPolicy: null,
};

function fakeNative(answer: (method: string, request: unknown) => unknown) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const make = (method: string) => (agentId: string, geneId: string, domain: string, requestJson: string) => {
    calls.push({ method, args: [agentId, geneId, domain, JSON.parse(requestJson)] });
    return answer(method, JSON.parse(requestJson));
  };
  const native: NativeMemoryApi = {
    memoryRead: make("memoryRead"),
    memoryWrite: make("memoryWrite"),
    memoryQuery: make("memoryQuery"),
    memoryDelete: make("memoryDelete"),
    memoryGet: (agentId: string) => {
      calls.push({ method: "memoryGet", args: [agentId] });
      return { agentId, entries: [], quota: 4096, totalSize: 123 };
    },
    memorySetDataPolicyRetention: (agentId: string, days: number | null) => {
      calls.push({ method: "memorySetDataPolicyRetention", args: [agentId, days] });
      return null;
    },
    memoryCreate: (agentId: string, quota?: number) => {
      calls.push({ method: "memoryCreate", args: [agentId, quota] });
      return null;
    },
  };
  return { native, calls };
}

const access = (native: NativeMemoryApi, events: unknown[] = [], audit: MemoryAuditLine[] = []) =>
  createGeneMemoryAccess({
    backend: new NapiMemoryBackend(native),
    caller: { agentId: AGENT, geneId: GENE, domain: "search" },
    dataPolicy: DEFAULT_DATA_POLICY,
    telemetry: (e) => events.push(e),
    audit: (l) => audit.push(l),
  });

describe("NapiMemoryBackend", () => {
  it("passes the caller and the wire request JSON, and parses the entry it gets back", () => {
    const { native, calls } = fakeNative((method) => (method === "memoryQuery" ? [ENTRY] : method === "memoryDelete" ? null : ENTRY));
    const memory = access(native);

    const written = memory.writeMemory("lang", new TextEncoder().encode("zh"), "PREFERENCE");
    expect(new TextDecoder().decode(written.value)).toBe("zh");
    expect(memory.readMemory("lang", "PREFERENCE")!.key).toBe("lang");
    memory.readMemory("lang");
    expect(memory.queryMemory({ category: "PREFERENCE", limit: 5 })).toHaveLength(1);
    memory.deleteMemory("lang");

    expect(calls).toEqual([
      {
        method: "memoryWrite",
        // Omitted policies stay omitted: for an update the store keeps the stored ones.
        args: [AGENT, GENE, "search", { key: "lang", value: "emg=", category: "PREFERENCE" }],
      },
      { method: "memoryRead", args: [AGENT, GENE, "search", { key: "lang", category: "PREFERENCE" }] },
      { method: "memoryRead", args: [AGENT, GENE, "search", { key: "lang" }] },
      { method: "memoryQuery", args: [AGENT, GENE, "search", { category: "PREFERENCE", limit: 5 }] },
      { method: "memoryDelete", args: [AGENT, GENE, "search", { key: "lang" }] },
    ]);
  });

  it("a missing key reads as null", () => {
    const { native } = fakeNative(() => null);
    expect(access(native).readMemory("absent")).toBeNull();
  });

  it.each(["MEMORY_ACCESS_DENIED", "MEMORY_QUOTA_EXCEEDED", "MEMORY_NOT_FOUND", "MEMORY_INVALID_INPUT", "MEMORY_STORAGE_ERROR"])(
    "turns the binding's '%s: …' error into MemoryError with that code",
    (code) => {
      const { native } = fakeNative(() => {
        throw new Error(`${code}: what the store said`);
      });
      let caught: unknown;
      try {
        access(native).deleteMemory("k");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(MemoryError);
      expect((caught as MemoryError).code).toBe(code);
      // The code moves to .code; .message is the explanation alone.
      expect((caught as MemoryError).message).toBe("what the store said");
    },
  );

  it("does not re-record a store denial as telemetry or audit: the store already did", () => {
    const events: unknown[] = [];
    const audit: MemoryAuditLine[] = [];
    const { native } = fakeNative(() => {
      throw new Error("MEMORY_ACCESS_DENIED: read scope is CREATOR_GENE_ONLY");
    });
    expect(() => access(native, events, audit).readMemory("k")).toThrow(MemoryError);
    expect(events).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it("a DataPolicy refusal in front of the store is audited with the store's totals, and the store is not called", () => {
    const events: unknown[] = [];
    const audit: MemoryAuditLine[] = [];
    const { native, calls } = fakeNative(() => ENTRY);
    const share = { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "KNOWLEDGE_GENE" } as const;
    expect(() => access(native, events, audit).writeMemory("k", new Uint8Array([1]), "PATTERN", share)).toThrow(MemoryError);
    expect(calls.map((c) => c.method)).toEqual(["memoryGet"]);
    expect(audit).toEqual([
      expect.objectContaining({ action: "access_denied", agentId: AGENT, geneId: GENE, totalSize: 123, quota: 4096, error: "MEMORY_ACCESS_DENIED" }),
    ]);
    expect(events).toHaveLength(1);
  });

  it("any other error from the binding is MEMORY_STORAGE_ERROR, never passed through or called invalid input", () => {
    for (const thrown of [new Error("failed to init agent memory: disk full"), new Error("MEMORY_SOMETHING_ELSE: x"), "a string"]) {
      const err = asMemoryError(thrown);
      expect(err).toBeInstanceOf(MemoryError);
      expect(err.code).toBe("MEMORY_STORAGE_ERROR");
    }
    const { native } = fakeNative(() => {
      throw new Error("database is locked");
    });
    let caught: unknown;
    try {
      access(native).writeMemory("k", new Uint8Array([1]), "CACHE");
    } catch (err) {
      caught = err;
    }
    expect((caught as MemoryError).code).toBe("MEMORY_STORAGE_ERROR");
    expect((caught as MemoryError).message).toBe("database is locked");
  });

  it("recognises a binding that has the memory functions, and one that does not", () => {
    expect(hasNativeMemory(fakeNative(() => null).native)).toBe(true);
    expect(hasNativeMemory({ executeGene() {} })).toBe(false);
    // The four entry calls without memoryGet / memoryCreate are not enough: the host needs both.
    const { memoryGet: _get, memoryCreate: _create, ...partial } = fakeNative(() => null).native;
    expect(hasNativeMemory(partial)).toBe(false);
    // Nor an addon without memorySetDataPolicyRetention: without it, retention could not be enforced.
    const { memorySetDataPolicyRetention: _retention, ...beforeRetention } = fakeNative(() => null).native;
    expect(hasNativeMemory(beforeRetention)).toBe(false);
    expect(hasNativeMemory(null)).toBe(false);
  });
});
