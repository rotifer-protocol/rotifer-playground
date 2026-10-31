/**
 * Retention on the real store, against the test double.
 *
 * rotifer-napi uses the wall clock, so an entry cannot be aged in a test by
 * waiting: it is imported (§38.4 memoryImport keeps updatedAt) with an
 * updatedAt already in the past. The double is run on the same entry with
 * its injectable clock, and both must write the same audit lines.
 */
import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_DATA_POLICY,
  NapiMemoryBackend,
  createGeneMemoryAccess,
  entryIdFor,
  fileAuditSink,
  type MemoryBackend,
  type NativeMemoryApi,
  type RetentionPolicy,
} from "../../src/memory/index.js";
import { JsonFileMemoryBackend } from "../../src/memory/backend.js";
import { ensureAgentMemory } from "../../src/memory/host.js";
import { describeWithNativeMemory, openNativeMemory } from "../fixtures/memory/native-memory.js";

const DAY = 86_400_000;
const GENE = "v2:" + "a".repeat(64);
const QUOTA = 4096;
type Importer = NativeMemoryApi & { memoryImport(agentId: string, bundleJson: string, optionsJson?: string): unknown };

describeWithNativeMemory("retention on rotifer-napi matches the test double", () => {
  const roots: string[] = [];
  const newRoot = () => {
    const root = mkdtempSync(join(tmpdir(), "rotifer-retention-"));
    roots.push(root);
    return root;
  };
  beforeEach(() => {
    roots.length = 0;
  });
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** Memory lines of the audit log, without what differs by run (time, agent, the store's own creation). */
  const auditOf = (root: string) =>
    existsSync(join(root, ".rotifer", "audit.jsonl"))
      ? readFileSync(join(root, ".rotifer", "audit.jsonl"), "utf-8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
          .filter((l) => l.kind === "agent_memory" && l.action !== "memory_created")
          .map(({ ts: _ts, agentId: _agent, ...rest }) => rest)
      : [];

  const read = (backend: MemoryBackend, root: string, agentId: string, key: string) =>
    createGeneMemoryAccess({
      backend,
      caller: { agentId, geneId: GENE, domain: "search" },
      dataPolicy: DEFAULT_DATA_POLICY,
      telemetry: () => {},
      audit: fileAuditSink(root),
    }).readMemory(key);

  type Seed = { key: string; retentionPolicy: RetentionPolicy | null; ageDays: number; accessPolicy?: Record<string, string> };
  const SAME_DOMAIN = { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" };

  /** These entries, each last updated `ageDays` ago, in a fresh agent's memory on napi (imported). */
  function napiWithAll(seeds: Seed[], quota = QUOTA) {
    const root = newRoot();
    const native = openNativeMemory(root)! as Importer;
    const agentId = "agent-retention";
    const oldest = new Date(Date.now() - Math.max(...seeds.map((e) => e.ageDays)) * DAY).toISOString();
    const bundle = {
      agentId: "agent-export",
      createdAt: oldest,
      quota,
      totalSize: seeds.reduce((sum, e) => sum + e.key.length + 1, 0),
      entries: seeds.map((e) => {
        const at = new Date(Date.now() - e.ageDays * DAY).toISOString();
        return {
          entryId: entryIdFor("agent-export", e.key),
          category: "CONTEXT",
          key: e.key,
          value: Buffer.from("v").toString("base64"),
          createdBy: GENE,
          lastAccessedBy: GENE,
          createdAt: at,
          updatedAt: at,
          accessPolicy: e.accessPolicy ?? SAME_DOMAIN,
          retentionPolicy: e.retentionPolicy,
        };
      }),
    };
    native.memoryCreate(agentId, quota);
    native.memoryImport(agentId, JSON.stringify(bundle), JSON.stringify({ creatorDomains: { [GENE]: "search" } }));
    return { root, native, agentId, backend: new NapiMemoryBackend(native) as MemoryBackend };
  }

  /** The same entries in the double, each written `ageDays` ago by its clock; the clock then stands at now. */
  function doubleWithAll(seeds: Seed[], quota = QUOTA) {
    const root = newRoot();
    let clock = Date.now();
    const backend = new JsonFileMemoryBackend(root, () => ({ quota }), () => {}, fileAuditSink(root), { now: () => clock });
    for (const e of seeds) {
      clock = Date.now() - e.ageDays * DAY;
      backend.write({ agentId: "agent-retention", geneId: GENE, domain: "search" }, {
        key: e.key,
        value: Buffer.from("v").toString("base64"),
        category: "CONTEXT",
        accessPolicy: (e.accessPolicy ?? SAME_DOMAIN) as never,
        ...(e.retentionPolicy ? { retentionPolicy: e.retentionPolicy } : {}),
      });
    }
    clock = Date.now();
    return { root, backend, agentId: "agent-retention" };
  }

  const napiWith = (key: string, retentionPolicy: RetentionPolicy | null, ageDays: number) => napiWithAll([{ key, retentionPolicy, ageDays }]);
  const doubleWith = (key: string, retentionPolicy: RetentionPolicy | null, ageDays: number) => doubleWithAll([{ key, retentionPolicy, ageDays }]);

  /** GeneMemoryAccess for `geneId` (domain "search") in the agent. */
  const as = (backend: MemoryBackend, root: string, agentId: string, geneId: string) =>
    createGeneMemoryAccess({
      backend,
      caller: { agentId, geneId, domain: "search" },
      dataPolicy: DEFAULT_DATA_POLICY,
      telemetry: () => {},
      audit: fileAuditSink(root),
    });

  const oneDay: RetentionPolicy = { maxRetentionDays: 1, autoDeleteOnTermination: false, anonymizationSupported: false };

  it("an entry past its own maxRetentionDays is gone on napi: not read, not stored, one expired line — the double's line", () => {
    const napi = napiWith("old", oneDay, 2);
    expect(read(new NapiMemoryBackend(napi.native), napi.root, napi.agentId, "old")).toBeNull();
    expect((napi.native.memoryGet(napi.agentId) as { entries: unknown[]; totalSize: number })).toMatchObject({ entries: [], totalSize: 0 });

    const double = doubleWith("old", oneDay, 2);
    expect(read(double.backend, double.root, double.agentId, "old")).toBeNull();

    const napiExpired = auditOf(napi.root).filter((l) => l.action === "expired");
    expect(napiExpired).toEqual([
      { kind: "agent_memory", action: "expired", entryId: entryIdFor(napi.agentId, "old"), category: "CONTEXT", geneId: null, sizeDelta: -4, totalSize: 0, quota: QUOTA, error: null },
    ]);
    expect(auditOf(double.root).filter((l) => l.action === "expired")).toEqual(napiExpired);
  });

  it("an entry younger than its retention is still there on napi", () => {
    const napi = napiWith("young", { ...oneDay, maxRetentionDays: 3 }, 2);
    expect(read(new NapiMemoryBackend(napi.native), napi.root, napi.agentId, "young")).not.toBeNull();
    expect(auditOf(napi.root).filter((l) => l.action === "expired")).toEqual([]);
  });

  it("an entry with no policy of its own: unlimited until the agent's retention is set; then gone — retention_changed and expired as in the double", () => {
    const napi = napiWith("inherits", null, 40);
    expect(read(new NapiMemoryBackend(napi.native), napi.root, napi.agentId, "inherits")).not.toBeNull();
    napi.native.memorySetDataPolicyRetention(napi.agentId, 30);
    expect(read(new NapiMemoryBackend(napi.native), napi.root, napi.agentId, "inherits")).toBeNull();

    const double = doubleWith("inherits", null, 40);
    expect(read(double.backend, double.root, double.agentId, "inherits")).not.toBeNull();
    double.backend.setDataPolicyRetention(double.agentId, 30);
    expect(read(double.backend, double.root, double.agentId, "inherits")).toBeNull();

    const napiLines = auditOf(napi.root).filter((l) => l.action === "retention_changed" || l.action === "expired");
    expect(napiLines.map((l) => l.action)).toEqual(["retention_changed", "expired"]);
    expect(auditOf(double.root).filter((l) => l.action === "retention_changed" || l.action === "expired")).toEqual(napiLines);
  });

  it.each([
    ["a denied read", (m: ReturnType<typeof as>) => m.readMemory("mine"), "MEMORY_ACCESS_DENIED"],
    ["a denied delete", (m: ReturnType<typeof as>) => m.deleteMemory("mine"), "MEMORY_ACCESS_DENIED"],
    ["a write over quota", (_m: ReturnType<typeof as>, writer: ReturnType<typeof as>) => writer.writeMemory("huge", new Uint8Array(65), "CACHE"), "MEMORY_QUOTA_EXCEEDED"],
  ] as const)("%s keeps its purge on napi — expired line, then the refusal's — line for line as in the double", (_what, call, code) => {
    const seeds: Seed[] = [
      { key: "gone", retentionPolicy: oneDay, ageDays: 2 },
      { key: "mine", retentionPolicy: { ...oneDay, maxRetentionDays: 5 }, ageDays: 2, accessPolicy: { readScope: "CREATOR_GENE_ONLY", writeScope: "CREATOR_GENE_ONLY", sharePolicy: "PRIVATE" } },
    ];
    const OTHER = "v2:" + "b".repeat(64);
    const lines = (root: string) => auditOf(root).filter((l) => ["expired", "access_denied", "quota_rejected"].includes(l.action));
    const outcomes = [napiWithAll(seeds, 64), doubleWithAll(seeds, 64)].map((store) => {
      let caught: unknown;
      try {
        call(as(store.backend, store.root, store.agentId, OTHER), as(store.backend, store.root, store.agentId, GENE));
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string }).code).toBe(code);
      return lines(store.root);
    });
    expect(outcomes[0].map((l) => l.action)).toEqual(["expired", code === "MEMORY_QUOTA_EXCEEDED" ? "quota_rejected" : "access_denied"]);
    expect(outcomes[0][0]).toMatchObject({ entryId: entryIdFor("agent-retention", "gone") });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it("ensureAgentMemory hands the agent's DataPolicy retention to napi when it creates the memory", () => {
    const root = newRoot();
    const native = openNativeMemory(root)! as Importer;
    const agent = {
      id: "agent-with-policy",
      memoryQuota: QUOTA,
      dataPolicy: { ...DEFAULT_DATA_POLICY, retentionPolicy: { ...DEFAULT_DATA_POLICY.retentionPolicy, maxRetentionDays: 30 } },
    };
    ensureAgentMemory(native, agent);
    expect(auditOf(root).map((l) => l.action)).toEqual(["retention_changed"]);
    const at = new Date(Date.now() - 40 * DAY).toISOString();
    native.memoryImport(
      agent.id,
      JSON.stringify({
        agentId: "agent-export",
        createdAt: at,
        quota: QUOTA,
        totalSize: 2,
        entries: [
          {
            entryId: entryIdFor("agent-export", "k"),
            category: "CONTEXT",
            key: "k",
            value: Buffer.from("v").toString("base64"),
            createdBy: GENE,
            lastAccessedBy: GENE,
            createdAt: at,
            updatedAt: at,
            accessPolicy: { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" },
            retentionPolicy: null,
          },
        ],
      }),
      JSON.stringify({ creatorDomains: { [GENE]: "search" } }),
    );
    expect(read(new NapiMemoryBackend(native), root, agent.id, "k")).toBeNull();
  });
});
