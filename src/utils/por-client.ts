/**
 * Client for the node-attestation issuing function (ADR-300 revision 2).
 *
 * Gets a proof-of-registration certificate for this node: ask for a challenge,
 * have the native node answer it with its key, trade the answer for a token.
 * Enabling and renewing share `obtainCertificate`.
 *
 * Nothing here may put a session token, a certificate or the account pseudonym
 * in an error: every failure is a `PorError` built from fixed text.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCredentials, refreshTokenIfNeeded } from "../cloud/auth.js";
import { loadCloudConfig } from "../cloud/client.js";
import { CREDENTIALS_FILE } from "../cloud/types.js";
import type { PorChallengeSignature } from "./binding.js";

/**
 * Where the function lives under the Cloud endpoint. The whole address is also
 * the `aud` it signs challenges for (ADR-300), so production's
 * NODE_ATTESTATION_AUD must be this, byte for byte, under the default endpoint:
 * https://cloud.rotifer.dev/functions/v1/node-attestation
 */
const POR_FUNCTION_PATH = "/functions/v1/node-attestation";

export const POR_LIFETIME_S = 7 * 24 * 3600;
const REQUEST_TIMEOUT_MS = 15_000;

/** ADR-300, the wording fixed by the 2026-11-02 ruling. */
export const CONSENT_NOTICE = "你的节点会和一个账号假名关联公开，Cloud 能反查。";
/** What a certificate commits the user to, shown alongside the consent notice. */
export const LIFETIME_NOTICE = "证书 7 天内失效；节点在线时会在剩余不足 48 小时时自动续签。";
export const CONSENT_FLAG = "--accept-public-pseudonym";

/** por.rs `MAX_JWKS_CACHE_SECS` is the 24 hours; ADR-300 D4 revision is the 7 days. */
export const BAN_NOTICE =
  "If your account is banned or a certificate is revoked, other nodes stop accepting it within about 24 hours " +
  "of the revocation being published. Without a published revocation it stops working when it expires, at most 7 days after issue.";
export const KEY_CHANGE_NOTICE =
  "This node's key changed, so it is a new node to the network and needs its own certificate: run 'rotifer network attest enable'. " +
  "The old certificate is not voided: it stays valid for the old identity until it expires (at most 7 days), " +
  "and anyone holding the old key can keep using it. If the old key may have leaked, ask the Rotifer team to revoke the old node.";

const SIGN_IN = "Run 'rotifer login', then run this command again.";
const LATER = "Try again later.";
const UPDATE_CLI = "Update the CLI (rotifer self-update), then try again.";
const NEW_IDENTITY =
  "To go on with a new identity, delete ~/.rotifer/identity.pem, restart the node and run 'rotifer network attest enable'.";

