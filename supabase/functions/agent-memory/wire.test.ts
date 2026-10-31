import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  base64ToBytes,
  byteaToBytes,
  bytesToBase64,
  bytesToBytea,
  type EntryRow,
  mapDbError,
  MemoryError,
  parseRequest,
  rowToEntry,
} from "./wire.ts";

const caller = { geneId: "gene-a", domain: "ui.theme" };

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof MemoryError) return e.code;
    throw e;
  }
  throw new Error("expected a MemoryError");
}

const row: EntryRow = {
  entry_id: "6a9439755781cf822bc231bb18113eca746a71cdea14a6ba74b0be29fd352b52",
  agent_id: "agent-1",
  category: "PREFERENCE",
  key: "theme",
  value: "\\x6461726b",
  created_by: "gene-a",
  created_by_domain: "ui.theme",
  last_accessed_by: null,
  created_at: "2026-10-30T14:00:00.123456+00:00",
  updated_at: "2026-10-30T15:30:00+00:00",
  read_scope: "SAME_DOMAIN",
  write_scope: "CREATOR_GENE_ONLY",
  share_policy: "PRIVATE",
  retention_policy: null,
};

Deno.test("a row maps to the §38.1 MemoryEntry wire shape: camelCase, base64 value, RFC 3339 UTC", () => {
  const e = rowToEntry(row);
  assertEquals(Object.keys(e), [
    "entryId", "category", "key", "value", "createdBy", "lastAccessedBy",
    "createdAt", "updatedAt", "accessPolicy", "retentionPolicy",
  ]);
  assertEquals(e.value, "ZGFyaw=="); // "dark"
  assertEquals(e.createdAt, "2026-10-30T14:00:00.123Z");
  assertEquals(e.updatedAt, "2026-10-30T15:30:00.000Z");
  assertEquals(e.accessPolicy, { readScope: "SAME_DOMAIN", writeScope: "CREATOR_GENE_ONLY", sharePolicy: "PRIVATE" });
  assertEquals(e.retentionPolicy, null);
  // created_by_domain is internal, never on the wire.
  assertEquals("createdByDomain" in e, false);
});

Deno.test("bytes survive base64 and bytea round trips, including every byte value", () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assertEquals(base64ToBytes(bytesToBase64(all)), all);
  assertEquals(byteaToBytes(bytesToBytea(all)), all);
  assertEquals(bytesToBytea(new Uint8Array([0, 255, 16])), "\\x00ff10");
  assertEquals(base64ToBytes(""), new Uint8Array(0));
});

Deno.test("value must be standard padded base64", () => {
  assertEquals(code(() => base64ToBytes("ZGFyaw")), "MEMORY_INVALID_INPUT"); // unpadded
  assertEquals(code(() => base64ToBytes("ZGFy_w==")), "MEMORY_INVALID_INPUT"); // url-safe alphabet
  assertEquals(code(() => base64ToBytes("not base64!")), "MEMORY_INVALID_INPUT");
});

Deno.test("write parses the contract fields and leaves policy and retention unset when absent", () => {
  const r = parseRequest("write", {
    agentId: "0d4f4c1e-9a7b-4c1a-8e2f-1234567890ab",
    caller,
    key: "theme",
    value: "ZGFyaw==",
    category: "PREFERENCE",
  });
  if (r.op !== "write") throw new Error("op");
  assertEquals(r.value, new TextEncoder().encode("dark"));
  assertEquals(r.accessPolicy, undefined);
  assertEquals("retentionPolicy" in r, false);
});

Deno.test("a value of exactly 1 MiB is accepted; one byte more is refused, not truncated", () => {
  const write = (n: number) =>
    parseRequest("write", {
      agentId: "a",
      caller,
      key: "k",
      value: bytesToBase64(new Uint8Array(n)),
      category: "CACHE",
    });
  const ok = write(1048576);
  if (ok.op !== "write") throw new Error("op");
  assertEquals(ok.value.length, 1048576);
  assertEquals(code(() => write(1048577)), "MEMORY_INVALID_INPUT");
});

