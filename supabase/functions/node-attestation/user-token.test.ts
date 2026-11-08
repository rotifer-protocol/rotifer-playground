/**
 * The local check on the caller's token, through the real handler: a token
 * that fails it must get a 401 without the function ever asking Supabase Auth.
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { type AttestationStore, type Deps, handle } from "./handler.ts";
import { b64url } from "./por.ts";
import { authenticator, fetchProjectJwks, userTokenCheck } from "./user-token.ts";

const USER = "0b1d8a0e-6a1f-4c55-9a0c-7f1e2d3c4b5a";
const NOW = 1767225600;
const enc = new TextEncoder();
const part = (v: unknown) => b64url(enc.encode(JSON.stringify(v)));

async function esKey(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty, crv, x, y, kid, alg: "ES256", use: "sig", key_ops: ["verify"] } };
}
type EsKey = Awaited<ReturnType<typeof esKey>>;

const claims = (over: Record<string, unknown> = {}) => ({ sub: USER, role: "authenticated", aud: "authenticated", exp: NOW + 3600, ...over });

async function token(key: EsKey, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const input = `${part({ alg: "ES256", typ: "JWT", kid: key.kid, ...header })}.${part(claims(over))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/** A clock, a counted JWKS source and a counted Auth, wired through the real handler. */
async function setup(opts: { jwks?: () => Promise<unknown>; authAnswer?: string | null } = {}) {
  const key = await esKey("k1");
  const t = {
    key,
    now: NOW,
    jwks: { keys: [key.jwk] } as unknown,
    jwksFetches: 0,
    authCalls: 0,
    challenges: 0,
    deps: {} as Deps,
    send: (authorization?: string) => {
      const headers: Record<string, string> = authorization === undefined ? {} : { Authorization: authorization };
      return handle(new Request("http://localhost/node-attestation/challenge", { method: "POST", headers, body: "{}" }), t.deps);
    },
  };
  const store: AttestationStore = {
    consume: () => Promise.resolve({ ok: true }),
    challenge: () => {
      t.challenges++;
      return Promise.resolve({ nonce: new Uint8Array(32), challengeExp: NOW + 300 });
    },
    issue: () => Promise.resolve({ ok: true }),
  };
  const check = userTokenCheck(() => {
    t.jwksFetches++;
    return opts.jwks ? opts.jwks() : Promise.resolve(t.jwks);
  }, () => t.now);
  t.deps = {
    authenticate: authenticator(check, () => {
      t.authCalls++;
      return Promise.resolve(opts.authAnswer === undefined ? USER : opts.authAnswer);
    }),
    store,
    signer: {} as Deps["signer"],
    pseudonymKey: {} as CryptoKey,
    aud: "http://localhost/node-attestation",
    nowSeconds: () => t.now,
  };
  return t;
}

async function refused(t: Awaited<ReturnType<typeof setup>>, authorization: string | undefined, why: string) {
  const res = await t.send(authorization);
  assertEquals(res.status, 401, why);
  assertEquals((await res.json()).error.code, "POR_UNAUTHENTICATED", why);
  assertEquals(t.authCalls, 0, `${why}: Supabase Auth must not be called`);
  assertEquals(t.challenges, 0, why);
}

Deno.test("a valid ES256 token gets in, and Auth still has the last word", async () => {
  const t = await setup();
  const res = await t.send(`Bearer ${await token(t.key)}`);
  assertEquals(res.status, 200);
  assertEquals([t.authCalls, t.challenges], [1, 1]);
  const revoked = await setup({ authAnswer: null });
  assertEquals((await revoked.send(`Bearer ${await token(revoked.key)}`)).status, 401, "a session Auth has revoked is refused");
  assertEquals(revoked.challenges, 0);
});

Deno.test("no Authorization header, or not a bearer token: 401 without calling Auth", async () => {
  const t = await setup();
  await refused(t, undefined, "no header");
  await refused(t, "Basic abc", "not bearer");
  await refused(t, "Bearer ", "empty");
  await refused(t, "Bearer a.b", "two parts");
  await refused(t, "Bearer a.b.c.d", "four parts");
  await refused(t, "Bearer sb_publishable_abc", "an API key is not a user token");
  await refused(t, `Bearer ${"a".repeat(9000)}.b.c`, "too long");
  assertEquals(t.jwksFetches, 0, "nothing shaped wrong is worth fetching keys for");
});

