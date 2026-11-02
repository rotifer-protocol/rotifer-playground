/**
 * store.ts with a recording fake query, and the function's credential
 * boundary. What the database functions do with the call is tested against
 * Postgres (supabase/tests/node_attestation.sql, race-check.sh, e2e.ts).
 */

import { assertEquals, assertMatch, assertRejects, assertThrows } from "jsr:@std/assert@1";
import { PorError } from "./handler.ts";
import { issuerUser, postgresStore, type Query } from "./store.ts";

function fake(rows: Record<string, unknown>[]): { query: Query; calls: { text: string; params: unknown[] }[] } {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    query: (text, params) => {
      calls.push({ text, params });
      return Promise.resolve(rows);
    },
  };
}

const NONCE_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const NONCE = Uint8Array.from({ length: 32 }, (_, i) => i);
const RECORD = {
  userId: "00000000-0000-4000-8000-000000000001",
  aud: "http://127.0.0.1:54321/functions/v1/node-attestation",
  nonce: NONCE,
  challengeExp: 1767225600,
  peerId: "12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB",
  sub: "a".repeat(43),
  iat: 1767225000,
  exp: 1767225000 + 604800,
  kid: "k1",
};

Deno.test("challenge calls node_attestation_challenge with the user and aud, and decodes the nonce", async () => {
  const f = fake([{ r: { nonce: NONCE_HEX, aud: RECORD.aud, challenge_exp: 1767225600 } }]);
  const out = await postgresStore(f.query).challenge(RECORD.userId, RECORD.aud);
  assertEquals(out, { nonce: NONCE, challengeExp: 1767225600 });
  assertEquals(f.calls.length, 1);
  assertMatch(f.calls[0].text, /^SELECT public\.node_attestation_challenge\(\$1::uuid, \$2::text\) AS r$/);
  assertEquals(f.calls[0].params, [RECORD.userId, RECORD.aud]);
});

Deno.test("issue passes all nine arguments in order, the nonce as hex decoded in SQL", async () => {
  const f = fake([{ r: { ok: true } }]);
  assertEquals(await postgresStore(f.query).issue(RECORD), { ok: true });
  assertMatch(f.calls[0].text, /public\.node_attestation_issue\(\$1::uuid, \$2::text, decode\(\$3::text, 'hex'\), \$4::bigint,/);
  assertEquals(f.calls[0].params, [
    RECORD.userId, RECORD.aud, NONCE_HEX, RECORD.challengeExp, RECORD.peerId, RECORD.sub, RECORD.iat, RECORD.exp, RECORD.kid,
  ]);
});

Deno.test("a refusal from the database comes back as its code", async () => {
  const store = postgresStore(fake([{ r: { error: "POR_QUOTA_EXCEEDED" } }]).query);
  assertEquals(await store.issue(RECORD), { error: "POR_QUOTA_EXCEEDED" });
  const ch = postgresStore(fake([{ r: { error: "POR_TOO_MANY_CHALLENGES" } }]).query);
  assertEquals(await ch.challenge(RECORD.userId, RECORD.aud), { error: "POR_TOO_MANY_CHALLENGES" });
});

Deno.test("anything else from the database is an internal error, never a success", async () => {
  for (const rows of [[], [{ r: null }], [{ r: [] }], [{ r: { ok: "true" } }], [{ r: { ok: true } }, { r: { ok: true } }], [{ r: { error: "SOMETHING" } }]]) {
    await assertRejects(() => postgresStore(fake(rows).query).issue(RECORD), PorError);
  }
  for (const r of [{ nonce: "zz", challenge_exp: 1 }, { nonce: NONCE_HEX, challenge_exp: "1" }, { nonce: NONCE_HEX.slice(2), challenge_exp: 1 }]) {
    await assertRejects(() => postgresStore(fake([{ r }]).query).challenge(RECORD.userId, RECORD.aud), PorError);
  }
});

Deno.test("POR_DB_URL must log in as por_issuer", () => {
  assertEquals(issuerUser("postgresql://por_issuer:pw@db.example:5432/postgres"), "por_issuer");
  assertEquals(issuerUser("postgres://por_issuer.abcdefgh:pw@pooler.example:6543/postgres"), "por_issuer.abcdefgh");
  for (const url of [
    "postgresql://postgres:pw@db.example:5432/postgres",
    "postgresql://service_role:pw@db.example:5432/postgres",
    "postgresql://por_issuer_admin:pw@db.example:5432/postgres",
    "postgresql://db.example:5432/postgres",
    "https://por_issuer:pw@db.example/",
    "not a url",
  ]) {
    assertThrows(() => issuerUser(url), Error, undefined, url);
  }
});

Deno.test("the function holds no service_role key", async () => {
  // The issuing role replaces it (deferred migration, "The issuing role").
  for (const file of ["index.ts", "store.ts", "handler.ts"]) {
    const src = await Deno.readTextFile(new URL(file, import.meta.url));
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY", "SUPABASE_SECRET_KEY"]) {
      if (code.includes(name)) throw new Error(`${file} reads ${name}; the function connects as por_issuer instead`);
    }
  }
});