const FAILURES = {
  POR_NOT_LOGGED_IN: ["You are not signed in.", SIGN_IN],
  POR_SESSION_EXPIRED: ["Your sign-in has expired.", SIGN_IN],
  POR_CONSENT_REQUIRED: [
    "Nothing was enabled: enabling certificates needs your explicit agreement.",
    `Pass ${CONSENT_FLAG} to agree that this node is publicly linked to an account pseudonym.`,
  ],
  POR_CONSENT_DECLINED: ["Nothing was enabled: you did not agree.", "Run this command again if you change your mind."],
  POR_NOT_ENABLED: ["Certificates are not enabled on this node.", "Run 'rotifer network attest enable' first."],
  POR_KEY_CHANGED: ["This node's key changed, so its certificate no longer applies.", KEY_CHANGE_NOTICE],
  POR_CLIENT_NEEDS_UPGRADE: ["This CLI's native node cannot request certificates.", UPDATE_CLI],
  POR_SERVICE_NOT_OPEN: [
    "The certificate service is not open yet.",
    "Nothing to fix on your side: the node keeps running without a certificate. Try again later.",
  ],
  POR_UNREACHABLE: ["The certificate service could not be reached.", "Check your connection and try again."],
  POR_BAD_CLOUD_ENDPOINT: [
    "The Cloud endpoint is not usable for certificates: your session would be sent to it unprotected.",
    "Set ROTIFER_CLOUD_ENDPOINT (or endpoint in ~/.rotifer/cloud.json) to an https address, or plain http to this machine.",
  ],
  POR_AUD_MISMATCH: [
    "The certificate service answered for a different address than the one called, so nothing was signed.",
    "If you changed ROTIFER_CLOUD_ENDPOINT or ~/.rotifer/cloud.json, it must match the address the service is set up for. Otherwise update the CLI.",
  ],
  POR_BAD_RESPONSE: ["The certificate service sent an answer this CLI cannot use.", UPDATE_CLI],
  POR_SERVICE_ERROR: ["The certificate service could not complete the request.", LATER],
  POR_CLIENT_ERROR: ["The certificate request could not be completed on this machine.", LATER],
  // The function's own codes (supabase/functions/node-attestation/README.md).
  POR_QUOTA_EXCEEDED: [
    "This account already has certificates for 3 nodes.",
    "A slot frees up when that node's certificate expires, at most 7 days after its last renewal. " +
      "Run 'rotifer network attest disable' on a node you no longer use, then try again once its certificate has expired.",
  ],
  POR_RENEWAL_TOO_EARLY: [
    "This node got a certificate in the last 24 hours and it still has more than 48 hours left.",
    "Nothing to do if the node still has it: it renews on its own. If this machine lost its copy, try again 24 hours after that certificate was issued.",
  ],
  POR_CHALLENGE_INVALID: ["The sign-in challenge was not accepted.", "Run this command again."],
  POR_CHALLENGE_EXPIRED: ["The sign-in challenge expired before it was answered.", "Run this command again."],
  POR_BAD_SIGNATURE: ["The service did not accept this node's signature.", UPDATE_CLI],
  POR_UNSUPPORTED_KEY: ["The service does not support this node's key type.", NEW_IDENTITY],
  POR_BAD_REQUEST: ["The service did not understand the request.", UPDATE_CLI],
  POR_ACCOUNT_CLOSED: ["This account can no longer get certificates.", "Sign in with an account in good standing: rotifer login."],
  POR_PEER_BOUND_ELSEWHERE: [
    "This node's identity is already registered to another account.",
    `Sign in with that account. ${NEW_IDENTITY}`,
  ],
  POR_PEER_REVOKED: ["This node's identity has been revoked.", NEW_IDENTITY],
  POR_TOO_MANY_CHALLENGES: ["Too many certificate requests from this account.", LATER],
  POR_RATE_LIMITED: ["Too many certificate requests from this account.", LATER],
} as const satisfies Record<string, readonly [string, string]>;

export type PorErrorCode = keyof typeof FAILURES;

export class PorError extends Error {
  readonly code: PorErrorCode;
  readonly fix: string;

  /** `detail` is added to the fixed text; it must hold nothing secret. */
  constructor(code: PorErrorCode, detail?: string) {
    super(detail ? `${FAILURES[code][0]} ${detail}` : FAILURES[code][0]);
    this.name = "PorError";
    this.code = code;
    this.fix = FAILURES[code][1];
  }
}

/** Any failure as a PorError; an unexpected one loses its text, which could hold anything. */
export function asPorError(err: unknown): PorError {
  return err instanceof PorError ? err : new PorError("POR_CLIENT_ERROR");
}

/** What a refusal means. `code` comes off the network: only known ones are used. */
export function errorFromResponse(status: number, code: unknown): PorError {
  if (typeof code === "string") {
    // The function is deployed but has no keys yet: to a user, not open.
    if (code === "POR_NOT_CONFIGURED") return new PorError("POR_SERVICE_NOT_OPEN");
    if (code.startsWith("POR_") && Object.hasOwn(FAILURES, code)) return new PorError(code as PorErrorCode);
  }
  // Not the function's own answer: its gateway or a proxy spoke.
  if (status === 404) return new PorError("POR_SERVICE_NOT_OPEN");
  if (status === 401) return new PorError("POR_SESSION_EXPIRED");
  return new PorError("POR_SERVICE_ERROR");
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** The function to call under a Cloud endpoint. The session token goes here. */
export function porFunctionUrl(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new PorError("POR_BAD_CLOUD_ENDPOINT");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new PorError("POR_BAD_CLOUD_ENDPOINT");
  }
  return `${endpoint.replace(/\/+$/, "")}${POR_FUNCTION_PATH}`;
}