Deno.test("a wrong signature or a changed payload: 401 without calling Auth", async () => {
  const t = await setup();
  const attacker = await esKey("k1");
  await refused(t, `Bearer ${await token(attacker)}`, "signed by another key under the same kid");
  const [h, , s] = (await token(t.key)).split(".");
  await refused(t, `Bearer ${h}.${part(claims({ sub: "someone-else" }))}.${s}`, "payload changed after signing");
  await refused(t, `Bearer ${h}.${part(claims())}.${b64url(new Uint8Array(64))}`, "zero signature");
  await refused(t, `Bearer ${h}.${part(claims())}.${b64url(new Uint8Array(32))}`, "short signature");
});

Deno.test("an expired token: 401 without calling Auth, down to the second", async () => {
  const t = await setup();
  await refused(t, `Bearer ${await token(t.key, { exp: NOW - 1 })}`, "expired");
  await refused(t, `Bearer ${await token(t.key, { exp: NOW })}`, "exp is now");
  await refused(t, `Bearer ${await token(t.key, { exp: "9999999999" })}`, "exp not a number");
  const { exp: _, ...noExp } = claims();
  const input = `${part({ alg: "ES256", kid: "k1" })}.${part(noExp)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, t.key.privateKey, enc.encode(input));
  await refused(t, `Bearer ${input}.${b64url(new Uint8Array(sig))}`, "no exp");
});

Deno.test("alg none and a forged HS256 token: 401 without calling Auth or fetching keys", async () => {
  const t = await setup();
  await refused(t, `Bearer ${part({ alg: "none", kid: "k1" })}.${part(claims())}.`, "alg none");
  await refused(t, `Bearer ${part({ alg: "None", kid: "k1" })}.${part(claims())}.${b64url(new Uint8Array(64))}`, "alg None");
  // The classic confusion: HS256 keyed with the public key's own text.
  const secret = await crypto.subtle.importKey("raw", enc.encode(JSON.stringify(t.key.jwk)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const input = `${part({ alg: "HS256", kid: "k1" })}.${part(claims())}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", secret, enc.encode(input)));
  await refused(t, `Bearer ${input}.${b64url(mac)}`, "HS256 keyed with the public key");
  await refused(t, `Bearer ${await token(t.key, {}, { alg: "RS256" })}`, "another algorithm in the header");
  await refused(t, `Bearer ${await token(t.key, {}, { crit: ["b64"] })}`, "a critical header it does not know");
  assertEquals(t.jwksFetches, 0);
});

Deno.test("a token that is not a signed-in user's: 401 without calling Auth", async () => {
  const t = await setup();
  await refused(t, `Bearer ${await token(t.key, { role: "anon" })}`, "anon role");
  await refused(t, `Bearer ${await token(t.key, { role: "service_role" })}`, "service role");
  await refused(t, `Bearer ${await token(t.key, { sub: "" })}`, "empty sub");
  await refused(t, `Bearer ${await token(t.key, {}, { kid: undefined })}`, "no kid");
});

Deno.test("keys are cached for 10 minutes, no longer", async () => {
  const t = await setup();
  const jwt = `Bearer ${await token(t.key)}`;
  await t.send(jwt);
  t.now += 599;
  assertEquals((await t.send(jwt)).status, 200);
  assertEquals(t.jwksFetches, 1, "inside 10 minutes the cached keys serve");
  t.now = NOW + 600;
  const fresh = `Bearer ${await token(t.key, { exp: NOW + 7200 })}`;
  assertEquals((await t.send(fresh)).status, 200);
  assertEquals(t.jwksFetches, 2, "at 10 minutes they are fetched again");
  t.jwks = { keys: [] };
  t.now += 600;
  assertEquals((await t.send(fresh)).status, 500, "a key removed upstream is not honoured from a stale cache");
});

