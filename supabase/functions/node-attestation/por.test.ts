import { assert, assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert@1";
import {
  b64url,
  base58btc,
  type Bytes,
  challengeMessage,
  ed25519FromLibp2pPublicKey,
  fromB64url,
  importPseudonymKey,
  importSigningJwk,
  ISSUER,
  type Jwk,
  libp2pPublicKey,
  peerIdFromPublicKey,
  pseudonym,
  signToken,
  SMALL_ORDER_POINTS,
  strictEd25519Input,
  TTL_SECONDS,
  verifyNodeSignature,
  verifyToken,
} from "./por.ts";

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const enc = new TextEncoder();

async function sha256(b: Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", b)));
}

// Reference vectors from Rust libp2p-identity 0.3.1 (the version in Cargo.lock):
// Keypair::ed25519_from_bytes(seed), public().encode_protobuf(), to_peer_id(), sign(b"rotifer").
// The seeds are public test values, not keys for any environment.
const NODE_A = {
  seed: hex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"),
  pub: hex("0801122003a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8"),
  peerId: "12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB",
  sigRotifer: hex(
    "5e04f447789a15dfaf912effb69a6a110ead993789bdf93cc0050de69deb0bab00b416cb8448984bf48f877227f413ec7237032a23e3097b7027358fcf7b0c02",
  ),
};
const NODE_B = {
  pub: hex("080112208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c"),
  peerId: "12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5",
};

Deno.test("challenge bytes match the ADR-300 contract v2 golden vector (162 bytes, sha256 2894e45e…)", async () => {
  const msg = challengeMessage(
    "http://127.0.0.1:54321/functions/v1/node-attestation",
    "00000000-0000-4000-8000-000000000001",
    new Uint8Array(32).map((_, i) => i),
    1767225600,
  );
  assertEquals(msg.length, 162);
  assertEquals(
    toHex(msg),
    "0000000e726f74696665722d706f722d763100000034687474703a2f2f313237" +
      "2e302e302e313a35343332312f66756e6374696f6e732f76312f6e6f64652d61" +
      "74746573746174696f6e0000002430303030303030302d303030302d34303030" +
      "2d383030302d3030303030303030303030310000002000010203040506070809" +
      "0a0b0c0d0e0f101112131415161718191a1b1c1d1e1f00000008000000006955" +
      "b900",
  );
  assertEquals(await sha256(msg), "2894e45e0a5784ec6365fddc4c292f9b934c0c6eaecdc3855295d7b2f8dab1b2");
});

Deno.test("length prefixes keep fields apart: moving a byte between aud and user_id changes the message", () => {
  const n = new Uint8Array(32);
  const a = challengeMessage("https://x/a", "b-user", n, 1);
  const b = challengeMessage("https://x/ab", "-user", n, 1);
  assertNotEquals(toHex(a), toHex(b));
});

Deno.test("PeerId derivation matches rust libp2p-identity for two keys", () => {
  assertEquals(peerIdFromPublicKey(NODE_A.pub), NODE_A.peerId);
  assertEquals(peerIdFromPublicKey(NODE_B.pub), NODE_B.peerId);
  assertEquals(toHex(libp2pPublicKey(ed25519FromLibp2pPublicKey(NODE_A.pub)!)), toHex(NODE_A.pub));
});

Deno.test("only the canonical Ed25519 libp2p encoding is accepted", () => {
  const raw = NODE_A.pub.slice(4);
  // RSA key type (0), secp256k1 (2), wrong length, trailing byte, long-form varint.
  for (
    const bad of [
      Uint8Array.of(0x08, 0x00, 0x12, 0x20, ...raw),
      Uint8Array.of(0x08, 0x02, 0x12, 0x20, ...raw),
      Uint8Array.of(0x08, 0x01, 0x12, 0x1f, ...raw.slice(1)),
      Uint8Array.of(...NODE_A.pub, 0x00),
      Uint8Array.of(0x08, 0x81, 0x00, 0x12, 0x20, ...raw),
      raw,
    ]
  ) {
    assertEquals(peerIdFromPublicKey(bad), null, toHex(bad));
  }
});

Deno.test("base58btc keeps leading zero bytes as '1'", () => {
  assertEquals(base58btc(Uint8Array.of(0, 0, 1)), "112");
  assertEquals(base58btc(new Uint8Array(0)), "");
});

Deno.test("a node signature from rust libp2p verifies; a flipped bit or another key does not", async () => {
  const msg = enc.encode("rotifer");
  assert(await verifyNodeSignature(NODE_A.pub, msg, NODE_A.sigRotifer));
  const flipped = NODE_A.sigRotifer.slice();
  flipped[10] ^= 1;
  assertEquals(await verifyNodeSignature(NODE_A.pub, msg, flipped), false);
  assertEquals(await verifyNodeSignature(NODE_B.pub, msg, NODE_A.sigRotifer), false);
  assertEquals(await verifyNodeSignature(NODE_A.pub, msg, NODE_A.sigRotifer.slice(1)), false);
});

Deno.test("base64url decoding is strict and canonical", () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assertEquals(fromB64url(b64url(all)), all);
  assertEquals(fromB64url("AA=="), null); // padding
  assertEquals(fromB64url("A+8"), null); // standard alphabet
  assertEquals(fromB64url("AB"), null); // non-zero trailing bits ("AA" is canonical)
  assertEquals(fromB64url("A"), null);
});

