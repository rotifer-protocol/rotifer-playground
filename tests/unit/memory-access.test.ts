/**
 * AgentMemory SDK against spec §38.1–38.2.
 *
 * Runs against JsonFileMemoryBackend, the complete test double (not
 * a production store; tests/unit/memory-parity.test.ts holds it against the
 * real rotifer-napi store).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  DEFAULT_DATA_POLICY,
  MemoryError,
  createGeneMemoryAccess,
  entryIdFor,
  fileAuditSink,
  fileTelemetrySink,
  type DataPolicy,
  type GeneMemoryAccess,
  type MemoryAuditSink,
  type MemoryTelemetryEvent,
  type MemoryTelemetrySink,
} from "../../src/memory/index.js";
import { JsonFileMemoryBackend, type AgentMemoryConfig } from "../../src/memory/backend.js";

const AGENT = "3f1c2a9e-0000-4000-8000-000000000001";
const GENE_A = "v2:" + "a".repeat(64);
const GENE_B = "v2:" + "b".repeat(64);
const GENE_C = "v2:" + "c".repeat(64);
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const idOf = (key: string) => entryIdFor(AGENT, key);

describe("GeneMemoryAccess (local store)", () => {
  let root: string;
  let clock: number;
  let config: AgentMemoryConfig;
  let policy: DataPolicy;
  let events: MemoryTelemetryEvent[];
  let backend: JsonFileMemoryBackend;
  // Both layers report through these; a test swaps them to the file sinks.
  let telemetrySink: MemoryTelemetrySink;
  let auditSink: MemoryAuditSink;

  const newBackend = () =>
    new JsonFileMemoryBackend(root, () => config, (e) => telemetrySink(e), (l) => auditSink(l), { now: () => clock });
  const gene = (geneId: string, domain: string): GeneMemoryAccess =>
    createGeneMemoryAccess({
      backend,
      caller: { agentId: AGENT, geneId, domain },
      dataPolicy: policy,
      telemetry: (e) => telemetrySink(e),
      audit: (l) => auditSink(l),
    });
  const memoryFile = () => join(root, ".rotifer", "memory", `${AGENT}.json`);
  const audit = () =>
    existsSync(join(root, ".rotifer", "audit.jsonl"))
      ? readFileSync(join(root, ".rotifer", "audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
      : [];
  const thrown = (call: () => unknown): MemoryError | null => {
    try {
      call();
      return null;
    } catch (err) {
      return err as MemoryError;
    }
  };
  const fails = (call: () => unknown, code: string) => {
    const err = thrown(call);
    expect(err, `expected ${code}`).toBeInstanceOf(MemoryError);
    expect(err!.code).toBe(code);
    return err!;
  };
  const denied = (call: () => unknown) => fails(call, "MEMORY_ACCESS_DENIED");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-memory-"));
    clock = Date.parse("2026-10-30T12:00:00.000Z");
    config = { quota: 10 * 1024 * 1024 };
    policy = structuredClone(DEFAULT_DATA_POLICY) as DataPolicy;
    events = [];
    telemetrySink = (e) => events.push(e);
    auditSink = fileAuditSink(root);
    backend = newBackend();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe("write and read (§38.1 MemoryEntry)", () => {
    it("stores the entry with its derived id, creator, timestamps and default policy", () => {
      const a = gene(GENE_A, "search");
      const written = a.writeMemory("lang", bytes("zh-CN"), "PREFERENCE");
      expect(written.entryId).toBe(createHash("sha256").update(`${AGENT}\0lang`).digest("hex"));
      expect(written).toMatchObject({
        category: "PREFERENCE",
        key: "lang",
        createdBy: GENE_A,
        // A new entry's lastAccessedBy is its writer.
        lastAccessedBy: GENE_A,
        createdAt: "2026-10-30T12:00:00.000Z",
        updatedAt: "2026-10-30T12:00:00.000Z",
        accessPolicy: { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" },
        retentionPolicy: null,
      });
      expect(text(a.readMemory("lang")!.value)).toBe("zh-CN");
    });

    it("keeps arbitrary bytes intact, and the stored value is base64 on disk", () => {
      const raw = new Uint8Array([0, 255, 10, 13, 0x80, 0xfe]);
      gene(GENE_A, "d").writeMemory("blob", raw, "CACHE");
      expect(Array.from(gene(GENE_A, "d").readMemory("blob")!.value)).toEqual(Array.from(raw));
      const file = JSON.parse(readFileSync(join(root, ".rotifer", "memory", `${AGENT}.json`), "utf-8"));
      expect(file.entries[0].value).toBe(Buffer.from(raw).toString("base64"));
    });

    it("an update keeps the id, creator and createdAt, moves updatedAt", () => {
      const a = gene(GENE_A, "d");
      const first = a.writeMemory("k", bytes("1"), "CONTEXT");
      clock += 60_000;
      const second = a.writeMemory("k", bytes("2"), "CONTEXT");
      expect(second.entryId).toBe(first.entryId);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.updatedAt).toBe("2026-10-30T12:01:00.000Z");
      expect(text(second.value)).toBe("2");
    });

    it("read by category returns nothing for another category, and a missing key is null", () => {
      const a = gene(GENE_A, "d");
      a.writeMemory("k", bytes("v"), "PATTERN");
      expect(a.readMemory("k", "PATTERN")).not.toBeNull();
      expect(a.readMemory("k", "PREFERENCE")).toBeNull();
      expect(a.readMemory("absent")).toBeNull();
    });

    it("lastAccessedBy follows reads and writes, never queries", () => {
      gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT");
      expect(gene(GENE_B, "d").readMemory("k")!.lastAccessedBy).toBe(GENE_B);
      expect(gene(GENE_C, "d").writeMemory("k", bytes("w"), "CONTEXT").lastAccessedBy).toBe(GENE_C);
      // A query is a scan: it returns the stored value and records nobody.
      expect(gene(GENE_A, "d").queryMemory()[0].lastAccessedBy).toBe(GENE_C);
      expect(gene(GENE_B, "d").queryMemory()[0].lastAccessedBy).toBe(GENE_C);
      const file = JSON.parse(readFileSync(memoryFile(), "utf-8"));
      expect(file.entries[0].lastAccessedBy).toBe(GENE_C);
    });
  });

  describe("permission scopes", () => {
    it("SAME_DOMAIN: another gene of the creator's domain reads; one of another domain is denied", () => {
      gene(GENE_A, "search").writeMemory("k", bytes("v"), "CONTEXT");
      expect(gene(GENE_B, "search").readMemory("k")).not.toBeNull();
      const err = denied(() => gene(GENE_C, "finance").readMemory("k"));
      // A refusal does not tell the caller the entry's policy or its creator's domain.
      expect(err.message).not.toMatch(/SAME_DOMAIN|search|readScope/);
    });

    it("CREATOR_GENE_ONLY: only the creating gene, even within its domain", () => {
      const only = { readScope: "CREATOR_GENE_ONLY", writeScope: "CREATOR_GENE_ONLY", sharePolicy: "PRIVATE" } as const;
      gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT", only);
      expect(gene(GENE_A, "d").readMemory("k")).not.toBeNull();
      denied(() => gene(GENE_B, "d").readMemory("k"));
      denied(() => gene(GENE_B, "d").writeMemory("k", bytes("x"), "CONTEXT", only));
      denied(() => gene(GENE_B, "d").deleteMemory("k"));
    });

    it("ALL_GENES: any gene of the agent", () => {
      gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT", { readScope: "ALL_GENES", writeScope: "ALL_GENES", sharePolicy: "PRIVATE" });
      expect(gene(GENE_C, "other").readMemory("k")).not.toBeNull();
      gene(GENE_C, "other").deleteMemory("k");
      expect(gene(GENE_A, "d").readMemory("k")).toBeNull();
    });

    it("DEPLOYER_CONFIGURED is always 'not configured' in v0.9.4: a write is refused, and an existing entry is denied, saying why", () => {
      const deployer = { readScope: "DEPLOYER_CONFIGURED", writeScope: "DEPLOYER_CONFIGURED", sharePolicy: "PRIVATE" } as const;
      expect(denied(() => gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT", deployer)).message).toContain("not configured");

      // An entry stored with that scope before it was refused (an older store,
      // or an import), put straight into the file.
      gene(GENE_A, "d").writeMemory("imported", bytes("v"), "CONTEXT");
      const file = JSON.parse(readFileSync(memoryFile(), "utf-8"));
      file.entries[0].accessPolicy = deployer;
      writeFileSync(memoryFile(), JSON.stringify(file));
      expect(denied(() => gene(GENE_A, "d").readMemory("imported")).message).toContain("not configured");
      expect(gene(GENE_A, "d").queryMemory().map((e) => e.key)).not.toContain("imported");
    });

    it.each([
      ["readScope", { readScope: "DEPLOYER_CONFIGURED", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" }],
      ["writeScope", { readScope: "SAME_DOMAIN", writeScope: "DEPLOYER_CONFIGURED", sharePolicy: "PRIVATE" }],
    ])("the store itself refuses a write whose %s is DEPLOYER_CONFIGURED", (_which, accessPolicy) => {
      const err = fails(
        () =>
          backend.write({ agentId: AGENT, geneId: GENE_A, domain: "d" }, {
            key: "k",
            value: Buffer.from("v").toString("base64"),
            category: "CONTEXT",
            accessPolicy: accessPolicy as never,
          }),
        "MEMORY_ACCESS_DENIED",
      );
      expect(err.message).toContain("not configured");
      expect(existsSync(memoryFile()) ? JSON.parse(readFileSync(memoryFile(), "utf-8")).entries : []).toEqual([]);
    });

    it("a caller without a v2 id is refused, audited with geneId null and reported, and nothing is stored", () => {
      gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT", { readScope: "ALL_GENES", writeScope: "ALL_GENES", sharePolicy: "PRIVATE" });
      const before = readFileSync(memoryFile(), "utf-8");
      const auditBefore = audit().length;
      const anonymous = gene("not-v2", "d");
      denied(() => anonymous.readMemory("k"));
      denied(() => anonymous.writeMemory("other", bytes("v"), "CONTEXT"));
      denied(() => anonymous.deleteMemory("k"));
      denied(() => anonymous.queryMemory());
      expect(readFileSync(memoryFile(), "utf-8")).toBe(before);
      const lines = audit().slice(auditBefore);
      expect(lines.map((l) => [l.action, l.geneId, l.entryId, l.category])).toEqual([
        ["access_denied", null, idOf("k"), null],
        ["access_denied", null, idOf("other"), null],
        ["access_denied", null, idOf("k"), null],
        ["access_denied", null, null, null],
      ]);
      expect(events.map((e) => [e.geneId, e.metadata.agentId, e.metadata.entryId, e.metadata.operation])).toEqual([
        [null, AGENT, idOf("k"), "read"],
        [null, AGENT, idOf("other"), "write"],
        [null, AGENT, idOf("k"), "delete"],
        [null, AGENT, null, "query"],
      ]);
    });

    describe("overwriting an existing key", () => {
      const shared = { readScope: "ALL_GENES", writeScope: "ALL_GENES", sharePolicy: "PRIVATE" } as const;
      const week = { maxRetentionDays: 7, autoDeleteOnTermination: true, anonymizationSupported: false };

      beforeEach(() => {
        gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT", shared, week);
      });

      it("another gene with write access may overwrite the value without passing policies; createdBy and the policies are kept", () => {
        const updated = gene(GENE_B, "x").writeMemory("k", bytes("w"), "CONTEXT");
        expect(updated).toMatchObject({ createdBy: GENE_A, accessPolicy: shared, retentionPolicy: week });
        expect(text(updated.value)).toBe("w");
      });

      it("passing the stored policies unchanged is fine too", () => {
        expect(gene(GENE_B, "x").writeMemory("k", bytes("w"), "CONTEXT", shared, week).createdBy).toBe(GENE_A);
      });

      it("another gene passing a different accessPolicy is refused, and nothing changes", () => {
        denied(() => gene(GENE_B, "x").writeMemory("k", bytes("w"), "CONTEXT", { ...shared, readScope: "CREATOR_GENE_ONLY" }));
        expect(gene(GENE_A, "d").readMemory("k")).toMatchObject({ accessPolicy: shared });
        expect(text(gene(GENE_A, "d").readMemory("k")!.value)).toBe("v");
      });

      it("another gene passing a different retentionPolicy — including null — is refused", () => {
        denied(() => gene(GENE_B, "x").writeMemory("k", bytes("w"), "CONTEXT", shared, { ...week, maxRetentionDays: 3 }));
        denied(() => gene(GENE_B, "x").writeMemory("k", bytes("w"), "CONTEXT", shared, null));
      });

      it("the creator may change the policies; leaving them out keeps the stored ones, it does not reset them", () => {
        gene(GENE_A, "d").writeMemory("k", bytes("v2"), "CONTEXT");
        expect(gene(GENE_A, "d").readMemory("k")).toMatchObject({ accessPolicy: shared, retentionPolicy: week });
        const narrowed = gene(GENE_A, "d").writeMemory("k", bytes("v3"), "CONTEXT", { ...shared, writeScope: "CREATOR_GENE_ONLY" }, null);
        expect(narrowed).toMatchObject({ accessPolicy: { writeScope: "CREATOR_GENE_ONLY" }, retentionPolicy: null });
        denied(() => gene(GENE_B, "x").writeMemory("k", bytes("w"), "CONTEXT"));
      });
    });

    it("a denial is a §17 event (binding extension) and an audit line; neither carries the key or the value", () => {
      gene(GENE_A, "search").writeMemory("secret-key", bytes("SENSITIVE-VALUE"), "PREFERENCE");
      denied(() => gene(GENE_C, "finance").readMemory("secret-key"));
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        eventType: "MEMORY_ACCESS_DENIED",
        bindingExtension: true,
        traceContext: null,
        geneId: GENE_C,
        timestamp: "2026-10-30T12:00:00.000Z",
        duration: null,
        resourceUsage: null,
        result: { FAILURE: { errorCode: "MEMORY_ACCESS_DENIED", message: expect.any(String) } },
        metadata: { agentId: AGENT, entryId: idOf("secret-key"), operation: "read" },
      });
      const lines = audit();
      expect(lines.map((l) => l.action)).toEqual(["memory_created", "write", "access_denied"]);
      expect(lines[2]).toEqual({
        ts: "2026-10-30T12:00:00.000Z",
        kind: "agent_memory",
        action: "access_denied",
        agentId: AGENT,
        entryId: idOf("secret-key"),
        category: "PREFERENCE",
        geneId: GENE_C,
        sizeDelta: 0,
        totalSize: "secret-key".length + "SENSITIVE-VALUE".length,
        quota: config.quota,
        error: "MEMORY_ACCESS_DENIED",
      });
      const all = JSON.stringify(events) + readFileSync(join(root, ".rotifer", "audit.jsonl"), "utf-8");
      expect(all).not.toContain("secret-key");
      expect(all).not.toContain("SENSITIVE-VALUE");
      expect(all).not.toContain(Buffer.from("SENSITIVE-VALUE").toString("base64"));
    });
  });

  describe("queryMemory", () => {
    beforeEach(() => {
      const a = gene(GENE_A, "d");
      a.writeMemory("pref:lang", bytes("zh"), "PREFERENCE");
      clock += 1000;
      a.writeMemory("pref:tone", bytes("brief"), "PREFERENCE");
      clock += 1000;
      a.writeMemory("pattern:retry", bytes("3"), "PATTERN");
      gene(GENE_C, "other").writeMemory("other:x", bytes("y"), "CONTEXT");
    });

    it("an empty filter returns what the caller may read, newest first, without reporting the rest", () => {
      expect(gene(GENE_A, "d").queryMemory().map((e) => e.key)).toEqual(["pattern:retry", "pref:tone", "pref:lang"]);
      expect(events).toHaveLength(0);
    });

    it("filters by category", () => {
      expect(gene(GENE_A, "d").queryMemory({ category: "PREFERENCE" }).map((e) => e.key)).toEqual(["pref:tone", "pref:lang"]);
    });

    it("filters by a plain key prefix", () => {
      expect(gene(GENE_A, "d").queryMemory({ keyPrefix: "pattern:" }).map((e) => e.key)).toEqual(["pattern:retry"]);
      expect(gene(GENE_A, "d").queryMemory({ keyPrefix: "pref:*" })).toEqual([]);
    });

    it("since is inclusive and until exclusive, both on updatedAt", () => {
      const hits = gene(GENE_A, "d").queryMemory({ since: "2026-10-30T12:00:01.000Z", until: "2026-10-30T12:00:02.000Z" });
      expect(hits.map((e) => e.key)).toEqual(["pref:tone"]);
      clock += 1000;
      gene(GENE_A, "d").writeMemory("pref:lang", bytes("en"), "PREFERENCE");
      expect(gene(GENE_A, "d").queryMemory({ since: "2026-10-30T12:00:03.000Z" }).map((e) => e.key)).toEqual(["pref:lang"]);
    });

    it("entries with the same updatedAt come back in entryId order, not in the order they were written", () => {
      clock += 1000;
      const written = ["tie:a", "tie:b", "tie:c", "tie:d", "tie:e"];
      for (const key of written) gene(GENE_A, "d").writeMemory(key, bytes("1"), "CACHE");
      const writtenIds = written.map(idOf);
      const byEntryId = [...writtenIds].sort();
      // Only meaningful if the two orders differ — they do for these keys.
      expect(byEntryId).not.toEqual(writtenIds);
      expect(gene(GENE_A, "d").queryMemory({ keyPrefix: "tie:" }).map((e) => e.entryId)).toEqual(byEntryId);
    });

    it("limit defaults to 100, takes a smaller value, and is capped at 1000 when more than 1000 match", () => {
      for (let i = 0; i < 1005; i++) gene(GENE_A, "d").writeMemory(`bulk:${i}`, bytes("x"), "CACHE");
      expect(gene(GENE_A, "d").queryMemory({ keyPrefix: "bulk:" })).toHaveLength(100);
      expect(gene(GENE_A, "d").queryMemory({ keyPrefix: "bulk:", limit: 5 })).toHaveLength(5);
      expect(gene(GENE_A, "d").queryMemory({ keyPrefix: "bulk:", limit: 1000 })).toHaveLength(1000);
      expect(gene(GENE_A, "d").queryMemory({ keyPrefix: "bulk:", limit: 5000 })).toHaveLength(1000);
    }, 60_000);

    it.each([
      ["an alias field (from)", { from: "2026-10-30T12:00:00.000Z" }],
      ["an alias field (updatedAfter)", { updatedAfter: "2026-10-30T12:00:00.000Z" }],
      ["timeField", { timeField: "createdAt" }],
      ["a lowercase category", { category: "preference" }],
      ["a bad since", { since: "yesterday" }],
      // RFC 3339 only: Date.parse would take these.
      ["a year-only since", { since: "2026" }],
      ["a date-only until", { until: "2026-10-30" }],
      ["an impossible date", { since: "2026-02-30T00:00:00Z" }],
      ["a timestamp without a zone", { since: "2026-10-30T12:00:00" }],
      ["an unknown field", { category: "CACHE", sortBy: "key" }],
      ["a zero limit", { limit: 0 }],
      ["a fractional limit", { limit: 2.5 }],
    ])("refuses %s as MEMORY_INVALID_INPUT", (_what, filter) => {
      fails(() => gene(GENE_A, "d").queryMemory(filter as never), "MEMORY_INVALID_INPUT");
    });
  });

  describe("quota (§38.1 MUST)", () => {
    // Each entry is a 1-byte key + 9-byte value = 10 bytes.
    const fill = (key: string, category: "PREFERENCE" | "PATTERN" | "CONTEXT" | "CACHE") => {
      gene(GENE_A, "d").writeMemory(key, bytes("123456789"), category);
      clock += 1000;
    };
    const evicted = () => audit().filter((l) => l.action === "evict").map((l) => l.entryId);

    it("evicts CACHE oldest first, then the oldest PATTERN, then the oldest CONTEXT; never PREFERENCE", () => {
      config.quota = 60;
      fill("p", "PREFERENCE");
      fill("x", "CONTEXT");
      fill("t", "PATTERN");
      fill("c", "CACHE");
      fill("d", "CACHE");
      fill("u", "PATTERN");
      // Full (60/60). A 30-byte write needs three evictions: c, d (CACHE,
      // oldest first), then t (the oldest PATTERN). x (CONTEXT) and p stay.
      gene(GENE_A, "d").writeMemory("n", bytes("x".repeat(29)), "CONTEXT");
      expect(gene(GENE_A, "d").queryMemory().map((e) => e.key).sort()).toEqual(["n", "p", "u", "x"]);
      expect(evicted()).toEqual([idOf("c"), idOf("d"), idOf("t")]);
      // Each evict line's total is what the memory holds right after that
      // eviction — never above the quota; the write's line has the final total.
      const totals = audit().filter((l) => l.action === "evict" || l.entryId === idOf("n")).map((l) => [l.action, l.totalSize]);
      expect(totals).toEqual([["evict", 50], ["evict", 40], ["evict", 30], ["write", 60]]);
    });

    it("'oldest' is by updatedAt: an entry rewritten recently counts as fresh", () => {
      config.quota = 30;
      fill("a", "CACHE");
      fill("b", "CACHE");
      fill("c", "CACHE");
      fill("a", "CACHE"); // a is now the most recently updated
      gene(GENE_A, "d").writeMemory("n", bytes("123456789"), "CACHE");
      expect(evicted()).toEqual([idOf("b")]);
    });

    it("between entries updated at the same moment, the smaller entryId is evicted first", () => {
      config.quota = 20;
      gene(GENE_A, "d").writeMemory("a", bytes("123456789"), "CACHE");
      gene(GENE_A, "d").writeMemory("b", bytes("123456789"), "CACHE");
      clock += 1000;
      gene(GENE_A, "d").writeMemory("n", bytes("123456789"), "CACHE");
      expect(evicted()).toEqual([[idOf("a"), idOf("b")].sort()[0]]);
    });

    it("the quota counts UTF-8 bytes of key and value only, not string length and not the retentionPolicy", () => {
      const retention = { maxRetentionDays: 7, autoDeleteOnTermination: true, anonymizationSupported: false };
      policy.retentionPolicy = { ...retention, maxRetentionDays: 30 };
      gene(GENE_A, "d").writeMemory("é", bytes("ü"), "CONTEXT", undefined, retention);
      expect(backend.totalSize(AGENT)).toBe(2 + 2);
    });

    it("rejects a write that cannot fit after evicting everything evictable, and changes nothing", () => {
      config.quota = 40;
      fill("p", "PREFERENCE");
      fill("q", "PREFERENCE");
      fill("c", "CACHE");
      const before = readFileSync(join(root, ".rotifer", "memory", `${AGENT}.json`), "utf-8");
      fails(() => gene(GENE_A, "d").writeMemory("n", bytes("x".repeat(29)), "CACHE"), "MEMORY_QUOTA_EXCEEDED");
      expect(readFileSync(join(root, ".rotifer", "memory", `${AGENT}.json`), "utf-8")).toBe(before);
      expect(audit().at(-1)).toMatchObject({ action: "quota_rejected", entryId: idOf("n"), error: "MEMORY_QUOTA_EXCEEDED" });
      expect(evicted()).toEqual([]);
    });

    it("an update counts its new size, not old + new", () => {
      config.quota = 20;
      fill("k", "PREFERENCE");
      gene(GENE_A, "d").writeMemory("k", bytes("x".repeat(19)), "PREFERENCE");
      expect(backend.totalSize(AGENT)).toBe(20);
      expect(audit().at(-1)).toMatchObject({ action: "update", sizeDelta: 10, totalSize: 20 });
    });
  });

  describe("retention is enforced, lazily", () => {
    const DAY = 86_400_000;
    const oneDay = { maxRetentionDays: 1, autoDeleteOnTermination: false, anonymizationSupported: false };
    const expiredLines = () => audit().filter((l) => l.action === "expired");

    it("an entry kept 1 day is there at 1 day − 1 s, and gone from 1 day on: not read, not queried, not counted, audited once", () => {
      const t0 = clock;
      gene(GENE_A, "d").writeMemory("short", bytes("v"), "CONTEXT", undefined, oneDay);
      gene(GENE_A, "d").writeMemory("kept", bytes("w"), "CONTEXT");
      const sizeShort = "short".length + 1;

      clock = t0 + DAY - 1000;
      expect(gene(GENE_A, "d").readMemory("short")).not.toBeNull();
      expect(gene(GENE_A, "d").queryMemory().map((e) => e.key).sort()).toEqual(["kept", "short"]);
      expect(backend.totalSize(AGENT)).toBe(sizeShort + "kept".length + 1);
      expect(expiredLines()).toEqual([]);

      clock = t0 + DAY; // now >= updatedAt + 1 day: expired
      expect(gene(GENE_A, "d").readMemory("short")).toBeNull();
      expect(gene(GENE_A, "d").queryMemory().map((e) => e.key)).toEqual(["kept"]);
      expect(backend.totalSize(AGENT)).toBe("kept".length + 1);
      clock = t0 + DAY + 1000;
      expect(gene(GENE_A, "d").readMemory("short")).toBeNull();

      const lines = expiredLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        kind: "agent_memory",
        action: "expired",
        agentId: AGENT,
        entryId: idOf("short"),
        category: "CONTEXT",
        sizeDelta: -sizeShort,
        totalSize: "kept".length + 1,
        error: null,
      });
      expect(JSON.stringify(lines[0])).not.toContain("short\"");
      // Gone from the store, not merely hidden.
      expect(JSON.parse(readFileSync(memoryFile(), "utf-8")).entries.map((e: { key: string }) => e.key)).toEqual(["kept"]);
    });

    it("a write to an expired key is a fresh create", () => {
      const t0 = clock;
      gene(GENE_A, "d").writeMemory("k", bytes("old"), "CONTEXT", { readScope: "ALL_GENES", writeScope: "ALL_GENES", sharePolicy: "PRIVATE" }, oneDay);
      clock = t0 + DAY + 1000;
      const fresh = gene(GENE_B, "d").writeMemory("k", bytes("new"), "PATTERN");
      expect(fresh).toMatchObject({
        createdBy: GENE_B,
        createdAt: new Date(t0 + DAY + 1000).toISOString(),
        category: "PATTERN",
        accessPolicy: { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" },
        retentionPolicy: null,
      });
      expect(audit().filter((l) => l.entryId === idOf("k")).map((l) => l.action)).toEqual(["write", "expired", "write"]);
    });

    it("an entry with no policy of its own, under an agent with unlimited retention (the default), never expires", () => {
      const t0 = clock;
      gene(GENE_A, "d").writeMemory("inherits", bytes("v"), "CONTEXT");
      clock = t0 + 10 * 365 * DAY;
      expect(gene(GENE_A, "d").readMemory("inherits")).not.toBeNull();
      expect(expiredLines()).toEqual([]);
    });

    it("the agent's retention comes from setDataPolicyRetention, audited as retention_changed; an entry's own maxRetentionDays: null is not inherited", () => {
      const t0 = clock;
      gene(GENE_A, "d").writeMemory("inherits", bytes("v"), "CONTEXT");
      gene(GENE_A, "d").writeMemory("own-unlimited", bytes("v"), "CONTEXT", undefined, { ...oneDay, maxRetentionDays: null });
      backend.setDataPolicyRetention(AGENT, 30);
      expect(audit().at(-1)).toMatchObject({
        action: "retention_changed",
        agentId: AGENT,
        entryId: null,
        category: null,
        geneId: null,
        sizeDelta: 0,
        error: null,
      });
      clock = t0 + 30 * DAY;
      expect(gene(GENE_A, "d").readMemory("inherits")).toBeNull();
      expect(gene(GENE_A, "d").readMemory("own-unlimited")).not.toBeNull();
      expect(expiredLines().map((l) => l.entryId)).toEqual([idOf("inherits")]);
      // Back to unlimited.
      backend.setDataPolicyRetention(AGENT, null);
      expect(audit().filter((l) => l.action === "retention_changed")).toHaveLength(2);
    });

    it.each([0, -1, 1.5, 2147483648])("setDataPolicyRetention refuses %s days as MEMORY_INVALID_INPUT", (days) => {
      gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT");
      fails(() => backend.setDataPolicyRetention(AGENT, days), "MEMORY_INVALID_INPUT");
    });

    it("setDataPolicyRetention on an agent with no memory is MEMORY_NOT_FOUND", () => {
      fails(() => backend.setDataPolicyRetention(AGENT, 30), "MEMORY_NOT_FOUND");
    });

    it("entries expiring together are purged in entryId order — not by age — each line's total counting down", () => {
      const t0 = clock;
      const keys = ["k1", "k2", "k3", "k4"];
      for (const key of keys) {
        gene(GENE_A, "d").writeMemory(key, bytes("v"), "CONTEXT", undefined, oneDay);
        clock += 1000;
      }
      const byEntryId = keys.map(idOf).sort();
      // Only meaningful if age order and entryId order differ — they do for these keys.
      expect(byEntryId).not.toEqual(keys.map(idOf));
      clock = t0 + DAY + 10_000;
      gene(GENE_A, "d").queryMemory();
      const lines = expiredLines();
      expect(lines.map((l) => l.entryId)).toEqual(byEntryId);
      expect(lines.map((l) => l.totalSize)).toEqual([9, 6, 3, 0]);
    });

    it("a delete of an expired key purges it first: an expired line, then MEMORY_NOT_FOUND", () => {
      const t0 = clock;
      gene(GENE_A, "d").writeMemory("gone", bytes("v"), "CONTEXT", undefined, oneDay);
      clock = t0 + DAY;
      fails(() => gene(GENE_A, "d").deleteMemory("gone"), "MEMORY_NOT_FOUND");
      expect(audit().slice(-1).map((l) => [l.action, l.entryId])).toEqual([["expired", idOf("gone")]]);
    });

    it.each([
      ["a denied read", (_: unknown) => denied(() => gene(GENE_B, "d").readMemory("mine")), "access_denied", "mine"],
      ["a denied delete", (_: unknown) => denied(() => gene(GENE_B, "d").deleteMemory("mine")), "access_denied", "mine"],
      [
        "a write over quota",
        (_: unknown) => fails(() => gene(GENE_A, "d").writeMemory("huge", new Uint8Array(65), "CACHE"), "MEMORY_QUOTA_EXCEEDED"),
        "quota_rejected",
        "huge",
      ],
    ] as const)("%s keeps the purge it started with: the expired line stays, before the refusal's line, and the entry is gone", (_what, refuse, refusal, key) => {
      config.quota = 64;
      const t0 = clock;
      gene(GENE_A, "d").writeMemory("gone", bytes("v"), "CONTEXT", undefined, oneDay);
      const twoDays = { ...oneDay, maxRetentionDays: 2 };
      gene(GENE_A, "d").writeMemory("mine", bytes("v"), "CONTEXT", { readScope: "CREATOR_GENE_ONLY", writeScope: "CREATOR_GENE_ONLY", sharePolicy: "PRIVATE" }, twoDays);
      clock = t0 + DAY;
      refuse(undefined);
      expect(audit().slice(-2).map((l) => [l.action, l.entryId])).toEqual([
        ["expired", idOf("gone")],
        [refusal, idOf(key)],
      ]);
      expect(JSON.parse(readFileSync(memoryFile(), "utf-8")).entries.map((e: { key: string }) => e.key)).toEqual(["mine"]);
    });

    it("maxRetentionDays at its largest (2147483647) is compared as elapsed seconds and does not expire within any real time", () => {
      const t0 = clock;
      gene(GENE_A, "d").writeMemory("forever", bytes("v"), "CONTEXT", undefined, { ...oneDay, maxRetentionDays: 2147483647 });
      clock = t0 + 10_000 * 365 * DAY;
      expect(gene(GENE_A, "d").readMemory("forever")).not.toBeNull();
      expect(expiredLines()).toEqual([]);
    });
  });

  describe("DataPolicy (§30.2)", () => {
    it("refuses an entry kept longer than the agent's retention, with a §17 event", () => {
      policy.retentionPolicy = { maxRetentionDays: 30, autoDeleteOnTermination: true, anonymizationSupported: false };
      const retention = (days: number) => ({ maxRetentionDays: days, autoDeleteOnTermination: true, anonymizationSupported: false });
      denied(() => gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT", undefined, retention(90)));
      expect(events[0]).toMatchObject({
        eventType: "MEMORY_ACCESS_DENIED",
        bindingExtension: true,
        metadata: { agentId: AGENT, entryId: idOf("k"), operation: "write" },
      });
      expect(events[0].result.FAILURE.message).toContain("DataPolicy");
      gene(GENE_A, "d").writeMemory("k", bytes("v"), "CONTEXT", undefined, retention(7));
    });

    it("refuses a shareable entry under the default policy (no anonymisation); allows it when the agent's can", () => {
      const share = { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "KNOWLEDGE_GENE" } as const;
      denied(() => gene(GENE_A, "d").writeMemory("k", bytes("v"), "PATTERN", share));
      policy.retentionPolicy = { ...policy.retentionPolicy, anonymizationSupported: true };
      gene(GENE_A, "d").writeMemory("k", bytes("v"), "PATTERN", share);
    });

    it("a DataPolicy refusal is audited as well as reported to §17", () => {
      const share = { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "KNOWLEDGE_GENE" } as const;
      denied(() => gene(GENE_A, "d").writeMemory("k", bytes("v"), "PATTERN", share));
      expect(audit().at(-1)).toMatchObject({
        kind: "agent_memory",
        action: "access_denied",
        agentId: AGENT,
        entryId: idOf("k"),
        geneId: GENE_A,
        error: "MEMORY_ACCESS_DENIED",
      });
      expect(events).toHaveLength(1);
    });

    it("writes nothing when the policy refuses", () => {
      const share = { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "ANONYMIZED_SHARE" } as const;
      denied(() => gene(GENE_A, "d").writeMemory("k", bytes("v"), "PATTERN", share));
      expect(gene(GENE_A, "d").readMemory("k")).toBeNull();
    });
  });

  describe("delete", () => {
    it("removes the entry and audits it; a missing key is MEMORY_NOT_FOUND", () => {
      gene(GENE_A, "d").writeMemory("k", bytes("v"), "CACHE");
      gene(GENE_A, "d").deleteMemory("k");
      expect(gene(GENE_A, "d").readMemory("k")).toBeNull();
      expect(audit().at(-1)).toMatchObject({ action: "delete", entryId: idOf("k"), sizeDelta: -2, totalSize: 0 });
      fails(() => gene(GENE_A, "d").deleteMemory("k"), "MEMORY_NOT_FOUND");
    });
  });

  describe("invalid input (key rule)", () => {
    it.each([
      ["an empty key", () => gene(GENE_A, "d").writeMemory("", bytes("v"), "CACHE")],
      ["a key with NUL", () => gene(GENE_A, "d").writeMemory("a\0b", bytes("v"), "CACHE")],
      ["a key over 1024 bytes", () => gene(GENE_A, "d").writeMemory("é".repeat(513), bytes("v"), "CACHE")],
      ["a lowercase category", () => gene(GENE_A, "d").writeMemory("k", bytes("v"), "cache" as never)],
      ["a string value", () => gene(GENE_A, "d").writeMemory("k", "v" as never, "CACHE")],
      ["an unknown scope", () => gene(GENE_A, "d").writeMemory("k", bytes("v"), "CACHE", { readScope: "EVERYONE", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" } as never)],
    ])("refuses %s as MEMORY_INVALID_INPUT and writes nothing", (_what, call) => {
      fails(call, "MEMORY_INVALID_INPUT");
      expect(existsSync(join(root, ".rotifer", "memory", `${AGENT}.json`))).toBe(false);
    });

    describe("retentionPolicy is exactly the §30.2 shape", () => {
      const ok = { maxRetentionDays: 7, autoDeleteOnTermination: true, anonymizationSupported: false };
      const { maxRetentionDays: _days, ...withoutDays } = ok;
      it.each([
        ["an extra field", { ...ok, note: "x" }],
        ["a missing maxRetentionDays (null must be written out)", withoutDays],
        ["a missing boolean", { maxRetentionDays: 7, autoDeleteOnTermination: true }],
        ["maxRetentionDays 0", { ...ok, maxRetentionDays: 0 }],
        ["maxRetentionDays above i32", { ...ok, maxRetentionDays: 2147483648 }],
        ["a fractional maxRetentionDays", { ...ok, maxRetentionDays: 1.5 }],
        ["maxRetentionDays as a string", { ...ok, maxRetentionDays: "7" }],
        ["a boolean as a string", { ...ok, anonymizationSupported: "false" }],
        ["an array", [7, true, false]],
        ["a string", "7 days"],
      ])("refuses %s as MEMORY_INVALID_INPUT and writes nothing", (_what, retention) => {
        fails(() => gene(GENE_A, "d").writeMemory("k", bytes("v"), "CACHE", undefined, retention as never), "MEMORY_INVALID_INPUT");
        expect(existsSync(memoryFile())).toBe(false);
      });

      it("accepts maxRetentionDays at both ends of its range, and null", () => {
        policy.retentionPolicy = { ...ok, maxRetentionDays: null };
        for (const days of [1, 2147483647, null]) {
          expect(gene(GENE_A, "d").writeMemory("k", bytes("v"), "CACHE", undefined, { ...ok, maxRetentionDays: days }).retentionPolicy).toEqual({
            ...ok,
            maxRetentionDays: days,
          });
        }
      });
    });

    it("the store refuses bad input itself — bad base64, an unknown category — not only the SDK in front of it", () => {
      const caller = { agentId: AGENT, geneId: GENE_A, domain: "d" };
      for (const request of [
        { key: "k", value: "not base64!", category: "CACHE" },
        { key: "k", value: "dg", category: "CACHE" },
        { key: "k", value: "dg==", category: "cache" },
        { key: "k", value: "dg==", category: "CACHE", accessPolicy: { readScope: "EVERYONE", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" } },
      ]) {
        fails(() => backend.write(caller, request as never), "MEMORY_INVALID_INPUT");
      }
      expect(existsSync(memoryFile())).toBe(false);
    });

    it("accepts a key of exactly 1024 bytes", () => {
      gene(GENE_A, "d").writeMemory("k".repeat(1024), bytes("v"), "CACHE");
    });
  });

  describe("size limits", () => {
    const MiB = 1024 * 1024;

    it("a value of exactly 1 MiB is stored; one byte more is MEMORY_INVALID_INPUT and nothing is written", () => {
      gene(GENE_A, "d").writeMemory("big", new Uint8Array(MiB), "CACHE");
      expect(gene(GENE_A, "d").readMemory("big")!.value.byteLength).toBe(MiB);
      fails(() => gene(GENE_A, "d").writeMemory("bigger", new Uint8Array(MiB + 1), "CACHE"), "MEMORY_INVALID_INPUT");
      expect(gene(GENE_A, "d").readMemory("bigger")).toBeNull();
    });

    it("the store itself refuses an oversized value, not only the SDK in front of it", () => {
      expect(() =>
        backend.write({ agentId: AGENT, geneId: GENE_A, domain: "d" }, {
          key: "raw",
          value: Buffer.alloc(MiB + 1).toString("base64"),
          category: "CACHE",
        }),
      ).toThrow(MemoryError);
    });

    it("a query whose response would pass 4 MiB is refused, not truncated, and changes nothing; a narrower one works", () => {
      // Four 1 MiB values: about 5.6 MiB once base64-encoded in the response.
      for (const k of ["a", "b", "c", "d"]) gene(GENE_A, "d").writeMemory(`blob:${k}`, new Uint8Array(MiB), "CACHE");
      const before = readFileSync(join(root, ".rotifer", "memory", `${AGENT}.json`), "utf-8");
      const err = fails(() => gene(GENE_B, "d").queryMemory({ keyPrefix: "blob:" }), "MEMORY_INVALID_INPUT");
      expect(err.message).toBe("result too large; lower limit or narrow the filter");
      expect(readFileSync(join(root, ".rotifer", "memory", `${AGENT}.json`), "utf-8")).toBe(before);
      expect(gene(GENE_B, "d").queryMemory({ keyPrefix: "blob:", limit: 2 })).toHaveLength(2);
    });
  });

  describe("memory belongs to the agent (§38.1)", () => {
    it("a new store instance (a later run, after the genome changed) reads what an earlier one wrote", () => {
      gene(GENE_A, "d").writeMemory("k", bytes("kept"), "PREFERENCE");
      backend = newBackend();
      expect(text(gene(GENE_B, "d").readMemory("k")!.value)).toBe("kept");
    });
  });

  describe("audit, telemetry and storage failures", () => {
    it("audit lines are written before the change: if the audit log cannot be written, the call is MEMORY_STORAGE_ERROR and nothing is stored", () => {
      gene(GENE_A, "d").writeMemory("k", bytes("v1"), "CACHE");
      const before = readFileSync(memoryFile(), "utf-8");
      // The audit log path is now a directory: appending to it fails.
      rmSync(join(root, ".rotifer", "audit.jsonl"));
      mkdirSync(join(root, ".rotifer", "audit.jsonl"));
      fails(() => gene(GENE_A, "d").writeMemory("k", bytes("v2"), "CACHE"), "MEMORY_STORAGE_ERROR");
      fails(() => gene(GENE_A, "d").writeMemory("new", bytes("v"), "CACHE"), "MEMORY_STORAGE_ERROR");
      fails(() => gene(GENE_A, "d").deleteMemory("k"), "MEMORY_STORAGE_ERROR");
      expect(readFileSync(memoryFile(), "utf-8")).toBe(before);
    });

    it("a store that cannot be read is MEMORY_STORAGE_ERROR, never MEMORY_INVALID_INPUT", () => {
      mkdirSync(memoryFile(), { recursive: true });
      for (const call of [
        () => gene(GENE_A, "d").readMemory("k"),
        () => gene(GENE_A, "d").writeMemory("k", bytes("v"), "CACHE"),
        () => gene(GENE_A, "d").queryMemory(),
        () => gene(GENE_A, "d").deleteMemory("k"),
      ]) {
        fails(call, "MEMORY_STORAGE_ERROR");
      }
    });

    it("ROTIFER_TELEMETRY=0 stops the §17 events; the audit line is written anyway", () => {
      telemetrySink = fileTelemetrySink(root, { ROTIFER_TELEMETRY: "0" });
      gene(GENE_A, "search").writeMemory("k", bytes("v"), "PREFERENCE");
      denied(() => gene(GENE_C, "finance").readMemory("k"));
      denied(() =>
        gene(GENE_A, "d").writeMemory("s", bytes("v"), "PATTERN", { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy: "KNOWLEDGE_GENE" }),
      );
      expect(existsSync(join(root, ".rotifer", "telemetry.jsonl"))).toBe(false);
      expect(audit().filter((l) => l.action === "access_denied")).toHaveLength(2);
    });

    it("with telemetry on, the same denials reach .rotifer/telemetry.jsonl", () => {
      telemetrySink = fileTelemetrySink(root, {});
      gene(GENE_A, "search").writeMemory("k", bytes("v"), "PREFERENCE");
      denied(() => gene(GENE_C, "finance").readMemory("k"));
      const lines = readFileSync(join(root, ".rotifer", "telemetry.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ eventType: "MEMORY_ACCESS_DENIED", metadata: { entryId: idOf("k"), operation: "read" } });
    });

    it("the memory file, the audit log and the telemetry log are owner-only", () => {
      telemetrySink = fileTelemetrySink(root, {});
      gene(GENE_A, "search").writeMemory("k", bytes("v"), "PREFERENCE");
      denied(() => gene(GENE_C, "finance").readMemory("k"));
      const mode = (p: string) => statSync(p).mode & 0o777;
      expect(mode(memoryFile())).toBe(0o600);
      expect(mode(join(root, ".rotifer", "audit.jsonl"))).toBe(0o600);
      expect(mode(join(root, ".rotifer", "telemetry.jsonl"))).toBe(0o600);
      expect(mode(join(root, ".rotifer", "memory"))).toBe(0o700);
    });
  });
});
