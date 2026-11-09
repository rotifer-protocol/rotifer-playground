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

Deno.test("consume calls the rate-limit function with the account and maps its answer", async () => {
  const f = fake([{ r: { ok: true } }]);
  assertEquals(await postgresStore(f.query).consume(RECORD.userId), { ok: true });
  assertEquals(f.calls, [{ text: "SELECT public.node_attestation_rate_consume($1::uuid) AS r", params: [RECORD.userId] }]);
  assertEquals(await postgresStore(fake([{ r: { error: "POR_RATE_LIMITED" } }]).query).consume(RECORD.userId), { error: "POR_RATE_LIMITED" });
  for (const r of [{}, { ok: false }, { error: "SOMETHING_ELSE" }]) {
    await assertRejects(() => postgresStore(fake([{ r }]).query).consume(RECORD.userId), PorError);
  }
});

Deno.test("POR_DB_URL must log in as por_issuer", () => {
  assertEquals(issuerUser("postgresql://por_issuer:pw@db.example:5432/postgres?sslmode=require"), "por_issuer");
  assertEquals(issuerUser("postgres://por_issuer.abcdefgh:pw@pooler.example:6543/postgres?sslmode=verify-full"), "por_issuer.abcdefgh");
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

Deno.test("POR_DB_URL outside this machine must require TLS", () => {
  const url = (host: string, query = "") => `postgresql://por_issuer:pw@${host}/postgres${query}`;

  // Local development and the test stack have no TLS and do not need it.
  for (const host of ["localhost", "localhost:54322", "127.0.0.1:54322", "127.8.8.8", "[::1]:5432", "db:5432"]) {
    assertEquals(issuerUser(url(host)), "por_issuer", host);
  }

  // Supabase's direct production host begins with "db.": only the bare
  // Compose service name "db" counts as local.
  for (
    const host of [
      "db.abcdefghijklmnopqrst.supabase.co:5432",
      "db.example",
      "db.",
      "dbx:5432",
      "aws-0-us-east-1.pooler.supabase.com:6543",
      "localhost.example",
      "127.0.0.1.example",
      "localhost,evil.example",
      "::ffff:7f00:1",
    ]
  ) {
    assertThrows(() => issuerUser(url(host)), Error, undefined, host);
  }

  // prefer and allow fall back to plain text; disable never starts TLS. The
  // driver reads the last value of a repeated parameter.
  for (
    const query of ["", "?sslmode=disable", "?sslmode=prefer", "?sslmode=allow", "?ssl=require", "?sslmode=require&sslmode=disable", "?sslmode=REQUIRE"]
  ) {
    assertThrows(() => issuerUser(url("db.abcdefghijklmnopqrst.supabase.co:5432", query)), Error, "sslmode", query);
  }

  for (const query of ["?sslmode=require", "?sslmode=verify-full", "?sslmode=disable&sslmode=require"]) {
    assertEquals(issuerUser(url("db.abcdefghijklmnopqrst.supabase.co:5432", query)), "por_issuer", query);
  }

  // The refusal must not repeat the connection string, which holds the password.
  assertThrows(() => {
    try {
      issuerUser("postgresql://por_issuer:SECRETPW@db.abcdefghijklmnopqrst.supabase.co:5432/postgres");
    } catch (err) {
      if ((err as Error).message.includes("SECRETPW")) throw new TypeError("message repeats the password");
      throw new RangeError((err as Error).message);
    }
  }, RangeError);
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