/** Text from the network, made safe to print on one line. */
function printable(text: string): string {
  return JSON.stringify(text.slice(0, 200));
}

export interface PorSession {
  jwt: string;
  userId: string;
}

function credentialsPath(): string {
  return join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".rotifer", CREDENTIALS_FILE);
}

/** The signed-in account, refreshing an expired session when it can. */
export async function currentSession(): Promise<PorSession> {
  await refreshTokenIfNeeded();
  const creds = loadCredentials();
  if (creds?.access_token && creds.user?.id) return { jwt: creds.access_token, userId: creds.user.id };
  throw new PorError(existsSync(credentialsPath()) ? "POR_SESSION_EXPIRED" : "POR_NOT_LOGGED_IN");
}

/** The two native calls a certificate needs; older addons lack them. */
export interface PorCapableNode {
  peerId(): string;
  signPorChallenge(aud: string, userId: string, nonce: string, challengeExp: number): PorChallengeSignature;
  setAttestation(token: string | null): void;
}

export function isPorCapable<T extends { peerId(): string }>(node: T | null | undefined): node is T & PorCapableNode {
  const n = node as Partial<PorCapableNode> | null | undefined;
  return typeof n?.signPorChallenge === "function" && typeof n?.setAttestation === "function";
}

export interface PorClientDeps {
  fetch: typeof fetch;
  session: () => Promise<PorSession>;
  functionUrl: () => string;
}

export const defaultPorClientDeps: PorClientDeps = {
  fetch: (input, init) => fetch(input, init),
  session: currentSession,
  functionUrl: () => porFunctionUrl(loadCloudConfig().endpoint),
};

export interface PorCertificate {
  token: string;
  peerId: string;
  iat: number;
  exp: number;
}

async function callFunction(
  deps: PorClientDeps,
  url: string,
  op: "challenge" | "issue",
  jwt: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let res: Response;
  let text: string;
  try {
    res = await deps.fetch(`${url}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch {
    throw new PorError("POR_UNREACHABLE");
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Handled below: a gateway's HTML page and a broken answer look alike.
  }
  if (!res.ok) throw errorFromResponse(res.status, (parsed as { error?: { code?: unknown } } | null)?.error?.code);
  if (parsed === null || typeof parsed !== "object") throw new PorError("POR_BAD_RESPONSE");
  return parsed as Record<string, unknown>;
}

const isWholeNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * One full challenge round for this node. Refuses a challenge issued for any
 * address other than the one called, so a signature made here can only be
 * spent at that address. The caller decides what to do with the certificate.
 */
export async function obtainCertificate(
  node: PorCapableNode,
  deps: PorClientDeps = defaultPorClientDeps,
): Promise<PorCertificate> {
  const url = deps.functionUrl();
  const { jwt, userId } = await deps.session();

  const challenge = await callFunction(deps, url, "challenge", jwt, {});
  const { aud, nonce, challengeExp } = challenge;
  if (typeof aud !== "string" || typeof nonce !== "string" || !isWholeNumber(challengeExp)) {
    throw new PorError("POR_BAD_RESPONSE");
  }
  if (aud !== url) throw new PorError("POR_AUD_MISMATCH", `Expected aud: ${printable(url)}. Actual aud: ${printable(aud)}.`);

  let answer: PorChallengeSignature;
  try {
    answer = node.signPorChallenge(aud, userId, nonce, challengeExp);
  } catch {
    // The native side refused the fields, and only the service supplied those
    // or, for the user id, the sign-in. Its message is not shown.
    throw new PorError("POR_BAD_RESPONSE");
  }

  const issued = await callFunction(deps, url, "issue", jwt, {
    publicKey: answer.publicKey,
    signature: answer.signature,
    nonce,
    challengeExp,
  });
  const { token, peerId, iat, exp } = issued;
  if (
    typeof token !== "string" ||
    peerId !== node.peerId() ||
    !isWholeNumber(iat) ||
    !isWholeNumber(exp) ||
    exp <= iat ||
    exp - iat > POR_LIFETIME_S
  ) {
    throw new PorError("POR_BAD_RESPONSE");
  }
  return { token, peerId, iat, exp };
}