// --- pseudonym (P0: not reversible, no plaintext user_id) ---------------------

async function randomKey(): Promise<CryptoKey> {
  return await importPseudonymKey(crypto.getRandomValues(new Uint8Array(32)));
}

Deno.test("sub is HMAC-SHA256(K, 'rotifer-por-sub-v1\\0' || user_id), base64url: checked against an independent HMAC", async () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const user = "0b1d8a0e-6a1f-4c55-9a0c-7f1e2d3c4b5a";
  const got = await pseudonym(await importPseudonymKey(raw), user);
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = Uint8Array.of(...enc.encode("rotifer-por-sub-v1"), 0, ...enc.encode(user));
  assertEquals(got, b64url(new Uint8Array(await crypto.subtle.sign("HMAC", k, msg))));
  assertEquals(got.length, 43);
});

Deno.test("sub is stable per account under one key, differs across accounts and across keys", async () => {
  const k1 = await randomKey();
  const k2 = await randomKey();
  const u1 = "11111111-1111-4111-8111-111111111111";
  const u2 = "22222222-2222-4222-8222-222222222222";
  assertEquals(await pseudonym(k1, u1), await pseudonym(k1, u1));
  assertNotEquals(await pseudonym(k1, u1), await pseudonym(k1, u2));
  // Without K_pseudo the same account maps elsewhere: an outsider cannot recompute it.
  assertNotEquals(await pseudonym(k1, u1), await pseudonym(k2, u1));
});

Deno.test("a pseudonym key shorter than 32 bytes is refused", async () => {
  await assertRejects(() => importPseudonymKey(new Uint8Array(31)), RangeError);
});

// --- token ------------------------------------------------------------------

async function freshSigner(kid = "test-kid") {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const signer = await importSigningJwk({ ...priv, kid, alg: "EdDSA" });
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk: Jwk = { kty: "OKP", crv: "Ed25519", x: pub.x, kid, alg: "EdDSA", use: "sig" };
  return { signer, jwk };
}

function decodePart(token: string, i: number): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(fromB64url(token.split(".")[i])!));
}

Deno.test("issued token: header {alg EdDSA, typ rotifer-por+jwt, kid}; exactly the five claims; verifies", async () => {
  const { signer, jwk } = await freshSigner();
  const iat = 1767225600;
  const token = await signToken(signer, { iss: ISSUER, sub: "s", peer_id: NODE_A.peerId, iat, exp: iat + TTL_SECONDS });
  assertEquals(decodePart(token, 0), { alg: "EdDSA", typ: "rotifer-por+jwt", kid: "test-kid" });
  assertEquals(Object.keys(decodePart(token, 1)), ["iss", "sub", "peer_id", "iat", "exp"]);
  const r = await verifyToken(token, { issuer: ISSUER, keys: [jwk] }, iat + 10);
  assert(r.ok && !r.expired);
});

