/**
 * Proof of Registration (PoR) primitives for the node-attestation function:
 * the signed challenge bytes, PeerId derivation, the account pseudonym and
 * the EdDSA token. Locked contract v2 (ADR-300 revision 2): "发证挑战",
 * "claims", "JWT 校验"; P2P RFC §8.4.
 *
 * No I/O and no keys of its own: callers pass CryptoKeys in.
 */

export const DOMAIN_PREFIX = "rotifer-por-v1";
export const SUB_PREFIX = "rotifer-por-sub-v1\0";
export const ISSUER = "https://rotifer.dev";
export const TOKEN_TYPE = "rotifer-por+jwt";
export const TTL_SECONDS = 7 * 24 * 3600;
/** Clock skew allowed when judging `iat` and `exp` (contract: 60 s). */
export const SKEW_SECONDS = 60;

/** A byte array backed by a plain ArrayBuffer, as WebCrypto takes it. */
export type Bytes = Uint8Array<ArrayBuffer>;

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

// ---------------------------------------------------------------------------
// base64url (RFC 4648 §5, no padding)

export function b64url(bytes: Bytes): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Strict: only the unpadded url alphabet, and the canonical encoding. Null otherwise. */
export function fromB64url(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const pad = text.length % 4 === 0 ? "" : "=".repeat(4 - (text.length % 4));
  let bin: string;
  try {
    bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  } catch {
    return null;
  }
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  // Reject non-canonical trailing bits (two encodings of one byte string).
  return b64url(out) === text ? out : null;
}

// ---------------------------------------------------------------------------
// Challenge bytes: msg = LP(prefix) || LP(aud) || LP(user_id) || LP(nonce) || LP(challenge_exp)
// LP(x) = u32_be(len(x)) || x; challenge_exp is a u64_be (8 bytes).

function lp(field: Bytes): Bytes {
  const out = new Uint8Array(4 + field.length);
  new DataView(out.buffer).setUint32(0, field.length, false);
  out.set(field, 4);
  return out;
}

export function challengeMessage(aud: string, userId: string, nonce: Bytes, challengeExp: number): Bytes {
  if (!Number.isSafeInteger(challengeExp) || challengeExp < 0) throw new RangeError("challengeExp must be a non-negative integer");
  const exp = new Uint8Array(8);
  new DataView(exp.buffer).setBigUint64(0, BigInt(challengeExp), false);
  const parts = [enc.encode(DOMAIN_PREFIX), enc.encode(aud), enc.encode(userId), nonce, exp].map(lp);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// libp2p public keys and PeerIds (libp2p peer-ids spec)
//
// PublicKey protobuf: field 1 KeyType (varint; Ed25519 = 1), field 2 Data (bytes).
// Only Ed25519 is accepted (contract: node keys and token keys share the curve),
// and only its canonical 36-byte encoding 08 01 12 20 <32 bytes>, so one key
// has one encoding. An Ed25519 PeerId is the identity multihash of that
// encoding (0x00, length 0x24), in base58btc.

const ED25519_PB_PREFIX = [0x08, 0x01, 0x12, 0x20];

/** The raw 32-byte Ed25519 key, or null if `pb` is not a canonical Ed25519 libp2p public key. */
export function ed25519FromLibp2pPublicKey(pb: Bytes): Bytes | null {
  if (pb.length !== 36) return null;
  for (let i = 0; i < 4; i++) if (pb[i] !== ED25519_PB_PREFIX[i]) return null;
  return pb.slice(4);
}

export function libp2pPublicKey(raw: Bytes): Bytes {
  if (raw.length !== 32) throw new RangeError("an Ed25519 public key is 32 bytes");
  const out = new Uint8Array(36);
  out.set(ED25519_PB_PREFIX, 0);
  out.set(raw, 4);
  return out;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58btc(bytes: Bytes): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

/** PeerId (base58btc) of a canonical Ed25519 libp2p public key; null for anything else. */
export function peerIdFromPublicKey(pb: Bytes): string | null {
  if (ed25519FromLibp2pPublicKey(pb) === null) return null;
  const mh = new Uint8Array(2 + pb.length);
  mh[0] = 0x00; // identity
  mh[1] = pb.length;
  mh.set(pb, 2);
  return base58btc(mh);
}

/** Verifies an Ed25519 signature by the key inside a libp2p public key. */
export async function verifyNodeSignature(pb: Bytes, message: Bytes, signature: Bytes): Promise<boolean> {
  const raw = ed25519FromLibp2pPublicKey(pb);
  if (raw === null || signature.length !== 64) return false;
  const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, signature, message);
}

// ---------------------------------------------------------------------------
// Account pseudonym: sub = base64url(HMAC-SHA256(K_pseudo, "rotifer-por-sub-v1\0" || user_id))

export const MIN_PSEUDONYM_KEY_BYTES = 32;

export async function importPseudonymKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length < MIN_PSEUDONYM_KEY_BYTES) {
    throw new RangeError(`the pseudonym key must be at least ${MIN_PSEUDONYM_KEY_BYTES} bytes`);
  }
  return await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function pseudonym(key: CryptoKey, userId: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(SUB_PREFIX + userId));
  return b64url(new Uint8Array(mac));
}