Deno.test("retentionPolicy is null or exactly the three §30.2 fields (pgTAP RV1-RV5)", () => {
  const write = (retentionPolicy: unknown) =>
    parseRequest("write", { agentId: "a", caller, key: "k", value: "", category: "CACHE", retentionPolicy });
  const ok = { maxRetentionDays: 30, autoDeleteOnTermination: true, anonymizationSupported: false };
  const accepted = write(ok);
  if (accepted.op !== "write") throw new Error("op");
  assertEquals(accepted.retentionPolicy, ok);
  assertEquals(write({ ...ok, maxRetentionDays: null }).op, "write");
  assertEquals(write({ ...ok, maxRetentionDays: 2147483647 }).op, "write");
  assertEquals(write(null).op, "write");
  const bad = [
    { maxRetentionDays: 30, autoDeleteOnTermination: true }, // missing
    { ...ok, note: "x" }, // extra
    { ...ok, maxRetentionDays: 0 },
    { ...ok, maxRetentionDays: 1.5 },
    { ...ok, maxRetentionDays: 2147483648 },
    { ...ok, maxRetentionDays: "30" },
    { ...ok, autoDeleteOnTermination: "yes" },
    { ...ok, anonymizationSupported: null },
    [],
    "forever",
  ];
  for (const r of bad) assertEquals(code(() => write(r)), "MEMORY_INVALID_INPUT", JSON.stringify(r));
});

Deno.test("write distinguishes retentionPolicy: null (clear) from absent (keep)", () => {
  const base = { agentId: "a", caller, key: "k", value: "", category: "CACHE" };
  const cleared = parseRequest("write", { ...base, retentionPolicy: null });
  if (cleared.op !== "write") throw new Error("op");
  assertEquals("retentionPolicy" in cleared, true);
  assertEquals(cleared.retentionPolicy, null);
  assertEquals(code(() => parseRequest("write", { ...base, retentionPolicy: 30 })), "MEMORY_INVALID_INPUT");
  const kept = parseRequest("write", base);
  if (kept.op !== "write") throw new Error("op");
  assertEquals("retentionPolicy" in kept, false);
});

Deno.test("enum values are the spec's UPPERCASE spellings only", () => {
  const base = { agentId: "a", caller, key: "k", value: "" };
  assertEquals(code(() => parseRequest("write", { ...base, category: "preference" })), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("write", { ...base, category: "MEMORY" })), "MEMORY_INVALID_INPUT");
  assertEquals(
    code(() =>
      parseRequest("write", {
        ...base,
        category: "CACHE",
        accessPolicy: { readScope: "same_domain", writeScope: "SAME_DOMAIN", sharePolicy: "PRIVATE" },
      })
    ),
    "MEMORY_INVALID_INPUT",
  );
});

Deno.test("unknown fields are refused, so contract drift fails loudly", () => {
  assertEquals(code(() => parseRequest("read", { agentId: "a", caller, key: "k", agent_id: "a" })), "MEMORY_INVALID_INPUT");
  // Since/until only; no binding accepts the alias names.
  for (const alias of ["from", "to", "timeField", "updatedAfter", "updatedBefore"]) {
    assertEquals(
      code(() => parseRequest("query", { agentId: "a", caller, filter: { [alias]: "2026-10-30T00:00:00Z" } })),
      "MEMORY_INVALID_INPUT",
      alias,
    );
  }
  assertEquals(code(() => parseRequest("read", { agentId: "a", caller: { ...caller, role: "x" }, key: "k" })), "MEMORY_INVALID_INPUT");
});

Deno.test("keys are 1–1024 bytes of UTF-8 without NUL", () => {
  const read = (key: unknown) => parseRequest("read", { agentId: "a", caller, key });
  assertEquals(code(() => read("")), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => read("a\0b")), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => read("é".repeat(513))), "MEMORY_INVALID_INPUT"); // 1026 bytes
  assertEquals(read("é".repeat(512)).op, "read"); // 1024 bytes
  assertEquals(code(() => read(42)), "MEMORY_INVALID_INPUT");
});

Deno.test("agent ids and caller identity are validated", () => {
  assertEquals(code(() => parseRequest("read", { agentId: "", caller, key: "k" })), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("read", { agentId: "../x", caller, key: "k" })), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("read", { agentId: "a", key: "k" })), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("read", { agentId: "a", caller: { geneId: "g" }, key: "k" })), "MEMORY_INVALID_INPUT");
});

Deno.test("register accepts a positive whole-byte quota up to 100 MiB", () => {
  assertEquals(parseRequest("register", { agentId: "a", quota: 10485760 }), { op: "register", agentId: "a", quota: 10485760 });
  assertEquals(parseRequest("register", { agentId: "a" }), { op: "register", agentId: "a" });
  assertEquals(code(() => parseRequest("register", { agentId: "a", quota: 0 })), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("register", { agentId: "a", quota: -1 })), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("register", { agentId: "a", quota: 1.5 })), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("register", { agentId: "a", quota: "10MB" })), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("register", { agentId: "a", quota: 104857601 })), "MEMORY_INVALID_INPUT");
});

