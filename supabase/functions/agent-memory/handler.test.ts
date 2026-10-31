import { assertEquals } from "jsr:@std/assert@1";
import {
  type ContainerRow,
  DbError,
  type EvictedEntry,
  type ExpiredEntry,
  boundedBody,
  handle,
  jwtRole,
  type MemoryStore,
  opFromUrl,
  type WriteParams,
} from "./handler.ts";
import { accessDenial, jsonEqual } from "./access.ts";
import { MemoryError } from "./wire.ts";
import type { CallerGene, EntryRow, MemoryFilter } from "./wire.ts";

/**
 * The handler against an in-memory store. Quota, eviction, RLS and entry ids
 * are the database's job and are covered by supabase/tests/agent_memory_entries.sql;
 * the fake only stores rows so the gene-scope checks, the request mapping and
 * the error responses can be exercised here.
 */
class FakeStore implements MemoryStore {
  rows = new Map<string, EntryRow>();
  writes: WriteParams[] = [];
  touches: string[] = [];
  deletes: string[] = [];
  failWith: DbError | null = null;
  /** What the store reports as purged for expiry on every call. */
  expiredOnCall: ExpiredEntry[] = [];
  containers = new Map<string, ContainerRow>();

  seed(r: Partial<EntryRow> & { key: string }): void {
    this.rows.set(r.key, {
      entry_id: r.key.padEnd(64, "0"),
      agent_id: "agent-1",
      category: "CONTEXT",
      value: "\\x76",
      created_by: "v2:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      created_by_domain: "search.web",
      last_accessed_by: null,
      created_at: "2026-10-30T00:00:00Z",
      updated_at: "2026-10-30T00:00:00Z",
      read_scope: "SAME_DOMAIN",
      write_scope: "SAME_DOMAIN",
      share_policy: "PRIVATE",
      retention_policy: null,
      ...r,
    });
  }

  // The scope and policy checks below stand in for the RPCs' own
  // (agent_memory_read / _write / _delete, pgTAP covers the real ones); they
  // reuse access.ts, which encodes the same §38.2 rules.
  private denied(op: string, scope: EntryRow["read_scope"], row: EntryRow, caller: CallerGene): DbError | null {
    const reason = accessDenial(scope, row, caller);
    return reason === null ? null : new DbError("42501", `MEMORY_ACCESS_DENIED: ${op} denied: ${reason}`);
  }

