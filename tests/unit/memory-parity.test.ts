/**
 * The test double and the real store answer the same way.
 *
 * One scenario runs through the SDK twice — on JsonFileMemoryBackend and on
 * rotifer-napi's store — and every step's outcome (the entry, null, or the
 * error code), the audit lines and the §17 events must match. The other unit
 * tests run on the double; this is what entitles them to speak for napi.
 * Timestamps differ between runs and are not compared; their order is.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_DATA_POLICY,
  NapiMemoryBackend,
  createGeneMemoryAccess,
  fileAuditSink,
  fileTelemetrySink,
  type MemoryAccessPolicy,
  type MemoryBackend,
  type MemoryEntry,
} from "../../src/memory/index.js";
import { JsonFileMemoryBackend } from "../../src/memory/backend.js";
import { describeWithNativeMemory, openNativeMemory } from "../fixtures/memory/native-memory.js";

const AGENT = "agent-parity";
const QUOTA = 300;
const A = "v2:" + "a".repeat(64);
const B = "v2:" + "b".repeat(64);
const C = "v2:" + "c".repeat(64);
const enc = (s: string) => new TextEncoder().encode(s);
const ALL: MemoryAccessPolicy = { readScope: "ALL_GENES", writeScope: "ALL_GENES", sharePolicy: "PRIVATE" };
const ONLY: MemoryAccessPolicy = { readScope: "CREATOR_GENE_ONLY", writeScope: "CREATOR_GENE_ONLY", sharePolicy: "PRIVATE" };
const week = { maxRetentionDays: 7, autoDeleteOnTermination: true, anonymizationSupported: false };

/** Wait for the millisecond clock to move, so updatedAt orders the steps on both stores. */
function nextMillisecond(): void {
  const t = Date.now();
  while (Date.now() <= t + 1) {
    /* spin */
  }
}

type Step = [name: string, outcome: "ok" | "error", detail: unknown];

function normalize(result: unknown): unknown {
  if (result === undefined || result === null) return null;
  const one = (e: MemoryEntry) => ({
    entryId: e.entryId,
    key: e.key,
    category: e.category,
    value: new TextDecoder().decode(e.value),
    createdBy: e.createdBy,
    lastAccessedBy: e.lastAccessedBy,
    accessPolicy: e.accessPolicy,
    retentionPolicy: e.retentionPolicy,
    updatedAfterCreated: e.updatedAt > e.createdAt,
  });
  return Array.isArray(result) ? result.map(one) : one(result as MemoryEntry);
}

