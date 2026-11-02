/**
 * node-attestation request handling (v0.9.5 A1; ADR-300 locked contract v2,
 * "发证挑战"; P2P RFC §8.4).
 *
 *   POST /functions/v1/node-attestation/challenge   body: {}
 *     200 { nonce, aud, challengeExp }        nonce: base64url of 32 bytes
 *   POST /functions/v1/node-attestation/issue
 *     body { publicKey, signature, nonce, challengeExp }
 *       publicKey: base64url libp2p protobuf public key (Ed25519 only)
 *       signature: base64url Ed25519 signature over the challenge bytes
 *       nonce, challengeExp: as returned by /challenge
 *     200 { token, peerId, iat, exp }
 *   4xx/5xx { error: { code, message } }
 *
 * Both need a signed-in Cloud account. The handler takes its collaborators
 * (who is calling, the database, keys, clock) as Deps so it can be tested
 * without a stack; index.ts wires the real ones.
 *
 * Order on /issue: identify the caller; derive the PeerId from the public
 * key (never trust a claimed one); rebuild the challenge bytes from the
 * caller's own user id and this function's aud and verify the node's
 * signature; sign the token; only then record it, in one database
 * transaction that consumes the nonce, re-checks the account and applies the
 * rebinding rule and the per-account limit. A refused record discards the
 * signed token unreturned. The token and the response carry the account
 * pseudonym, never the user id.
 */

import {
  b64url,
  type Bytes,
  challengeMessage,
  fromB64url,
  ISSUER,
  peerIdFromPublicKey,
  pseudonym,
  type SigningKey,
  signToken,
  TTL_SECONDS,
  verifyNodeSignature,
} from "./por.ts";

export type ErrorCode =
  | "POR_BAD_REQUEST"
  | "POR_UNAUTHENTICATED"
  | "POR_UNSUPPORTED_KEY"
  | "POR_BAD_SIGNATURE"
  | "POR_CHALLENGE_INVALID"
  | "POR_CHALLENGE_EXPIRED"
  | "POR_ACCOUNT_CLOSED"
  | "POR_TOO_MANY_CHALLENGES"
  | "POR_PEER_BOUND_ELSEWHERE"
  | "POR_PEER_REVOKED"
  | "POR_QUOTA_EXCEEDED"
  | "POR_NOT_CONFIGURED"
  | "POR_INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  POR_BAD_REQUEST: 400,
  POR_UNAUTHENTICATED: 401,
  POR_UNSUPPORTED_KEY: 400,
  POR_BAD_SIGNATURE: 403,
  POR_CHALLENGE_INVALID: 400,
  POR_CHALLENGE_EXPIRED: 400,
  POR_ACCOUNT_CLOSED: 403,
  POR_TOO_MANY_CHALLENGES: 429,
  POR_PEER_BOUND_ELSEWHERE: 409,
  POR_PEER_REVOKED: 409,
  POR_QUOTA_EXCEEDED: 409,
  POR_NOT_CONFIGURED: 503,
  POR_INTERNAL: 500,
};

const MESSAGE: Record<ErrorCode, string> = {
  POR_BAD_REQUEST: "malformed request",
  POR_UNAUTHENTICATED: "sign in (rotifer login) to attest a node",
  POR_UNSUPPORTED_KEY: "publicKey must be a libp2p Ed25519 public key",
  POR_BAD_SIGNATURE: "the signature does not verify for this challenge and key",
  POR_CHALLENGE_INVALID: "unknown or already used challenge; request a new one",
  POR_CHALLENGE_EXPIRED: "the challenge expired; request a new one",
  POR_ACCOUNT_CLOSED: "this account cannot attest nodes",
  POR_TOO_MANY_CHALLENGES: "too many open challenges; use or let one expire first",
  POR_PEER_BOUND_ELSEWHERE: "this node has a live certificate under another account; it must expire or be revoked first",
  POR_PEER_REVOKED: "this node is revoked",
  POR_QUOTA_EXCEEDED: "this account already has live certificates for 3 nodes",
  POR_NOT_CONFIGURED: "node attestation is not configured on this server",
  POR_INTERNAL: "internal error",
};

export class PorError extends Error {
  constructor(readonly code: ErrorCode, message = MESSAGE[code]) {
    super(message);
  }
}