// ---------------------------------------------------------------------------
// Token

export interface PorClaims {
  iss: string;
  sub: string;
  peer_id: string;
  iat: number;
  exp: number;
}

export interface SigningKey {
  kid: string;
  key: CryptoKey; // Ed25519 private key
}

/**
 * The signing key from a private OKP/Ed25519 JWK that carries a `kid`.
 * Rejects anything else, so a misconfigured secret fails at start-up, not
 * on the first request.
 */
export async function importSigningJwk(jwk: JsonWebKey & { kid?: unknown }): Promise<SigningKey> {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.d !== "string" || typeof jwk.x !== "string") {
    throw new Error("the signing key must be a private OKP / Ed25519 JWK");
  }
  if (typeof jwk.kid !== "string" || jwk.kid.length === 0) throw new Error("the signing key needs a kid");
  if (jwk.alg !== undefined && jwk.alg !== "EdDSA") throw new Error("the signing key's alg must be EdDSA");
  const { kid, ...rest } = jwk;
  const key = await crypto.subtle.importKey("jwk", { ...rest, key_ops: ["sign"] }, { name: "Ed25519" }, false, ["sign"]);
  return { kid, key };
}

export async function signToken(signer: SigningKey, claims: PorClaims): Promise<string> {
  const header = { alg: "EdDSA", typ: TOKEN_TYPE, kid: signer.kid };
  const payload = { iss: claims.iss, sub: claims.sub, peer_id: claims.peer_id, iat: claims.iat, exp: claims.exp };
  const input = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, signer.key, enc.encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// Verification, per contract v2 "JWT 校验" rules 1-4 and 6. The node-side
// verifier lives in rotifer-core; this one checks what the function issues
// (tests, the end-to-end script) and documents the rules in the same terms.

export type VerifyResult =
  | { ok: true; claims: PorClaims; expired: boolean }
  | { ok: false; reason: "malformed" | "unverifiable" | "forged" };

const REQUIRED = ["iss", "sub", "peer_id", "iat", "exp"] as const;
const MAX_TOKEN_BYTES = 2048;
const MAX_HEADER_BYTES = 512;

/** JSON object with no duplicate keys (JSON.parse keeps the last silently). */
function parseObject(bytes: Bytes): Record<string, unknown> | null {
  let text: string;
  try {
    text = dec.decode(bytes);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // Duplicate top-level keys: count member names at depth 1.
  const names: string[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1 && /^\s*:/.test(text.slice(j + 1))) names.push(JSON.parse(text.slice(i, j + 1)));
      i = j;
    } else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
  }
  if (new Set(names).size !== names.length) return null;
  return value as Record<string, unknown>;
}

export interface Jwk {
  kty?: string;
  crv?: string;
  x?: string;
  kid?: string;
  alg?: string;
  use?: string;
}

export async function verifyToken(
  token: string,
  trust: { issuer: string; keys: Jwk[] },
  nowSeconds: number,
): Promise<VerifyResult> {
  if (token.length > MAX_TOKEN_BYTES) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts.map(fromB64url);
  if (!h || !p || !s || h.length > MAX_HEADER_BYTES) return { ok: false, reason: "malformed" };
  const header = parseObject(h);
  const payload = parseObject(p);
  if (!header || !payload) return { ok: false, reason: "malformed" };
  // Rules 1-3: one algorithm, own typ, no crit; key-carrying headers are ignored.
  if (header.alg !== "EdDSA" || header.typ !== TOKEN_TYPE || "crit" in header) return { ok: false, reason: "malformed" };
  if (typeof header.kid !== "string") return { ok: false, reason: "malformed" };
  // Rule 4: all five claims, right types.
  for (const name of REQUIRED) if (!(name in payload)) return { ok: false, reason: "malformed" };
  const { iss, sub, peer_id, iat, exp } = payload;
  if (typeof iss !== "string" || typeof sub !== "string" || typeof peer_id !== "string") return { ok: false, reason: "malformed" };
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return { ok: false, reason: "malformed" };
  if (iss !== trust.issuer) return { ok: false, reason: "unverifiable" };
  const jwk = trust.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, reason: "unverifiable" };
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") return { ok: false, reason: "unverifiable" };
  const raw = fromB64url(jwk.x);
  if (!raw || raw.length !== 32) return { ok: false, reason: "unverifiable" };
  const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  const input = enc.encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify({ name: "Ed25519" }, key, s, input))) return { ok: false, reason: "forged" };
  if ((iat as number) > nowSeconds + SKEW_SECONDS) return { ok: false, reason: "malformed" };
  if ((exp as number) - (iat as number) > TTL_SECONDS || (exp as number) < (iat as number)) return { ok: false, reason: "malformed" };
  // Rule 6: an expired token has been through every check above.
  const expired = nowSeconds > (exp as number) + SKEW_SECONDS;
  return { ok: true, claims: { iss, sub, peer_id, iat: iat as number, exp: exp as number }, expired };
}