function runScenario(root: string, backend: MemoryBackend) {
  const gene = (geneId: string, domain: string) =>
    createGeneMemoryAccess({
      backend,
      caller: { agentId: AGENT, geneId, domain },
      dataPolicy: { ...DEFAULT_DATA_POLICY, retentionPolicy: { ...DEFAULT_DATA_POLICY.retentionPolicy, maxRetentionDays: 30 } },
      telemetry: fileTelemetrySink(root, {}),
      audit: fileAuditSink(root),
    });
  const steps: Step[] = [];
  const step = (name: string, call: () => unknown) => {
    try {
      steps.push([name, "ok", normalize(call())]);
    } catch (err) {
      const code = (err as { code?: string }).code;
      steps.push([name, "error", code ?? `not a MemoryError: ${(err as Error).message}`]);
    }
    nextMillisecond();
  };
  const usage = () => backend.usage(AGENT);

  step("write", () => gene(A, "search").writeMemory("lang", enc("zh"), "PREFERENCE"));
  step("read, same domain", () => gene(B, "search").readMemory("lang"));
  step("read, other domain", () => gene(C, "finance").readMemory("lang"));
  step("read, other category", () => gene(A, "search").readMemory("lang", "CACHE"));
  step("read, missing key", () => gene(A, "search").readMemory("nope"));
  step("creator-only write", () => gene(A, "search").writeMemory("mine", enc("1"), "CONTEXT", ONLY));
  step("creator-only, read by another gene", () => gene(B, "search").readMemory("mine"));
  step("creator-only, delete by another gene", () => gene(B, "search").deleteMemory("mine"));
  step("DEPLOYER_CONFIGURED write", () =>
    gene(A, "search").writeMemory("dep", enc("1"), "CONTEXT", { readScope: "DEPLOYER_CONFIGURED", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" }),
  );
  step("shared write with a retention", () => gene(A, "search").writeMemory("open", enc("x"), "CACHE", ALL, week));
  step("another gene changes accessPolicy", () => gene(C, "finance").writeMemory("open", enc("y"), "CACHE", { ...ALL, readScope: "CREATOR_GENE_ONLY" }));
  step("another gene overwrites, no policies", () => gene(C, "finance").writeMemory("open", enc("z"), "CACHE"));
  step("another gene overwrites, same policies", () => gene(C, "finance").writeMemory("open", enc("z2"), "CACHE", ALL, week));
  step("another gene resets retention to null", () => gene(C, "finance").writeMemory("open", enc("z3"), "CACHE", undefined, null));
  step("another gene changes retention", () => gene(C, "finance").writeMemory("open", enc("z4"), "CACHE", undefined, { ...week, maxRetentionDays: 3 }));
  step("creator updates, policies kept", () => gene(A, "search").writeMemory("open", enc("z5"), "CACHE"));
  step("usage counts the retention bytes", usage);
  step("creator resets retention to null", () => gene(A, "search").writeMemory("open", enc("z6"), "CACHE", undefined, null));
  step("usage after the reset", usage);
  step("DataPolicy: retention longer than the agent's", () => gene(A, "search").writeMemory("long", enc("1"), "CACHE", undefined, { ...week, maxRetentionDays: 90 }));
  step("DataPolicy: shared without anonymisation", () => gene(A, "search").writeMemory("share", enc("1"), "PATTERN", { ...ALL, sharePolicy: "KNOWLEDGE_GENE" }));
  step("query everything readable", () => gene(A, "search").queryMemory());
  step("query by category", () => gene(A, "search").queryMemory({ category: "PREFERENCE" }));
  step("query by prefix", () => gene(A, "search").queryMemory({ keyPrefix: "o" }));
  step("query, limit 1", () => gene(A, "search").queryMemory({ limit: 1 }));
  step("query from another domain", () => gene(C, "finance").queryMemory());
  step("query with an unknown field", () => gene(A, "search").queryMemory({ sortBy: "key" } as never));
  step("delete a missing key", () => gene(A, "search").deleteMemory("nope"));
  step("delete", () => gene(A, "search").deleteMemory("open"));
  step("usage after delete", usage);
  for (const [key, category] of [["p", "PREFERENCE"], ["x", "CONTEXT"], ["t", "PATTERN"], ["c", "CACHE"], ["d", "CACHE"]] as const) {
    step(`fill ${key}`, () => gene(A, "search").writeMemory(key, enc("8".repeat(40)), category));
  }
  step("usage when nearly full", usage);
  step("a write that evicts", () => gene(A, "search").writeMemory("n", enc("x".repeat(150)), "CONTEXT"));
  step("what is left", () => gene(A, "search").queryMemory().sort((a, b) => (a.key < b.key ? -1 : 1)));
  step("a write that cannot fit", () => gene(A, "search").writeMemory("huge", enc("x".repeat(500)), "CACHE"));
  step("still what is left", () => gene(A, "search").queryMemory().sort((a, b) => (a.key < b.key ? -1 : 1)));
  step("a value over 1 MiB", () => gene(A, "search").writeMemory("big", new Uint8Array(1024 * 1024 + 1), "CACHE"));
  // DEPLOYER_CONFIGURED refused at the store (the SDK's DataPolicy check sits in front of it otherwise).
  step("the store refuses a DEPLOYER_CONFIGURED readScope", () =>
    backend.write({ agentId: AGENT, geneId: A, domain: "search" }, {
      key: "dep",
      value: Buffer.from("v").toString("base64"),
      category: "CONTEXT",
      accessPolicy: { readScope: "DEPLOYER_CONFIGURED", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" },
    }),
  );
  // A caller without a v2 id — refused, audited with geneId null.
  step("an unidentified gene reads", () => gene("not-v2", "search").readMemory("lang"));
  step("an unidentified gene writes", () => gene("not-v2", "search").writeMemory("anon", enc("x"), "CACHE"));
  step("an unidentified gene queries", () => gene("not-v2", "search").queryMemory());
  step("an unidentified gene deletes", () => gene("not-v2", "search").deleteMemory("lang"));
  // A read records its reader, a query records nobody.
  step("read by B", () => gene(B, "search").readMemory("lang"));
  step("query by A leaves lastAccessedBy at B", () => gene(A, "search").queryMemory({ category: "PREFERENCE" }));

  const lines = (file: string) =>
    existsSync(join(root, ".rotifer", file))
      ? readFileSync(join(root, ".rotifer", file), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
      : [];
  const audit = lines("audit.jsonl")
    .filter((l) => l.kind === "agent_memory")
    .map((l) => [l.action, l.agentId, l.entryId, l.category, l.geneId, l.sizeDelta, l.totalSize, l.quota, l.error]);
  const telemetry = lines("telemetry.jsonl").map((e) => [
    e.eventType,
    e.bindingExtension,
    e.geneId,
    e.metadata.agentId,
    e.metadata.entryId,
    e.metadata.operation,
    e.result.FAILURE.errorCode,
  ]);
  return { steps, audit, telemetry };
}

describeWithNativeMemory("the JSON test double and rotifer-napi give the same answers", () => {
  const roots: string[] = [];
  const newRoot = (kind: string) => {
    const root = mkdtempSync(join(tmpdir(), `rotifer-memory-parity-${kind}-`));
    roots.push(root);
    return root;
  };
  // rotifer-core reads the telemetry opt-out from the process environment;
  // both stores must see telemetry on for their §17 events to be compared.
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const name of ["ROTIFER_TELEMETRY", "DO_NOT_TRACK"]) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("step by step, in the audit log and in the §17 events", () => {
    const jsonRoot = newRoot("json");
    const json = runScenario(
      jsonRoot,
      new JsonFileMemoryBackend(jsonRoot, () => ({ quota: QUOTA }), fileTelemetrySink(jsonRoot, {}), fileAuditSink(jsonRoot)),
    );

    const napiRoot = newRoot("napi");
    const native = openNativeMemory(napiRoot)!;
    native.memoryCreate(AGENT, QUOTA);
    const napi = runScenario(napiRoot, new NapiMemoryBackend(native));

    // The scenario has to exercise what it claims to, on both.
    const codes = json.steps.filter((s) => s[1] === "error").map((s) => s[2]);
    for (const code of ["MEMORY_ACCESS_DENIED", "MEMORY_NOT_FOUND", "MEMORY_QUOTA_EXCEEDED", "MEMORY_INVALID_INPUT"]) {
      expect(codes, code).toContain(code);
    }
    expect(json.audit.map((l) => l[0])).toEqual(expect.arrayContaining(["memory_created", "write", "update", "delete", "evict", "quota_rejected", "access_denied"]));

    for (let i = 0; i < Math.max(json.steps.length, napi.steps.length); i++) {
      expect(napi.steps[i], `step ${i}: ${json.steps[i]?.[0]}`).toEqual(json.steps[i]);
    }
    expect(napi.audit).toEqual(json.audit);
    expect(napi.telemetry).toEqual(json.telemetry);
  });
});