  registerContainer(agentId: string, quota: number | undefined): Promise<void> {
    const c = this.containers.get(agentId);
    this.containers.set(agentId, {
      agent_id: agentId,
      quota_bytes: quota ?? c?.quota_bytes ?? 10485760,
      total_size: 0,
      created_at: c?.created_at ?? "2026-10-30T00:00:00Z",
    });
    return Promise.resolve();
  }
  getContainer(agentId: string) {
    return Promise.resolve(this.containers.get(agentId) ?? null);
  }
  readEntry(
    _agentId: string,
    key: string,
    category: string | undefined,
    caller: CallerGene,
  ): Promise<{ entry: EntryRow | null; expired: ExpiredEntry[] }> {
    const row = this.rows.get(key);
    if (!row || (category !== undefined && row.category !== category)) {
      return Promise.resolve({ entry: null, expired: this.expiredOnCall });
    }
    const err = this.denied("read", row.read_scope, row, caller);
    if (err) return Promise.reject(err);
    if (row.last_accessed_by !== caller.geneId) {
      this.touches.push(`${key}:${caller.geneId}`);
      row.last_accessed_by = caller.geneId;
    }
    return Promise.resolve({ entry: { ...row }, expired: this.expiredOnCall });
  }
  // Deliberately returns every row, unfiltered by scope or prefix and not
  // limited, so the handler's own second-line checks are what is tested
  // here. Scope-before-LIMIT in agent_memory_query is pgTAP QY1–QY4.
  listEntries(_agentId: string, filter: MemoryFilter, _caller: unknown, _limit: number) {
    return Promise.resolve({
      entries: [...this.rows.values()]
        .filter((r) => !filter.category || r.category === filter.category)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.entry_id.localeCompare(b.entry_id)),
      expired: this.expiredOnCall,
    });
  }
  write(p: WriteParams): Promise<{ entry: EntryRow; evicted: EvictedEntry[]; expired: ExpiredEntry[] }> {
    if (this.failWith) return Promise.reject(this.failWith);
    const caller = { geneId: p.callerGeneId, domain: p.callerDomain };
    const prev = this.rows.get(p.key);
    if (prev) {
      const err = this.denied("write", prev.write_scope, prev, caller);
      if (err) return Promise.reject(err);
      const changes = (p.readScope !== null && p.readScope !== prev.read_scope) ||
        (p.writeScope !== null && p.writeScope !== prev.write_scope) ||
        (p.sharePolicy !== null && p.sharePolicy !== prev.share_policy) ||
        (p.setRetention && !jsonEqual(p.retentionPolicy, prev.retention_policy));
      if (prev.created_by !== caller.geneId && changes) {
        return Promise.reject(
          new DbError("42501", `MEMORY_ACCESS_DENIED: only the gene that created '${p.key}' may change its accessPolicy or retentionPolicy`),
        );
      }
    }
    this.writes.push(p);
    this.seed({
      ...prev,
      key: p.key,
      value: p.value,
      category: p.category as EntryRow["category"],
      created_by: prev?.created_by ?? p.callerGeneId,
      created_by_domain: prev?.created_by_domain ?? p.callerDomain,
      last_accessed_by: p.callerGeneId,
      read_scope: (p.readScope ?? prev?.read_scope ?? "SAME_DOMAIN") as EntryRow["read_scope"],
      write_scope: (p.writeScope ?? prev?.write_scope ?? "SAME_DOMAIN") as EntryRow["write_scope"],
      retention_policy: p.setRetention ? p.retentionPolicy : prev?.retention_policy ?? null,
    });
    return Promise.resolve({ entry: this.rows.get(p.key)!, evicted: [], expired: this.expiredOnCall });
  }
  deleteEntry(_agentId: string, key: string, caller: CallerGene) {
    const row = this.rows.get(key);
    if (!row) return Promise.reject(new DbError("P0002", `MEMORY_NOT_FOUND: no entry '${key}' for agent agent-1`));
    const err = this.denied("delete", row.write_scope, row, caller);
    if (err) return Promise.reject(err);
    this.deletes.push(key);
    this.rows.delete(key);
    return Promise.resolve({ entryId: row.entry_id, key: row.key, expired: this.expiredOnCall });
  }
}

const sameDomain = { geneId: "v2:0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e", domain: "search.web" };
const otherDomain = { geneId: "v2:0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f", domain: "finance.quote" };
const creator = { geneId: "v2:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", domain: "anything" };

async function call(store: MemoryStore, op: string, body: unknown, method = "POST") {
  const res = await handle(
    new Request(`http://localhost/functions/v1/agent-memory/${op}`, {
      method,
      body: method === "POST" ? JSON.stringify(body) : undefined,
      headers: { "Content-Type": "application/json" },
    }),
    store,
  );
  return { status: res.status, body: await res.json() };
}