Deno.test("verification: wrong key is forged; unknown kid or issuer is unverifiable; expired still checks the signature", async () => {
  const a = await freshSigner("k1");
  const b = await freshSigner("k1");
  const iat = 1767225600;
  const claims = { iss: ISSUER, sub: "s", peer_id: NODE_A.peerId, iat, exp: iat + TTL_SECONDS };
  const token = await signToken(a.signer, claims);
  assertEquals(await verifyToken(token, { issuer: ISSUER, keys: [b.jwk] }, iat), { ok: false, reason: "forged" });
  assertEquals(await verifyToken(token, { issuer: ISSUER, keys: [{ ...a.jwk, kid: "other" }] }, iat), { ok: false, reason: "unverifiable" });
  assertEquals(await verifyToken(token, { issuer: "https://elsewhere", keys: [a.jwk] }, iat), { ok: false, reason: "unverifiable" });
  const late = iat + TTL_SECONDS + 61;
  const r = await verifyToken(token, { issuer: ISSUER, keys: [a.jwk] }, late);
  assert(r.ok && r.expired);
  // An expired token under the wrong key is still reported as forged, not as expired.
  assertEquals(await verifyToken(token, { issuer: ISSUER, keys: [b.jwk] }, late), { ok: false, reason: "forged" });
});

Deno.test("verification rejects alg none/HS256, other typ, crit, missing or duplicate claims, future iat, >7 day lifetime", async () => {
  const { signer, jwk } = await freshSigner();
  const iat = 1767225600;
  const trust = { issuer: ISSUER, keys: [jwk] };
  const sign = async (header: object, payload: object) => {
    const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, signer.key, enc.encode(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  };
  const rawSign = async (headerText: string, payloadText: string) => {
    const input = `${b64url(enc.encode(headerText))}.${b64url(enc.encode(payloadText))}`;
    const sig = await crypto.subtle.sign({ name: "Ed25519" }, signer.key, enc.encode(input));
    return `${input}.${b64url(new Uint8Array(sig))}`;
  };
  const head = { alg: "EdDSA", typ: "rotifer-por+jwt", kid: "test-kid" };
  const body = { iss: ISSUER, sub: "s", peer_id: NODE_A.peerId, iat, exp: iat + TTL_SECONDS };
  const cases: [string, string][] = [
    ["alg none", await sign({ ...head, alg: "none" }, body)],
    ["alg HS256", await sign({ ...head, alg: "HS256" }, body)],
    ["typ JWT", await sign({ ...head, typ: "JWT" }, body)],
    ["crit", await sign({ ...head, crit: ["exp"] }, body)],
    ["no kid", await sign({ alg: "EdDSA", typ: "rotifer-por+jwt" }, body)],
    ["no sub", await sign(head, { iss: ISSUER, peer_id: NODE_A.peerId, iat, exp: iat + 1 })],
    ["iat string", await sign(head, { ...body, iat: String(iat) })],
    ["iat in the future", await sign(head, { ...body, iat: iat + 61, exp: iat + 100 })],
    ["lifetime > 7 days", await sign(head, { ...body, exp: iat + TTL_SECONDS + 1 })],
    [
      "duplicate sub",
      await rawSign(JSON.stringify(head), `{"iss":"${ISSUER}","sub":"a","sub":"b","peer_id":"${NODE_A.peerId}","iat":${iat},"exp":${iat + 1}}`),
    ],
  ];
  for (const [name, token] of cases) {
    const r = await verifyToken(token, trust, iat);
    assertEquals(r.ok, false, name);
  }
  // A jku pointing elsewhere is ignored: the key still comes from the trust anchor.
  const withJku = await sign({ ...head, jku: "https://attacker.example/jwks.json" }, body);
  assert((await verifyToken(withJku, trust, iat)).ok);
});

Deno.test("signing JWK validation: public-only, wrong curve, missing kid are refused", async () => {
  const { jwk } = await freshSigner();
  await assertRejects(() => importSigningJwk(jwk as JsonWebKey), Error, "private");
  await assertRejects(() => importSigningJwk({ kty: "OKP", crv: "X25519", d: "AA", x: "AA", kid: "k" } as JsonWebKey), Error);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  await assertRejects(() => importSigningJwk(priv), Error, "kid");
});

// ---------------------------------------------------------------------------
// Strict Ed25519 acceptance. The arithmetic below is independent of por.ts: it
// checks that the rejected encodings really are the small-order points.

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const mod = (n: bigint, m = P) => ((n % m) + m) % m;
function power(b: bigint, e: bigint): bigint {
  let r = 1n;
  for (b = mod(b); e > 0n; e >>= 1n, b = mod(b * b)) if (e & 1n) r = mod(r * b);
  return r;
}
const inv = (n: bigint) => power(n, P - 2n);
const D = mod(-121665n * inv(121666n));
const toNumber = (b: Uint8Array) => b.reduceRight((n, x) => (n << 8n) | BigInt(x), 0n);
function toBytes(n: bigint, length = 32): Bytes {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++, n >>= 8n) out[i] = Number(n & 0xffn);
  return out;
}
function pointFromY(y: bigint): [bigint, bigint] {
  const x2 = mod((y * y - 1n) * inv(D * y * y + 1n));
  let x = power(x2, (P + 3n) / 8n);
  if (mod(x * x) !== x2) x = mod(x * power(2n, (P - 1n) / 4n));
  assertEquals(mod(x * x), x2, "the encoding is on the curve");
  return [x, y];
}
function double([x, y]: [bigint, bigint]): [bigint, bigint] {
  const xy = mod(x * y);
  const dxy = mod(D * xy * xy);
  return [mod(2n * xy * inv(1n + dxy)), mod((y * y + x * x) * inv(1n - dxy))];
}

