/**
 * How a gene gets its memory: through an agent, or — with no
 * agent around it — a ctx.memory that refuses every call with
 * MEMORY_ACCESS_DENIED "no agent context", never `undefined`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { geneIdV2 } from "../../src/utils/binding.js";
import {
  MemoryError,
  memoryUnavailable,
  noAgentMemory,
  parseMemoryQuota,
  type GeneMemoryAccess,
  type MemoryTelemetryEvent,
  type NativeMemoryApi,
} from "../../src/memory/index.js";
import { openAgentMemory, scratchGeneMemory } from "../../src/memory/host.js";
import { DEFAULT_DATA_POLICY } from "../../src/memory/data-policy.js";

const expectCode = (call: () => unknown, code: string, text: string) => {
  let caught: unknown;
  try {
    call();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MemoryError);
  expect((caught as MemoryError).code).toBe(code);
  expect((caught as MemoryError).message).toContain(text);
};
const expectDenied = (call: () => unknown, text: string) => expectCode(call, "MEMORY_ACCESS_DENIED", text);
const allFour = (memory: GeneMemoryAccess) => [
  () => memory.readMemory("k"),
  () => memory.writeMemory("k", new Uint8Array([1]), "CACHE"),
  () => memory.queryMemory(),
  () => memory.deleteMemory("k"),
];

/** A native store that has the agent and records what it is asked. */
function recordingNative() {
  const calls: unknown[][] = [];
  const entryCall = (method: string) => (agentId: string, geneId: string, domain: string, json: string) => {
    calls.push([method, agentId, geneId, domain, JSON.parse(json)]);
    return method === "memoryQuery" ? [] : null;
  };
  const native: NativeMemoryApi = {
    memoryGet: () => ({ totalSize: 0, quota: 1 }),
    memoryCreate: () => null,
    memorySetDataPolicyRetention: () => null,
    memoryRead: entryCall("memoryRead"),
    memoryWrite: entryCall("memoryWrite"),
    memoryQuery: entryCall("memoryQuery"),
    memoryDelete: entryCall("memoryDelete"),
  };
  return { native, calls };
}

describe("noAgentMemory", () => {
  it("every one of the four calls is MEMORY_ACCESS_DENIED, its message starting with 'no agent context'", () => {
    for (const call of allFour(noAgentMemory())) {
      expectDenied(call, "no agent context");
      try {
        call();
      } catch (err) {
        expect((err as Error).message.startsWith("no agent context")).toBe(true);
      }
    }
  });
});

describe("noAgentMemory with a telemetry sink (telemetry only, no agent to audit under)", () => {
  it("each refused call is one MEMORY_ACCESS_DENIED event: the gene, agentId null, no entry, the operation", () => {
    const events: MemoryTelemetryEvent[] = [];
    const gene = "v2:" + "a".repeat(64);
    const memory = noAgentMemory({ telemetry: (e) => events.push(e), geneId: gene });
    for (const call of allFour(memory)) expectDenied(call, "no agent context");
    expect(events.map((e) => [e.eventType, e.geneId, e.metadata])).toEqual(
      (["read", "write", "query", "delete"] as const).map((operation) => [
        "MEMORY_ACCESS_DENIED",
        gene,
        { agentId: null, entryId: null, operation },
      ]),
    );
    expect(events.every((e) => e.result.FAILURE.message.startsWith("no agent context"))).toBe(true);
  });

  it("a gene without a v2 id is reported with geneId null; without a sink nothing is reported", () => {
    const events: MemoryTelemetryEvent[] = [];
    expectDenied(() => noAgentMemory({ telemetry: (e) => events.push(e) }).readMemory("k"), "no agent context");
    expect(events.map((e) => e.geneId)).toEqual([null]);
    expectDenied(() => noAgentMemory().readMemory("k"), "no agent context");
    expect(events).toHaveLength(1);
  });
});

