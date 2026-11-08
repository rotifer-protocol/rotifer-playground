/**
 * The static JWKS file for PoR tokens (ADR-300 locked contract v2, "JWKS 文件"):
 * an RFC 7517 JWK Set of Ed25519 public keys plus a top-level
 * `rotifer_revoked` list of `{ peer_id, not_after }`, meaning "every token
 * for this peer_id with iat <= not_after is void".
 *
 * Pure: scripts/por-jwks.ts is the command-line wrapper. Public keys only —
 * a JWK carrying a private member is refused, so a private key can never be
 * written into the published file by mistake.
 */

import { fromB64url, SKEW_SECONDS, TTL_SECONDS } from "./por.ts";

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

export interface Revocation {
  peer_id: string;
  not_after: number;
}

export interface PorJwks {
  keys: PublicJwk[];
  rotifer_revoked: Revocation[];
}

const ALLOWED_MEMBERS = new Set(["kty", "crv", "x", "kid", "alg", "use", "key_ops", "ext"]);
// Base58btc, the length range of libp2p PeerIds (identity and sha256 multihashes).
const PEER_ID_RE = /^[1-9A-HJ-NP-Za-km-z]{46,60}$/;

export class JwksError extends Error {}

/** One public key, normalised to the six members the file carries. */
export function publicKey(input: unknown): PublicJwk {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new JwksError("a key must be a JSON object");
  const jwk = input as Record<string, unknown>;
  for (const name of Object.keys(jwk)) {
    if (!ALLOWED_MEMBERS.has(name)) {
      // `d` is the Ed25519 private key; any other unknown member is refused too.
      throw new JwksError(name === "d" ? "refusing a private key: the JWKS file carries public keys only" : `unexpected JWK member "${name}"`);
    }
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") throw new JwksError("only OKP / Ed25519 keys are accepted");
  if (typeof jwk.kid !== "string" || jwk.kid.length === 0) throw new JwksError("every key needs a kid");
  if (jwk.alg !== undefined && jwk.alg !== "EdDSA") throw new JwksError(`key ${jwk.kid}: alg must be EdDSA`);
  if (jwk.use !== undefined && jwk.use !== "sig") throw new JwksError(`key ${jwk.kid}: use must be sig`);
  const raw = typeof jwk.x === "string" ? fromB64url(jwk.x) : null;
  if (!raw || raw.length !== 32) throw new JwksError(`key ${jwk.kid}: x must be a 32-byte base64url Ed25519 public key`);
  return { kty: "OKP", crv: "Ed25519", x: jwk.x as string, kid: jwk.kid, alg: "EdDSA", use: "sig" };
}

export function revocation(input: unknown): Revocation {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new JwksError("a revocation must be a JSON object");
  const r = input as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== "peer_id" && k !== "not_after");
  if (extra.length > 0) throw new JwksError(`unexpected revocation member "${extra[0]}"`);
  if (typeof r.peer_id !== "string" || !PEER_ID_RE.test(r.peer_id)) throw new JwksError(`not a base58 PeerId: ${JSON.stringify(r.peer_id)}`);
  if (!Number.isSafeInteger(r.not_after) || (r.not_after as number) < 0) throw new JwksError(`not_after must be unix seconds (${r.peer_id})`);
  return { peer_id: r.peer_id, not_after: r.not_after as number };
}

/**
 * A revocation can be dropped once every token it voids has expired: those
 * tokens have iat <= not_after, so they are dead by not_after + 7 days, plus
 * the 60 s skew a verifier allows on exp.
 */
export function revocationStillNeeded(r: Revocation, nowSeconds: number): boolean {
  return nowSeconds <= r.not_after + TTL_SECONDS + SKEW_SECONDS;
}

/** allowNoKeys is the emergency path for a leaked only key; nothing else may publish an empty key set. */
export function buildJwks(
  keys: unknown[],
  revoked: unknown[],
  nowSeconds: number,
  options: { allowNoKeys?: boolean } = {},
): { jwks: PorJwks; pruned: number } {
  if (keys.length === 0 && options.allowNoKeys !== true) throw new JwksError("at least one public key is required");
  const parsed = keys.map(publicKey);
  const kids = new Set<string>();
  for (const k of parsed) {
    if (kids.has(k.kid)) throw new JwksError(`duplicate kid ${k.kid}`);
    kids.add(k.kid);
  }
  // One entry per peer_id: the latest not_after voids everything an earlier one does.
  const latest = new Map<string, number>();
  for (const r of revoked.map(revocation)) latest.set(r.peer_id, Math.max(r.not_after, latest.get(r.peer_id) ?? -1));
  const kept: Revocation[] = [];
  let pruned = 0;
  for (const [peer_id, not_after] of latest) {
    if (revocationStillNeeded({ peer_id, not_after }, nowSeconds)) kept.push({ peer_id, not_after });
    else pruned++;
  }
  kept.sort((a, b) => (a.peer_id < b.peer_id ? -1 : a.peer_id > b.peer_id ? 1 : 0));
  return { jwks: { keys: parsed, rotifer_revoked: kept }, pruned };
}