Deno.test("write creates an entry and returns the wire entry plus evictions", async () => {
  const s = new FakeStore();
  const r = await call(s, "write", {
    agentId: "agent-1",
    caller: sameDomain,
    key: "theme",
    value: "ZGFyaw==",
    category: "PREFERENCE",
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.entry.key, "theme");
  assertEquals(r.body.entry.value, "ZGFyaw==");
  assertEquals(r.body.evicted, []);
  assertEquals(r.body.expired, []);
  assertEquals(s.writes[0].value, "\\x6461726b");
  assertEquals(s.writes[0].readScope, null); // the database applies the SAME_DOMAIN default
  assertEquals(s.writes[0].setRetention, false);
});

Deno.test("write passes back the entries purged for expiry, as ids only", async () => {
  const s = new FakeStore();
  s.expiredOnCall = [{ entryId: "f".repeat(64) }];
  const r = await call(s, "write", { agentId: "agent-1", caller: creator, key: "k", value: "", category: "CACHE" });
  assertEquals(r.status, 200);
  assertEquals(r.body.expired, [{ entryId: "f".repeat(64) }]);
});

Deno.test("read, query and delete pass back the entries purged for expiry too", async () => {
  const s = new FakeStore();
  s.seed({ key: "k", write_scope: "ALL_GENES" });
  s.expiredOnCall = [{ entryId: "e".repeat(64) }];
  const want = [{ entryId: "e".repeat(64) }];
  assertEquals((await call(s, "read", { agentId: "agent-1", caller: sameDomain, key: "k" })).body.expired, want);
  assertEquals((await call(s, "read", { agentId: "agent-1", caller: sameDomain, key: "gone" })).body.expired, want);
  assertEquals((await call(s, "query", { agentId: "agent-1", caller: sameDomain })).body.expired, want);
  assertEquals((await call(s, "delete", { agentId: "agent-1", caller: sameDomain, key: "k" })).body.expired, want);
});

Deno.test("a refusal reports the entries its purge removed; other errors report []", async () => {
  const s = new FakeStore();
  s.seed({ key: "k", read_scope: "CREATOR_GENE_ONLY" });
  // What store.ts throws when an RPC returns {error, expired}.
  s.readEntry = () =>
    Promise.reject(new MemoryError("MEMORY_ACCESS_DENIED", "read denied: 'k' is CREATOR_GENE_ONLY", [{ entryId: "d".repeat(64) }]));
  const r = await call(s, "read", { agentId: "agent-1", caller: sameDomain, key: "k" });
  assertEquals(r.status, 403);
  assertEquals(r.body, {
    error: { code: "MEMORY_ACCESS_DENIED", message: "read denied: 'k' is CREATOR_GENE_ONLY" },
    expired: [{ entryId: "d".repeat(64) }],
  });
  const bad = await call(s, "read", { agentId: "agent-1", caller: sameDomain, key: "" });
  assertEquals(bad.status, 400);
  assertEquals(bad.body.expired, []);
});

Deno.test("write passes an explicit accessPolicy and retentionPolicy through", async () => {
  const s = new FakeStore();
  await call(s, "write", {
    agentId: "agent-1",
    caller: creator,
    key: "k",
    value: "",
    category: "CACHE",
    accessPolicy: { readScope: "ALL_GENES", writeScope: "CREATOR_GENE_ONLY", sharePolicy: "PRIVATE" },
    retentionPolicy: { maxRetentionDays: 30, autoDeleteOnTermination: true, anonymizationSupported: false },
  });
  assertEquals(
    [s.writes[0].readScope, s.writes[0].writeScope, s.writes[0].sharePolicy, s.writes[0].setRetention],
    ["ALL_GENES", "CREATOR_GENE_ONLY", "PRIVATE", true],
  );
  assertEquals(s.writes[0].retentionPolicy?.maxRetentionDays, 30);
});

Deno.test("overwriting someone else's entry is checked against its writeScope first", async () => {
  const s = new FakeStore();
  s.seed({ key: "plan", write_scope: "CREATOR_GENE_ONLY" });
  const r = await call(s, "write", { agentId: "agent-1", caller: sameDomain, key: "plan", value: "", category: "CONTEXT" });
  assertEquals(r.status, 403);
  assertEquals(r.body.error.code, "MEMORY_ACCESS_DENIED");
  assertEquals(s.writes.length, 0, "nothing reaches the database when the check fails");

  const ok = await call(s, "write", { agentId: "agent-1", caller: creator, key: "plan", value: "", category: "CONTEXT" });
  assertEquals(ok.status, 200);
});

Deno.test("only the creator gene may change an existing entry's accessPolicy", async () => {
  const s = new FakeStore();
  s.seed({ key: "plan", read_scope: "ALL_GENES", write_scope: "ALL_GENES" });
  const write = (caller: unknown, accessPolicy?: unknown) =>
    call(s, "write", { agentId: "agent-1", caller, key: "plan", value: "", category: "CONTEXT", accessPolicy });
  const narrowed = { readScope: "CREATOR_GENE_ONLY", writeScope: "CREATOR_GENE_ONLY", sharePolicy: "PRIVATE" };
  const same = { readScope: "ALL_GENES", writeScope: "ALL_GENES", sharePolicy: "PRIVATE" };

  const denied = await write(sameDomain, narrowed);
  assertEquals(denied.status, 403);
  assertEquals(denied.body.error.code, "MEMORY_ACCESS_DENIED");
  assertEquals(s.writes.length, 0);

  assertEquals((await write(sameDomain)).status, 200, "another gene may still write the value");
  assertEquals((await write(sameDomain, same)).status, 200, "resending the current policy is not a change");
  assertEquals((await write(creator, narrowed)).status, 200, "the creator may change it");
});

Deno.test("retentionPolicy: only the creator may change it or reset it to inherit (null)", async () => {
  const s = new FakeStore();
  const thirty = { maxRetentionDays: 30, autoDeleteOnTermination: true, anonymizationSupported: false };
  s.seed({ key: "r", write_scope: "ALL_GENES", retention_policy: thirty });
  const write = (caller: unknown, retentionPolicy: unknown) =>
    call(s, "write", { agentId: "agent-1", caller, key: "r", value: "", category: "CONTEXT", retentionPolicy });
  assertEquals((await write(sameDomain, null)).status, 403, "a non-creator cannot reset it to inherit");
  assertEquals((await write(sameDomain, { ...thirty, maxRetentionDays: 7 })).status, 403, "nor change it");
  assertEquals(s.writes.length, 0);
  assertEquals(
    (await write(sameDomain, { anonymizationSupported: false, maxRetentionDays: 30, autoDeleteOnTermination: true })).status,
    200,
    "resending the stored value is fine, in any key order",
  );
  assertEquals((await write(creator, null)).status, 200, "the creator may reset it");
});

Deno.test("a caller id that is not v2:<64 lowercase hex> is refused before anything is read or written", async () => {
  const s = new FakeStore();
  s.seed({ key: "k", read_scope: "ALL_GENES", write_scope: "ALL_GENES" });
  for (const geneId of ["gene-plain", "v2:" + "AA".repeat(32), "v2:" + "aa".repeat(31)]) {
    const caller = { geneId, domain: "search.web" };
    for (const [op, body] of [
      ["read", { agentId: "agent-1", caller, key: "k" }],
      ["write", { agentId: "agent-1", caller, key: "k", value: "", category: "CACHE" }],
      ["query", { agentId: "agent-1", caller }],
      ["delete", { agentId: "agent-1", caller, key: "k" }],
    ] as const) {
      const r = await call(s, op, body);
      assertEquals(r.status, 403, `${op} ${geneId}`);
      assertEquals(r.body.error.code, "MEMORY_ACCESS_DENIED");
    }
  }
  assertEquals([s.writes.length, s.touches.length, s.deletes.length], [0, 0, 0], "nothing recorded");
});

Deno.test("readScope or writeScope DEPLOYER_CONFIGURED cannot be set", async () => {
  const s = new FakeStore();
  for (const accessPolicy of [
    { readScope: "DEPLOYER_CONFIGURED", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" },
    { readScope: "SAME_DOMAIN", writeScope: "DEPLOYER_CONFIGURED", sharePolicy: "PRIVATE" },
  ]) {
    const r = await call(s, "write", { agentId: "agent-1", caller: creator, key: "k", value: "", category: "CONTEXT", accessPolicy });
    assertEquals(r.status, 403);
    assertEquals(r.body.error.code, "MEMORY_ACCESS_DENIED");
  }
  assertEquals(s.writes.length, 0);
});

Deno.test("read: SAME_DOMAIN admits the creator's domain and refuses others", async () => {
  const s = new FakeStore();
  s.seed({ key: "k" });
  const ok = await call(s, "read", { agentId: "agent-1", caller: sameDomain, key: "k" });
  assertEquals(ok.status, 200);
  assertEquals(ok.body.entry.lastAccessedBy, "v2:0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e");
  assertEquals(s.touches, ["k:v2:0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e"]);

  const denied = await call(s, "read", { agentId: "agent-1", caller: otherDomain, key: "k" });
  assertEquals(denied.status, 403);
  assertEquals(denied.body.error.code, "MEMORY_ACCESS_DENIED");
  assertEquals(s.touches.length, 1, "a denied read records no access");
});

Deno.test("read: CREATOR_GENE_ONLY, ALL_GENES and DEPLOYER_CONFIGURED", async () => {
  const s = new FakeStore();
  s.seed({ key: "mine", read_scope: "CREATOR_GENE_ONLY" });
  s.seed({ key: "open", read_scope: "ALL_GENES" });
  s.seed({ key: "dep", read_scope: "DEPLOYER_CONFIGURED" });
  const read = (key: string, caller: unknown) => call(s, "read", { agentId: "agent-1", caller, key });
  assertEquals((await read("mine", sameDomain)).status, 403);
  assertEquals((await read("mine", creator)).status, 200);
  assertEquals((await read("open", otherDomain)).status, 200);
  const dep = await read("dep", creator);
  assertEquals(dep.status, 403, "DEPLOYER_CONFIGURED is denied even to the creator in v0.9.4");
  assertEquals(dep.body.error.message.includes("§30.2"), true);
});

Deno.test("read: SAME_DOMAIN with no recorded domain falls back to the creator", async () => {
  const s = new FakeStore();
  s.seed({ key: "imported", created_by_domain: null });
  assertEquals((await call(s, "read", { agentId: "agent-1", caller: sameDomain, key: "imported" })).status, 403);
  assertEquals((await call(s, "read", { agentId: "agent-1", caller: creator, key: "imported" })).status, 200);
});

Deno.test("read of a missing key or another category returns entry: null, not an error", async () => {
  const s = new FakeStore();
  s.seed({ key: "k", category: "PATTERN" });
  assertEquals((await call(s, "read", { agentId: "agent-1", caller: sameDomain, key: "nope" })).body, { entry: null, expired: [] });
  assertEquals(
    (await call(s, "read", { agentId: "agent-1", caller: sameDomain, key: "k", category: "CACHE" })).body,
    { entry: null, expired: [] },
  );
});

Deno.test("query returns only what the caller may read, by exact prefix, newest first, up to the limit", async () => {
  const s = new FakeStore();
  s.seed({ key: "pref.a", updated_at: "2026-10-30T01:00:00Z" });
  s.seed({ key: "pref.b", updated_at: "2026-10-30T05:00:00Z", read_scope: "CREATOR_GENE_ONLY" });
  s.seed({ key: "pref.c", updated_at: "2026-10-30T03:00:00Z" });
  s.seed({ key: "pref*d" });
  s.seed({ key: "other" });
  const q = (filter: unknown, caller = sameDomain) => call(s, "query", { agentId: "agent-1", caller, filter });
  const keys = (r: { body: { entries: { key: string }[] } }) => r.body.entries.map((e) => e.key);
  assertEquals(keys(await q({ keyPrefix: "pref." })), ["pref.c", "pref.a"]);
  assertEquals(keys(await q({ keyPrefix: "pref*" })), ["pref*d"]);
  assertEquals(keys(await q({ keyPrefix: "pref.", limit: 1 })), ["pref.c"]);
  assertEquals((await q({}, otherDomain)).body.entries, []);
  assertEquals((await call(s, "query", { agentId: "agent-1", caller: sameDomain })).body.entries.length, 4,
    "no filter: every readable entry");
});

Deno.test("query returns at most 100 entries unless a limit is given", async () => {
  const s = new FakeStore();
  for (let i = 0; i < 150; i++) s.seed({ key: `k${String(i).padStart(3, "0")}` });
  const q = (filter: unknown) => call(s, "query", { agentId: "agent-1", caller: sameDomain, filter });
  assertEquals((await q({})).body.entries.length, 100);
  assertEquals((await q({ limit: 120 })).body.entries.length, 120);
});

Deno.test("a sharePolicy other than PRIVATE is refused before any query", async () => {
  const s = new FakeStore();
  for (const sharePolicy of ["ANONYMIZED_SHARE", "KNOWLEDGE_GENE"]) {
    const r = await call(s, "write", {
      agentId: "agent-1",
      caller: creator,
      key: "k",
      value: "",
      category: "CONTEXT",
      accessPolicy: { readScope: "SAME_DOMAIN", writeScope: "SAME_DOMAIN", sharePolicy },
    });
    assertEquals(r.status, 403);
    assertEquals(r.body.error.code, "MEMORY_ACCESS_DENIED");
  }
  assertEquals(s.writes.length, 0);
});

Deno.test("a denial names the caller's key and the scope, never the creator gene or its domain", async () => {
  const s = new FakeStore();
  s.seed({ key: "a", read_scope: "SAME_DOMAIN" });
  s.seed({ key: "b", read_scope: "CREATOR_GENE_ONLY" });
  for (const key of ["a", "b"]) {
    const r = await call(s, "read", { agentId: "agent-1", caller: otherDomain, key });
    assertEquals(r.status, 403);
    assertEquals(r.body.error.message.includes("v2:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"), false);
    assertEquals(r.body.error.message.includes("search.web"), false);
    assertEquals(r.body.error.message.includes(`'${key}'`), true);
  }
});

Deno.test("delete needs writeScope; a missing key is MEMORY_NOT_FOUND", async () => {
  const s = new FakeStore();
  s.seed({ key: "k", write_scope: "CREATOR_GENE_ONLY" });
  const denied = await call(s, "delete", { agentId: "agent-1", caller: sameDomain, key: "k" });
  assertEquals(denied.status, 403);
  assertEquals(s.deletes, []);
  const ok = await call(s, "delete", { agentId: "agent-1", caller: creator, key: "k" });
  assertEquals(ok.body, { deleted: { entryId: "k".padEnd(64, "0"), key: "k" }, expired: [] });
  const missing = await call(s, "delete", { agentId: "agent-1", caller: creator, key: "k" });
  assertEquals(missing.status, 404);
  assertEquals(missing.body.error.code, "MEMORY_NOT_FOUND");
});

Deno.test("register returns the container with quota and totalSize as numbers", async () => {
  const s = new FakeStore();
  const r = await call(s, "register", { agentId: "agent-1", quota: 2048 });
  assertEquals(r.body, { memory: { agentId: "agent-1", quota: 2048, totalSize: 0, createdAt: "2026-10-30T00:00:00.000Z" } });
});

Deno.test("a quota refusal from the database becomes 413 MEMORY_QUOTA_EXCEEDED", async () => {
  const s = new FakeStore();
  s.failWith = new DbError("53400", "MEMORY_QUOTA_EXCEEDED: writing 90 bytes would put agent agent-1 at 110 of 100 bytes");
  const r = await call(s, "write", { agentId: "agent-1", caller: creator, key: "big", value: "", category: "PREFERENCE" });
  assertEquals(r.status, 413);
  assertEquals(r.body.error, {
    code: "MEMORY_QUOTA_EXCEEDED",
    message: "writing 90 bytes would put agent agent-1 at 110 of 100 bytes",
  });
});

Deno.test("an unexpected database error is 500 MEMORY_STORAGE_ERROR without its details", async () => {
  const s = new FakeStore();
  s.failWith = new DbError("08006", "connection to 10.0.0.5 failed");
  const r = await call(s, "write", { agentId: "agent-1", caller: creator, key: "k", value: "", category: "CACHE" });
  assertEquals(r.status, 500);
  assertEquals(r.body.error, { code: "MEMORY_STORAGE_ERROR", message: "the memory store failed; try again later" });
});

Deno.test("bad requests are 400 MEMORY_INVALID_INPUT; non-POST is 405", async () => {
  const s = new FakeStore();
  assertEquals((await call(s, "write", { agentId: "agent-1", caller: creator, key: "k", value: "x", category: "CACHE" })).body.error.code, "MEMORY_INVALID_INPUT");
  assertEquals((await call(s, "nope", {})).status, 400);
  assertEquals((await call(s, "read", undefined, "GET")).status, 405);
  const notJson = await handle(new Request("http://localhost/functions/v1/agent-memory/read", { method: "POST", body: "{" }), s);
  assertEquals(notJson.status, 400);
});

Deno.test("a response body of exactly 4 MiB goes out; one byte more is refused", () => {
  // JSON.stringify of a string adds two quote characters.
  const exact = "x".repeat(4 * 1024 * 1024 - 2);
  assertEquals(new TextEncoder().encode(boundedBody(exact)).length, 4 * 1024 * 1024);
  let code = "";
  try {
    boundedBody(exact + "x");
  } catch (e) {
    code = (e as { code: string }).code;
  }
  assertEquals(code, "MEMORY_INVALID_INPUT");
});

Deno.test("a query whose results exceed 4 MiB is 400 MEMORY_INVALID_INPUT, not a cut-short list", async () => {
  const s = new FakeStore();
  // Five 1 MiB values: about 7 MiB once base64-encoded.
  for (let i = 0; i < 5; i++) s.seed({ key: `big${i}`, value: "\\x" + "ab".repeat(1024 * 1024) });
  const r = await call(s, "query", { agentId: "agent-1", caller: sameDomain });
  assertEquals(r.status, 400);
  assertEquals(r.body.error.code, "MEMORY_INVALID_INPUT");
  const small = await call(s, "query", { agentId: "agent-1", caller: sameDomain, filter: { limit: 2 } });
  assertEquals(small.status, 200);
  assertEquals(small.body.entries.length, 2);
});

Deno.test("the operation is the path segment after agent-memory", () => {
  assertEquals(opFromUrl("https://x.supabase.co/functions/v1/agent-memory/write"), "write");
  assertEquals(opFromUrl("http://localhost:54321/agent-memory/query?x=1"), "query");
  assertEquals(opFromUrl("https://x.supabase.co/functions/v1/agent-memory"), "");
});

Deno.test("jwtRole reads the role claim and refuses malformed headers", () => {
  const tok = (payload: unknown) =>
    "Bearer h." + btoa(JSON.stringify(payload)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_") + ".s";
  assertEquals(jwtRole(tok({ role: "authenticated", sub: "u" })), "authenticated");
  assertEquals(jwtRole(tok({ role: "anon" })), "anon");
  assertEquals(jwtRole(null), null);
  assertEquals(jwtRole("Bearer not-a-jwt"), null);
  assertEquals(jwtRole("Basic abc.def.ghi"), null);
});