describe("openAgentMemory", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-agent-memory-"));
    mkdirSync(join(root, "genes", "g"), { recursive: true });
    writeFileSync(join(root, "genes", "g", "index.ts"), "export function express() { return {}; }\n");
    writeFileSync(
      join(root, "genes", "g", "phenotype.json"),
      JSON.stringify({ domain: "d", inputSchema: { type: "object" }, outputSchema: { type: "object" }, version: "0.1.0", fidelity: "Wrapped" }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates the agent's memory in the native store on first use, with the agent's quota", () => {
    const calls: unknown[][] = [];
    const native = {
      memoryGet: (agentId: string) => {
        calls.push(["memoryGet", agentId]);
        throw new Error(`MEMORY_NOT_FOUND: agent ${agentId} has no memory`);
      },
      memoryCreate: (agentId: string, quota?: number) => calls.push(["memoryCreate", agentId, quota]),
      memoryRead: () => null,
      memoryWrite: () => null,
      memoryQuery: () => [],
      memoryDelete: () => null,
    };
    const handle = openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "agent-1", memoryQuota: 2048 }, native });
    expect(handle.store).toBe("napi");
    expect(calls).toEqual([["memoryGet", "agent-1"], ["memoryCreate", "agent-1", 2048]]);
  });

  it("creates it with the agent's DataPolicy retention when there is one, and only then", () => {
    const calls: unknown[][] = [];
    const missing = {
      memoryGet: () => {
        throw new Error("MEMORY_NOT_FOUND: none");
      },
      memoryCreate: (agentId: string, quota?: number) => calls.push(["memoryCreate", agentId, quota]),
      memorySetDataPolicyRetention: (agentId: string, days: number | null) => calls.push(["memorySetDataPolicyRetention", agentId, days]),
      memoryRead: () => null,
      memoryWrite: () => null,
      memoryQuery: () => [],
      memoryDelete: () => null,
    };
    const retention = (days: number | null) => ({
      ...DEFAULT_DATA_POLICY,
      retentionPolicy: { ...DEFAULT_DATA_POLICY.retentionPolicy, maxRetentionDays: days },
    });
    openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "a", memoryQuota: 4096, dataPolicy: retention(30) }, native: missing });
    openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "b", dataPolicy: retention(null) }, native: missing });
    openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "c" }, native: missing });
    expect(calls).toEqual([
      ["memoryCreate", "a", 4096],
      ["memorySetDataPolicyRetention", "a", 30],
      ["memoryCreate", "b", 10 * 1024 * 1024],
      ["memoryCreate", "c", 10 * 1024 * 1024],
    ]);
  });

  it("does not create it again when it exists, and does not swallow other errors", () => {
    let created = 0;
    const base = { memoryRead: () => null, memoryWrite: () => null, memoryQuery: () => [], memoryDelete: () => null, memoryCreate: () => created++ };
    openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "a" }, native: { ...base, memoryGet: () => ({}) } });
    expect(created).toBe(0);
    expect(() =>
      openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "a" }, native: { ...base, memoryGet: () => { throw new Error("failed to init agent memory: disk full"); } } }),
    ).toThrow("disk full");
  });

  it("a gene it cannot identify reaches the store with no v2 id, which refuses and records it; the refusal says why", () => {
    const calls: unknown[][] = [];
    // rotifer-napi refuses (and audits) a caller without a v2 id.
    const refusing = (method: string) => (agentId: string, geneId: string) => {
      calls.push([method, agentId, geneId]);
      throw new Error("MEMORY_ACCESS_DENIED: the calling gene has no v2 id");
    };
    const native: NativeMemoryApi = {
      memoryGet: () => ({ totalSize: 0, quota: 1 }),
      memoryCreate: () => null,
      memoryRead: refusing("memoryRead"),
      memoryWrite: refusing("memoryWrite"),
      memoryQuery: refusing("memoryQuery"),
      memoryDelete: refusing("memoryDelete"),
    };
    const handle = openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "a" }, native, audit: () => {}, telemetry: () => {} });
    const memory = handle.forGene("missing-gene", { domain: "d" });
    expect(memory).toBeDefined();
    for (const call of allFour(memory)) expectDenied(call, "gene 'missing-gene' cannot use agent memory");
    expect(calls).toEqual([
      ["memoryRead", "a", ""],
      ["memoryWrite", "a", ""],
      ["memoryQuery", "a", ""],
      ["memoryDelete", "a", ""],
    ]);
  });

  it("a gene it can identify reaches the store as its v2 id and its phenotype's domain", () => {
    const { native, calls } = recordingNative();
    const handle = openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "a" }, native, audit: () => {}, telemetry: () => {} });
    handle.forGene("g", { domain: "d" }).readMemory("k");
    const v2 = geneIdV2(join(root, "genes"), "g");
    expect("id" in v2).toBe(true);
    expect(calls).toEqual([["memoryRead", "a", (v2 as { id: string }).id, "d", { key: "k" }]]);
  });

  it("the WASM path gets the project binding and the memoryContext napi takes; a gene without a v2 id gets no geneId", () => {
    const { native } = recordingNative();
    const executing = { ...native, executeGene: () => null, executeAlgebra: () => null };
    const handle = openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "agent-7" }, native: executing });
    expect(handle.wasm?.binding).toBe(executing);
    const v2 = geneIdV2(join(root, "genes"), "g") as { id: string };
    expect(JSON.parse(handle.wasm!.geneContext("g"))).toEqual({ agentId: "agent-7", geneId: v2.id });
    expect(JSON.parse(handle.wasm!.geneContext("missing-gene"))).toEqual({ agentId: "agent-7" });
    expect(JSON.parse(handle.wasm!.agentContext)).toEqual({ agentId: "agent-7" });
    // A store that cannot execute genes, or no store: no WASM memory.
    expect(openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "a" }, native }).wasm).toBeNull();
    expect(openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "a" }, native: null }).wasm).toBeNull();
  });

  it("without native memory there is no store: every call of every gene is MEMORY_STORAGE_ERROR 'native binding unavailable'", () => {
    const handle = openAgentMemory({ root, genesRoot: join(root, "genes"), agent: { id: "a" }, native: null });
    expect(handle.store).toBe("unavailable");
    for (const memory of [handle.forGene("g", { domain: "d" }), handle.forCaller("v2:" + "a".repeat(64), "d"), memoryUnavailable()]) {
      for (const call of allFour(memory)) expectCode(call, "MEMORY_STORAGE_ERROR", "native binding unavailable");
    }
    // Nothing was written in its place.
    expect(existsSync(join(root, ".rotifer", "memory"))).toBe(false);
  });
});