export function errorResponse(e: PorError): Response {
  return json(STATUS[e.code], { error: { code: e.code, message: e.message } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export interface IssueRecord {
  userId: string;
  aud: string;
  nonce: Bytes;
  challengeExp: number;
  peerId: string;
  sub: string;
  iat: number;
  exp: number;
  kid: string;
}

/** Database side. A refusal resolves to its error code; a database failure rejects. */
export interface AttestationStore {
  challenge(userId: string, aud: string): Promise<{ nonce: Bytes; challengeExp: number } | { error: ErrorCode }>;
  issue(record: IssueRecord): Promise<{ ok: true } | { error: ErrorCode }>;
}

export interface Deps {
  /** The caller's user id, or null when the request is not signed in. */
  authenticate(authorization: string | null): Promise<string | null>;
  store: AttestationStore;
  signer: SigningKey;
  pseudonymKey: CryptoKey;
  /** This function's own address, exactly as signed into the challenge. */
  aud: string;
  nowSeconds(): number;
}

const MAX_BODY_BYTES = 4096;
const STORE_CODES = new Set<string>([
  "POR_CHALLENGE_INVALID",
  "POR_CHALLENGE_EXPIRED",
  "POR_ACCOUNT_CLOSED",
  "POR_TOO_MANY_CHALLENGES",
  "POR_PEER_BOUND_ELSEWHERE",
  "POR_PEER_REVOKED",
  "POR_QUOTA_EXCEEDED",
]);

/** A refusal code from the database, checked against the known set. */
export function storeCode(value: unknown): ErrorCode {
  if (typeof value === "string" && STORE_CODES.has(value)) return value as ErrorCode;
  throw new PorError("POR_INTERNAL", `unexpected database refusal ${JSON.stringify(value)}`);
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) throw new PorError("POR_BAD_REQUEST", "request body too large");
  if (text.trim() === "") return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PorError("POR_BAD_REQUEST", "body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new PorError("POR_BAD_REQUEST", "body must be a JSON object");
  return body as Record<string, unknown>;
}

function bytesField(body: Record<string, unknown>, name: string, length?: number): Bytes {
  const v = body[name];
  const bytes = typeof v === "string" ? fromB64url(v) : null;
  if (!bytes || (length !== undefined && bytes.length !== length)) {
    throw new PorError("POR_BAD_REQUEST", `${name} must be base64url${length === undefined ? "" : ` of ${length} bytes`}`);
  }
  return bytes;
}

async function challenge(deps: Deps, userId: string, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (Object.keys(body).length > 0) throw new PorError("POR_BAD_REQUEST", "challenge takes no fields");
  const r = await deps.store.challenge(userId, deps.aud);
  if ("error" in r) throw new PorError(r.error);
  return json(200, { nonce: b64url(r.nonce), aud: deps.aud, challengeExp: r.challengeExp });
}

async function issue(deps: Deps, userId: string, request: Request): Promise<Response> {
  const body = await readBody(request);
  const known = new Set(["publicKey", "signature", "nonce", "challengeExp"]);
  const extra = Object.keys(body).find((k) => !known.has(k));
  if (extra !== undefined) throw new PorError("POR_BAD_REQUEST", `unexpected field ${extra}`);
  const publicKey = bytesField(body, "publicKey");
  const signature = bytesField(body, "signature", 64);
  const nonce = bytesField(body, "nonce", 32);
  const challengeExp = body.challengeExp;
  if (!Number.isSafeInteger(challengeExp) || (challengeExp as number) < 0) {
    throw new PorError("POR_BAD_REQUEST", "challengeExp must be unix seconds");
  }

  const peerId = peerIdFromPublicKey(publicKey);
  if (peerId === null) throw new PorError("POR_UNSUPPORTED_KEY");
  const message = challengeMessage(deps.aud, userId, nonce, challengeExp as number);
  if (!(await verifyNodeSignature(publicKey, message, signature))) throw new PorError("POR_BAD_SIGNATURE");

  const iat = deps.nowSeconds();
  const exp = iat + TTL_SECONDS;
  const sub = await pseudonym(deps.pseudonymKey, userId);
  const token = await signToken(deps.signer, { iss: ISSUER, sub, peer_id: peerId, iat, exp });

  const r = await deps.store.issue({
    userId,
    aud: deps.aud,
    nonce,
    challengeExp: challengeExp as number,
    peerId,
    sub,
    iat,
    exp,
    kid: deps.signer.kid,
  });
  if ("error" in r) throw new PorError(r.error);
  return json(200, { token, peerId, iat, exp });
}

export async function handle(request: Request, deps: Deps): Promise<Response> {
  try {
    if (request.method !== "POST") throw new PorError("POR_BAD_REQUEST", "use POST");
    const op = new URL(request.url).pathname.split("/").filter(Boolean).pop();
    if (op !== "challenge" && op !== "issue") throw new PorError("POR_BAD_REQUEST", "unknown operation; use /challenge or /issue");
    const userId = await deps.authenticate(request.headers.get("Authorization"));
    if (userId === null) throw new PorError("POR_UNAUTHENTICATED");
    return op === "challenge" ? await challenge(deps, userId, request) : await issue(deps, userId, request);
  } catch (e) {
    if (e instanceof PorError) return errorResponse(e);
    // No detail to the caller; the message may hold database text.
    console.error("node-attestation:", e instanceof Error ? e.message : String(e));
    return errorResponse(new PorError("POR_INTERNAL"));
  }
}
