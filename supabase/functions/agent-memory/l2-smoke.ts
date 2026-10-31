/**
 * Contract check for agent-memory against a real local stack: the real
 * function, served by the
 * Supabase CLI, talking to the real migrated database — no mocks.
 *
 *   supabase start
 *   supabase functions serve agent-memory &     (verify_jwt = true from config.toml)
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=... JWT_SECRET=... \
 *   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     deno run --allow-net --allow-env --allow-run=psql supabase/functions/agent-memory/l2-smoke.ts
 *
 * The anon key and JWT secret are the local stack's (`supabase status`). With
 * gotrue excluded, `supabase status` prints no keys; the stack then signs with
 * the CLI's public default local secret, and an anon key can be minted with it
 * the same way mint() mints user tokens. SUPABASE_URL and DB_URL must point at
 * this machine (local-only.ts); anything else is refused before any call.
 * Two throwaway users are created in the local auth.users and removed at
 * the end. Exits non-zero on the first failed check.
 */

import { localUrl } from "./local-only.ts";

const URL_BASE = localUrl("SUPABASE_URL", Deno.env.get("SUPABASE_URL"), "http://127.0.0.1:54321");
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SECRET = Deno.env.get("JWT_SECRET")!;
const DB_URL = localUrl("DB_URL", Deno.env.get("DB_URL"), "postgresql://postgres:postgres@127.0.0.1:54322/postgres");