Deno.test("an unknown kid fetches keys at most once a minute, and picks up a rotated key", async () => {
  const t = await setup();
  await t.send(`Bearer ${await token(t.key)}`);
  assertEquals(t.jwksFetches, 1);
  const stranger = await esKey("nobody");
  t.now += 30;
  const before = t.authCalls;
  assertEquals((await t.send(`Bearer ${await token(stranger)}`)).status, 401);
  assertEquals(t.jwksFetches, 1, "under a minute since the last fetch: no new fetch");
  t.now += 30;
  assertEquals((await t.send(`Bearer ${await token(stranger)}`)).status, 401);
  assertEquals(t.jwksFetches, 2, "a minute on: one fetch");
  assertEquals((await t.send(`Bearer ${await token(stranger)}`)).status, 401);
  assertEquals(t.jwksFetches, 2, "and not another straight after");
  assertEquals(t.authCalls, before, "an unknown key never reaches Auth");
  const rotated = await esKey("k2");
  t.jwks = { keys: [t.key.jwk, rotated.jwk] };
  t.now += 60;
  assertEquals((await t.send(`Bearer ${await token(rotated)}`)).status, 200, "a newly published key is picked up");
});

Deno.test("when the keys cannot be had, nothing gets in and Auth is not called", async () => {
  for (
    const [why, jwks] of [
      ["fetch fails", () => Promise.reject(new Error("network"))],
      ["no keys", () => Promise.resolve({ keys: [] })],
      ["not a key set", () => Promise.resolve({ nope: true })],
      ["only a shared secret", () => Promise.resolve({ keys: [{ kty: "oct", k: "c2VjcmV0", kid: "k1", alg: "HS256" }] })],
      ["only another curve", () => Promise.resolve({ keys: [{ kty: "EC", crv: "P-384", x: "AA", y: "AA", kid: "k1" }] })],
    ] as [string, () => Promise<unknown>][]
  ) {
    const t = await setup({ jwks });
    const res = await t.send(`Bearer ${await token(t.key)}`);
    assertEquals(res.status, 500, why);
    assertEquals((await res.json()).error.code, "POR_INTERNAL", why);
    assertEquals([t.authCalls, t.challenges], [0, 0], why);
  }
});

Deno.test("a stale key set is not used when the refresh fails, and a failing source is not hammered", async () => {
  let fail = false;
  const t = await setup({ jwks: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve(t.jwks)) });
  const jwt = `Bearer ${await token(t.key)}`;
  assertEquals((await t.send(jwt)).status, 200);
  fail = true;
  t.now += 600;
  assertEquals((await t.send(jwt)).status, 500, "stale keys are not trusted");
  assertEquals(t.jwksFetches, 2);
  assertEquals((await t.send(jwt)).status, 500);
  assertEquals(t.jwksFetches, 2, "no second attempt within 5 seconds");
  t.now += 5;
  fail = false;
  assertEquals((await t.send(jwt)).status, 200, "it recovers");
  assertEquals(t.jwksFetches, 3);
});

Deno.test("concurrent requests share one key fetch", async () => {
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const t = await setup({ jwks: () => gate.then(() => t.jwks) });
  const jwt = `Bearer ${await token(t.key)}`;
  const all = Promise.all([t.send(jwt), t.send(jwt), t.send(jwt)]);
  release();
  assertEquals((await all).map((r) => r.status), [200, 200, 200]);
  assertEquals(t.jwksFetches, 1);
});

Deno.test("fetchProjectJwks reads the project's published keys and treats a bad answer as a failure", async () => {
  const real = globalThis.fetch;
  try {
    const seen: string[] = [];
    let status = 200;
    globalThis.fetch = ((input: string, init?: RequestInit) => {
      seen.push(String(input));
      assertEquals(init?.redirect, "error");
      assert(init?.signal instanceof AbortSignal, "a stalled key server must not hang the request");
      return Promise.resolve(new Response('{"keys":[]}', { status }));
    }) as typeof fetch;
    assertEquals(await fetchProjectJwks("https://example.supabase.co")(), { keys: [] });
    assertEquals(seen, ["https://example.supabase.co/auth/v1/.well-known/jwks.json"]);
    status = 503;
    await assertRejects(() => fetchProjectJwks("https://example.supabase.co")());
  } finally {
    globalThis.fetch = real;
  }
});

Deno.test("index.ts checks the token locally before asking Auth", async () => {
  const code = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(/authenticate:\s*authenticator\(\s*userTokenCheck\(fetchProjectJwks\(url\)/.test(code), "index.ts must build authenticate from the local check");
  assertEquals(code.match(/getUser\(/g)?.length, 1, "one call to Auth, inside the authenticator");
});
