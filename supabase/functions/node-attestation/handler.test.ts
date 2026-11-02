/**
 * Handler tests with a recording fake store. The rules that live in the
 * database (single-use nonce, per-account limit, rebinding, account checks)
 * are tested against Postgres: supabase/tests/node_attestation.sql,
 * race-check.sh and e2e.ts. Here: what the function itself must get right.
 */

import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1";
import { type AttestationStore, type Deps, type ErrorCode, handle, type IssueRecord, PorError, storeCode } from "./handler.ts";
import {
  b64url,
  type Bytes,
  challengeMessage,
  fromB64url,
  importPseudonymKey,
  importSigningJwk,
  ISSUER,
  type Jwk,
  libp2pPublicKey,
  peerIdFromPublicKey,
  pseudonym,
  TTL_SECONDS,
  verifyToken,
} from "./por.ts";

const USER = "0b1d8a0e-6a1f-4c55-9a0c-7f1e2d3c4b5a";
const AUD = "http://127.0.0.1:54321/functions/v1/node-attestation";
const NOW = 1767225600;

async function nodeKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pb = libp2pPublicKey(raw);
  return {
    pb,
    peerId: peerIdFromPublicKey(pb)!,
    sign: async (msg: Bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, msg)),
  };
}

async function setup(opts: { issueResult?: { ok: true } | { error: ErrorCode }; user?: string | null } = {}) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const signer = await importSigningJwk({ ...priv, kid: "k-test" });
  const jwk: Jwk = { kty: "OKP", crv: "Ed25519", x: pub.x, kid: "k-test" };
  const pseudonymKey = await importPseudonymKey(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const issued: IssueRecord[] = [];
  const challenges: { userId: string; aud: string }[] = [];
  const store: AttestationStore = {
    challenge(userId, aud) {
      challenges.push({ userId, aud });
      return Promise.resolve({ nonce, challengeExp: NOW + 300 });
    },
    issue(r) {
      issued.push(r);
      return Promise.resolve(opts.issueResult ?? { ok: true });
    },
  };
  const deps: Deps = {
    authenticate: (h) => Promise.resolve(h === "Bearer good" ? (opts.user === undefined ? USER : opts.user) : null),
    store,
    signer,
    pseudonymKey,
    aud: AUD,
    nowSeconds: () => NOW,
  };
  return { deps, jwk, nonce, issued, challenges, pseudonymKey };
}