const A = "b2e11111-1111-4111-8111-111111111111";
const B = "b2e22222-2222-4222-8222-222222222222";
const AGENT = "l2-agent";

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function mint(sub: string): Promise<string> {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + 600 })));
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function psql(sql: string): Promise<void> {
  const out = await new Deno.Command("psql", { args: [DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql] }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

async function call(token: string, op: string, body: unknown) {
  const res = await fetch(`${URL_BASE}/functions/v1/agent-memory/${op}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let failures = 0;
function check(name: string, ok: boolean, got?: unknown) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `  got: ${JSON.stringify(got)}`}`);
  if (!ok) failures++;
}

const b64 = (s: string) => btoa(s);
const geneA = { geneId: "v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", domain: "ui.theme" };

await psql(`DELETE FROM auth.users WHERE id IN ('${A}', '${B}');
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('${A}', 'l2-memory-a@example.com', '{"user_name":"l2_memory_a"}'),
  ('${B}', 'l2-memory-b@example.com', '{"user_name":"l2_memory_b"}');`);

try {
  const ta = await mint(A);
  const tb = await mint(B);

  let r = await call(ta, "register", { agentId: AGENT, quota: 64 });
  check("register sets the quota", r.status === 200 && r.body.memory.quota === 64 && r.body.memory.totalSize === 0, r);

  r = await call(ta, "write", { agentId: AGENT, caller: geneA, key: "theme", value: b64("dark"), category: "PREFERENCE" });
  check("write returns the entry with a server-computed entryId",
    r.status === 200 && /^[0-9a-f]{64}$/.test(r.body.entry.entryId) && r.body.entry.value === b64("dark") &&
      r.body.entry.accessPolicy.readScope === "SAME_DOMAIN" && r.body.entry.createdBy === "v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", r);

  r = await call(ta, "read", { agentId: AGENT, caller: { geneId: "v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", domain: "ui.theme" }, key: "theme" });
  check("a same-domain gene reads it and is recorded as lastAccessedBy",
    r.status === 200 && r.body.entry?.lastAccessedBy === "v2:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", r);

  r = await call(ta, "read", { agentId: AGENT, caller: { geneId: "v2:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", domain: "finance.quote" }, key: "theme" });
  check("another domain is denied", r.status === 403 && r.body.error.code === "MEMORY_ACCESS_DENIED", r);

  r = await call(tb, "read", { agentId: AGENT, caller: geneA, key: "theme" });
  check("another account with the same agentId sees nothing", r.status === 200 && r.body.entry === null, r);
  r = await call(tb, "query", { agentId: AGENT, caller: geneA });
  check("...and its query is empty", r.status === 200 && r.body.entries.length === 0, r);

  // 64-byte quota; theme uses 9. A 30-byte CACHE fits, then a 30-byte PATTERN evicts it.
  await call(ta, "write", { agentId: AGENT, caller: geneA, key: "c1", value: b64("x".repeat(28)), category: "CACHE" });
  r = await call(ta, "write", { agentId: AGENT, caller: geneA, key: "p1", value: b64("y".repeat(28)), category: "PATTERN" });
  check("over quota, CACHE is evicted and reported",
    r.status === 200 && r.body.evicted.length === 1 && r.body.evicted[0].key === "c1", r);

  r = await call(ta, "write", { agentId: AGENT, caller: geneA, key: "big", value: b64("z".repeat(60)), category: "PREFERENCE" });
  check("a write that cannot fit is 413 MEMORY_QUOTA_EXCEEDED",
    r.status === 413 && r.body.error.code === "MEMORY_QUOTA_EXCEEDED", r);

  r = await call(ta, "query", { agentId: AGENT, caller: geneA, filter: { category: "PATTERN" } });
  check("query by category", r.status === 200 && r.body.entries.map((e: { key: string }) => e.key).join() === "p1", r);

  // Scope before LIMIT through the real RPC: the newer entry belongs to
  // another gene and is CREATOR_GENE_ONLY; '%' in the prefix is literal.
  const QA = "l2-query";
  await call(ta, "write", { agentId: QA, caller: geneA, key: "q%1", value: b64("1"), category: "CONTEXT" });
  await call(ta, "write", { agentId: QA, caller: geneA, key: "qx9", value: b64("9"), category: "CONTEXT" });
  await call(ta, "write", {
    agentId: QA,
    caller: { geneId: "v2:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", domain: "other.d" },
    key: "q%2",
    value: b64("2"),
    category: "CONTEXT",
    accessPolicy: { readScope: "CREATOR_GENE_ONLY", writeScope: "CREATOR_GENE_ONLY", sharePolicy: "PRIVATE" },
  });
  r = await call(ta, "query", { agentId: QA, caller: geneA, filter: { keyPrefix: "q%", limit: 1 } });
  check("query: limit counts readable entries only, and '%' is not a wildcard",
    r.status === 200 && r.body.entries.map((e: { key: string }) => e.key).join() === "q%1", r);
  r = await call(ta, "query", { agentId: QA, caller: geneA, filter: { since: "2000-01-01T00:00:00Z" } });
  check("query: since/until reach the database as timestamps",
    r.status === 200 && r.body.entries.length === 2, r);

  r = await call(ta, "write", { agentId: AGENT, caller: geneA, key: "k", value: b64("v"), category: "cache" });
  check("a lowercase category is 400 MEMORY_INVALID_INPUT", r.status === 400 && r.body.error.code === "MEMORY_INVALID_INPUT", r);

  r = await call(ANON, "read", { agentId: AGENT, caller: geneA, key: "theme" });
  check("the bare anon key is refused", r.status === 403 && r.body.error.code === "MEMORY_ACCESS_DENIED", r);

  r = await call(ta, "delete", { agentId: AGENT, caller: geneA, key: "p1" });
  check("delete", r.status === 200 && r.body.deleted.key === "p1", r);
  r = await call(ta, "delete", { agentId: AGENT, caller: geneA, key: "p1" });
  check("deleting again is 404 MEMORY_NOT_FOUND", r.status === 404 && r.body.error.code === "MEMORY_NOT_FOUND", r);
} finally {
  await psql(`DELETE FROM agent_memory_containers WHERE owner_id IN ('${A}', '${B}');
    DELETE FROM auth.users WHERE id IN ('${A}', '${B}');`);
}

console.log(failures === 0 ? "L2: all checks passed" : `L2: ${failures} check(s) failed`);
Deno.exit(failures === 0 ? 0 : 1);