Deno.test("each rejected encoding is a point of order dividing 8, and all five y values of small order are listed", () => {
  assertEquals(SMALL_ORDER_POINTS.length, 5);
  for (const point of SMALL_ORDER_POINTS) {
    assertEquals(double(double(double(pointFromY(toNumber(point))))), [0n, 1n]);
  }
});

const sigWith = (r: Uint8Array, s: Uint8Array) => {
  const out = new Uint8Array(64);
  out.set(r);
  out.set(s, 32);
  return out;
};

Deno.test("no small-order public key passes, with either sign bit, even with the signature that fits every message", async () => {
  const identity = new Uint8Array(32);
  identity[0] = 1;
  const anyMessage = new TextEncoder().encode("any message at all");
  for (const point of SMALL_ORDER_POINTS) {
    for (const signBit of [0, 0x80]) {
      const raw = point.slice();
      raw[31] |= signBit;
      assertEquals(await verifyNodeSignature(libp2pPublicKey(raw), anyMessage, sigWith(identity, new Uint8Array(32))), false);
    }
  }
});

Deno.test("encodings of y at or above p are refused, as is S at or above the group order", () => {
  const honestA = NODE_A.pub.slice(4);
  const ok = sigWith(honestA, new Uint8Array(32));
  assert(strictEd25519Input(honestA, ok));
  for (const y of [P + 2n, P + 18n]) assertEquals(strictEd25519Input(toBytes(y), ok), false, `A with y = p + ${y - P}`);
  for (const s of [L, L + 1n]) assertEquals(strictEd25519Input(honestA, sigWith(honestA, toBytes(s))), false, `S = L + ${s - L}`);
  assert(strictEd25519Input(honestA, sigWith(honestA, toBytes(L - 1n))));
});

Deno.test("a signature with a small-order R, or with S + L, is refused even though it satisfies the equation", async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const A = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const seed = fromB64url((await crypto.subtle.exportKey("jwk", pair.privateKey)).d!)!;
  const expanded = new Uint8Array(await crypto.subtle.digest("SHA-512", seed)).slice(0, 32);
  expanded[0] &= 248;
  expanded[31] = (expanded[31] & 127) | 64;
  const a = toNumber(expanded);
  const message = new TextEncoder().encode("a message");
  const R = new Uint8Array(32);
  R[0] = 1; // the identity: the signer's nonce was 0
  const input = new Uint8Array([...R, ...A, ...message]);
  const k = mod(toNumber(new Uint8Array(await crypto.subtle.digest("SHA-512", input))), L);
  const smallR = sigWith(R, toBytes(mod(k * a, L)));
  assertEquals(await verifyNodeSignature(libp2pPublicKey(A), message, smallR), false);

  const honest = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, message));
  assert(await verifyNodeSignature(libp2pPublicKey(A), message, honest));
  const malleated = sigWith(honest.slice(0, 32), toBytes(toNumber(honest.slice(32)) + L));
  assertEquals(await verifyNodeSignature(libp2pPublicKey(A), message, malleated), false);
});