Deno.test("query filter takes RFC 3339 since/until and a bounded limit", () => {
  const q = parseRequest("query", {
    agentId: "a",
    caller,
    filter: { category: "PATTERN", keyPrefix: "pref.", since: "2026-10-30T08:00:00+08:00", until: "2026-10-31T00:00:00Z", limit: 5 },
  });
  if (q.op !== "query") throw new Error("op");
  assertEquals(q.filter, {
    category: "PATTERN",
    keyPrefix: "pref.",
    since: "2026-10-30T00:00:00.000Z",
    until: "2026-10-31T00:00:00.000Z",
    limit: 5,
  });
  const empty = parseRequest("query", { agentId: "a", caller });
  if (empty.op !== "query") throw new Error("op");
  assertEquals(empty.filter, {}, "the filter is optional");
  const bad = (filter: unknown) => code(() => parseRequest("query", { agentId: "a", caller, filter }));
  assertEquals(bad({ since: 1730246400000 }), "MEMORY_INVALID_INPUT"); // a bare number is not a timestamp
  assertEquals(bad({ until: "yesterday" }), "MEMORY_INVALID_INPUT");
  assertEquals(bad({ limit: 0 }), "MEMORY_INVALID_INPUT");
  assertEquals(bad({ limit: 1001 }), "MEMORY_INVALID_INPUT");
});

Deno.test("unknown operations and non-object bodies are refused", () => {
  assertEquals(code(() => parseRequest("drop", {})), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("read", [])), "MEMORY_INVALID_INPUT");
  assertEquals(code(() => parseRequest("read", null)), "MEMORY_INVALID_INPUT");
});

Deno.test("database errors map to the contract codes", () => {
  assertEquals(mapDbError("53400", "MEMORY_QUOTA_EXCEEDED: writing 90 bytes ...")?.code, "MEMORY_QUOTA_EXCEEDED");
  assertEquals(mapDbError("53400", "MEMORY_QUOTA_EXCEEDED: writing 90 bytes ...")?.message, "writing 90 bytes ...");
  assertEquals(mapDbError("23503", "MEMORY_NOT_FOUND: agent x has no memory")?.code, "MEMORY_NOT_FOUND");
  assertEquals(mapDbError("42501", "this account is closed and can no longer write")?.code, "MEMORY_ACCESS_DENIED");
  assertEquals(mapDbError("42501", "permission denied for table agent_memory_entries")?.code, "MEMORY_ACCESS_DENIED");
  assertEquals(mapDbError("23514", "violates check constraint")?.code, "MEMORY_INVALID_INPUT");
  assertEquals(mapDbError("22P02", "invalid input value for enum")?.code, "MEMORY_INVALID_INPUT");
  assertEquals(mapDbError("08006", "connection failure"), null);
});

Deno.test("raw Postgres messages never reach the client; the migration's own messages do", () => {
  const raw = [
    ["23503", 'insert or update on table "agent_memory_entries" violates foreign key constraint "agent_memory_entries_owner_id_agent_id_fkey" Key (owner_id, agent_id)=(a7e1…, agent-1)'],
    ["23514", 'new row for relation "agent_memory_containers" violates check constraint "agent_memory_containers_quota_bytes_check"'],
    ["42501", 'new row violates row-level security policy for table "agent_memory_entries"'],
    ["22P02", 'invalid input value for enum memory_category: "cache"'],
  ];
  for (const [c, m] of raw) {
    const e = mapDbError(c, m)!;
    assertEquals(/agent_memory|Key \(|constraint|policy|enum/.test(e.message), false, e.message);
  }
  assertEquals(mapDbError("42501", "this account is closed and can no longer write")?.message,
    "this account is closed and can no longer write");
  assertEquals(mapDbError("42501", "MEMORY_ACCESS_DENIED: sharePolicy KNOWLEDGE_GENE needs ...")?.message,
    "sharePolicy KNOWLEDGE_GENE needs ...");
});

Deno.test("an unexpected bytea text from the database is an error, not silent garbage", () => {
  assertThrows(() => byteaToBytes("ZGFyaw=="));
});