describe("scratchGeneMemory (rotifer test)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-scratch-genes-"));
    mkdirSync(join(root, "g"), { recursive: true });
    writeFileSync(join(root, "g", "index.ts"), "export function express() { return {}; }\n");
    writeFileSync(
      join(root, "g", "phenotype.json"),
      JSON.stringify({ domain: "d", inputSchema: { type: "object" }, outputSchema: { type: "object" }, version: "0.1.0", fidelity: "Wrapped" }),
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("without native memory: every call is MEMORY_STORAGE_ERROR 'native binding unavailable', and no temp dir is left", () => {
    let dir = "";
    const scratch = scratchGeneMemory({
      genesRoot: root,
      geneName: "g",
      phenotype: { domain: "d" },
      openNative: (d) => {
        dir = d;
        return null;
      },
    });
    expect(dir).toContain(tmpdir());
    expect(existsSync(dir)).toBe(false);
    expect(scratch.wasm).toBeNull();
    for (const call of allFour(scratch.memory)) expectCode(call, "MEMORY_STORAGE_ERROR", "native binding unavailable");
    scratch.dispose();
  });

  it("with native memory: a one-off agent in a temp dir, created with the default quota, removed by dispose()", () => {
    let dir = "";
    const created: unknown[][] = [];
    const { native, calls } = recordingNative();
    const scratch = scratchGeneMemory({
      genesRoot: root,
      geneName: "g",
      phenotype: { domain: "d" },
      openNative: (d) => {
        dir = d;
        return {
          ...native,
          memoryGet: () => {
            throw new Error("MEMORY_NOT_FOUND: none");
          },
          memoryCreate: (agentId: string, quota?: number) => created.push([agentId, quota]),
        };
      },
    });
    expect(existsSync(dir)).toBe(true);
    expect(created).toEqual([[expect.stringMatching(/^test-/), 10 * 1024 * 1024]]);
    scratch.memory.readMemory("k");
    expect(calls).toEqual([["memoryRead", created[0][0], expect.stringMatching(/^v2:/), "d", { key: "k" }]]);
    scratch.dispose();
    expect(existsSync(dir)).toBe(false);
  });
});

describe("parseMemoryQuota at the edges", () => {
  it.each(["99999999999GB", "9007199254740993KB"])("refuses %s as too large rather than rounding it", (size) => {
    expect(() => parseMemoryQuota(size)).toThrow(/too large/);
  });
});