function post(op: string, body: unknown, auth = "Bearer good"): Request {
  return new Request(`http://localhost/node-attestation/${op}`, {
    method: "POST",
    headers: { Authorization: auth, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function issueBody(node: Awaited<ReturnType<typeof nodeKey>>, nonce: Bytes, opts: { user?: string; aud?: string; exp?: number } = {}) {
  const exp = opts.exp ?? NOW + 300;
  const msg = challengeMessage(opts.aud ?? AUD, opts.user ?? USER, nonce, exp);
  return { publicKey: b64url(node.pb), signature: b64url(await node.sign(msg)), nonce: b64url(nonce), challengeExp: exp };
}

async function errorCode(res: Response): Promise<string> {
  return (await res.json()).error.code;
}

Deno.test("challenge: returns the store's nonce as base64url, this function's aud and the deadline", async () => {
  const t = await setup();
  const res = await handle(post("challenge", {}), t.deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { nonce: b64url(t.nonce), aud: AUD, challengeExp: NOW + 300 });
  assertEquals(t.challenges, [{ userId: USER, aud: AUD }]);
});

Deno.test("end to end through the handler: the token verifies and binds the PeerId derived from the key", async () => {
  const t = await setup();
  const node = await nodeKey();
  const res = await handle(post("issue", await issueBody(node, t.nonce)), t.deps);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(Object.keys(body), ["token", "peerId", "iat", "exp"]);
  assertEquals(body.peerId, node.peerId);
  assertEquals([body.iat, body.exp], [NOW, NOW + TTL_SECONDS]);
  const v = await verifyToken(body.token, { issuer: ISSUER, keys: [t.jwk] }, NOW);
  assert(v.ok && !v.expired);
  assertEquals(v.claims.peer_id, node.peerId);
  assertEquals(t.issued.length, 1);
  assertEquals({ ...t.issued[0], nonce: b64url(t.issued[0].nonce) }, {
    userId: USER,
    aud: AUD,
    nonce: b64url(t.nonce),
    challengeExp: NOW + 300,
    peerId: node.peerId,
    sub: v.claims.sub,
    iat: NOW,
    exp: NOW + TTL_SECONDS,
    kid: "k-test",
  });
});

Deno.test("P0: neither the token nor the response carries the user id; sub is the HMAC pseudonym", async () => {
  const t = await setup();
  const node = await nodeKey();
  const res = await handle(post("issue", await issueBody(node, t.nonce)), t.deps);
  const text = await res.text();
  const { token } = JSON.parse(text);
  const [h, p] = token.split(".").map((s: string) => new TextDecoder().decode(fromB64url(s)!));
  // Neither the hyphenated nor the bare-hex form of the id appears anywhere.
  for (const form of [USER, USER.replace(/-/g, "")]) {
    assertFalse(text.includes(form), "response");
    assertFalse(h.includes(form) || p.includes(form), "token");
  }
  assertEquals(JSON.parse(p).sub, await pseudonym(t.pseudonymKey, USER));
});

Deno.test("the signature must cover this caller's user id: a signature made for another account is refused", async () => {
  const t = await setup();
  const node = await nodeKey();
  const body = await issueBody(node, t.nonce, { user: "11111111-1111-4111-8111-111111111111" });
  const res = await handle(post("issue", body), t.deps);
  assertEquals([res.status, await errorCode(res)], [403, "POR_BAD_SIGNATURE"]);
  assertEquals(t.issued.length, 0);
});

Deno.test("the signature must cover this function's aud: a signature for a shadow or local issuer is refused", async () => {
  const t = await setup();
  const node = await nodeKey();
  const body = await issueBody(node, t.nonce, { aud: "https://shadow.example/functions/v1/node-attestation" });
  assertEquals(await errorCode(await handle(post("issue", body), t.deps)), "POR_BAD_SIGNATURE");
  assertEquals(t.issued.length, 0);
});

Deno.test("the signature must cover the deadline: changing challengeExp after signing breaks it", async () => {
  const t = await setup();
  const node = await nodeKey();
  const body = await issueBody(node, t.nonce);
  const res = await handle(post("issue", { ...body, challengeExp: body.challengeExp + 1 }), t.deps);
  assertEquals(await errorCode(res), "POR_BAD_SIGNATURE");
});

Deno.test("the PeerId comes from the key that signed: another node's key with this signature is refused", async () => {
  const t = await setup();
  const a = await nodeKey();
  const b = await nodeKey();
  const body = await issueBody(a, t.nonce);
  const res = await handle(post("issue", { ...body, publicKey: b64url(b.pb) }), t.deps);
  assertEquals(await errorCode(res), "POR_BAD_SIGNATURE");
  // A claimed PeerId is not a field at all.
  const claimed = await handle(post("issue", { ...body, peerId: b.peerId }), t.deps);
  assertEquals(await errorCode(claimed), "POR_BAD_REQUEST");
});

Deno.test("a non-Ed25519 or non-canonical public key is refused before any signature check", async () => {
  const t = await setup();
  const node = await nodeKey();
  const body = await issueBody(node, t.nonce);
  const secp = Uint8Array.of(0x08, 0x02, ...node.pb.slice(2));
  assertEquals(await errorCode(await handle(post("issue", { ...body, publicKey: b64url(secp) }), t.deps)), "POR_UNSUPPORTED_KEY");
});

Deno.test("a database refusal discards the signed token: nothing is returned but the code", async () => {
  for (const code of ["POR_QUOTA_EXCEEDED", "POR_PEER_BOUND_ELSEWHERE", "POR_CHALLENGE_INVALID", "POR_ACCOUNT_CLOSED"] as const) {
    const t = await setup({ issueResult: { error: code } });
    const node = await nodeKey();
    const res = await handle(post("issue", await issueBody(node, t.nonce)), t.deps);
    const text = await res.text();
    assertEquals(JSON.parse(text).error.code, code);
    assertFalse(text.includes("token"), code);
    assertFalse(/eyJ[A-Za-z0-9_-]+\.eyJ/.test(text), code);
  }
});

Deno.test("not signed in: 401 before any work", async () => {
  const t = await setup();
  const res = await handle(post("challenge", {}, "Bearer bad"), t.deps);
  assertEquals([res.status, await errorCode(res)], [401, "POR_UNAUTHENTICATED"]);
  assertEquals(t.challenges.length, 0);
});

Deno.test("malformed requests are 400: bad base64url, short nonce, wrong signature length, junk, unknown op, GET", async () => {
  const t = await setup();
  const node = await nodeKey();
  const body = await issueBody(node, t.nonce);
  const cases: Request[] = [
    post("issue", { ...body, nonce: b64url(t.nonce.slice(1)) }),
    post("issue", { ...body, signature: b64url(new Uint8Array(63)) }),
    post("issue", { ...body, publicKey: body.publicKey + "=" }),
    post("issue", { ...body, challengeExp: "1767225900" }),
    post("issue", { ...body, challengeExp: 1.5 }),
    post("issue", "{not json"),
    post("issue", "[]"),
    post("issue", { ...body, pad: "x".repeat(5000) }),
    post("challenge", { extra: 1 }),
    post("revoke", {}),
    new Request("http://localhost/node-attestation/challenge", { headers: { Authorization: "Bearer good" } }),
  ];
  for (const req of cases) assertEquals(await errorCode(await handle(req, t.deps)), "POR_BAD_REQUEST");
  assertEquals(t.issued.length, 0);
});

Deno.test("a database failure is a 500 without the database's text", async () => {
  const t = await setup();
  t.deps.store.challenge = () => Promise.reject(new Error("connection to 10.0.0.5 refused, password=hunter2"));
  const res = await handle(post("challenge", {}), t.deps);
  assertEquals(res.status, 500);
  const text = await res.text();
  assertFalse(text.includes("hunter2") || text.includes("10.0.0.5"));
});

Deno.test("storeCode passes known refusal codes and turns anything else into an internal error", () => {
  assertEquals(storeCode("POR_QUOTA_EXCEEDED"), "POR_QUOTA_EXCEEDED");
  for (const bad of ["SOMETHING_ELSE", "POR_INTERNAL", "POR_BAD_SIGNATURE", 42, null]) {
    const e = assertThrows(() => storeCode(bad), PorError);
    assertEquals(e.code, "POR_INTERNAL");
  }
});
