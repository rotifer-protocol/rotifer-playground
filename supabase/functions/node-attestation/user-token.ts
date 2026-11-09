/**
 * Checks the caller's Supabase access token inside the function, before
 * asking Supabase Auth about it. The platform's verify_jwt gate is off for
 * this function: Supabase has not documented it working with ES256 signing
 * keys. So no request with a missing, forged or expired token reaches Auth.
 *
 * Only ES256 is accepted, the algorithm this project's Auth signs with. The
 * token's iss is not compared: the keys are this project's own, and iss
 * depends on which of the project's domains served the sign-in.
 *
 * This check cannot see a session revoked since the token was issued, so a
 * token that passes still goes to Auth (authenticator, below).
 *
 * Keys come from the project's published JWKS rather than the SUPABASE_JWKS
 * variable, because the documentation says how that address behaves during a
 * key rotation (cached at the edge for 10 minutes, do not cache for longer)
 * and says nothing about when the variable changes in a running function.
 */

import { type Bytes, fromB64url } from "./por.ts";

const MAX_TOKEN_CHARS = 8192;
const CACHE_SECONDS = 600;
/** An unknown kid can be a newly published key, or anyone's random string. */
const UNKNOWN_KID_REFETCH_SECONDS = 60;
const FAILED_FETCH_RETRY_SECONDS = 5;
const FETCH_TIMEOUT_MS = 5000;

const decoder = new TextDecoder("utf-8", { fatal: true });

function jsonPart(part: string): Record<string, unknown> | null {
  const bytes = fromB64url(part);
  if (bytes === null) return null;
  try {
    const value = JSON.parse(decoder.decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function importKeys(jwks: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  const listed = (jwks as { keys?: unknown } | null)?.keys;
  for (const k of Array.isArray(listed) ? listed : []) {
    if (k?.kty !== "EC" || typeof k.kid !== "string" || (k.alg !== undefined && k.alg !== "ES256")) continue;
    try {
      keys.set(k.kid, await crypto.subtle.importKey("jwk", { kty: k.kty, crv: k.crv, x: k.x, y: k.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]));
    } catch {
      continue;
    }
  }
  if (keys.size === 0) throw new Error("the project publishes no usable ES256 key");
  return keys;
}

/** Fetches the project's public keys. A failure rejects, and the request is refused. */
export function fetchProjectJwks(supabaseUrl: string): () => Promise<unknown> {
  return async () => {
    const res = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`the JWKS address answered ${res.status}`);
    return await res.json();
  };
}

/**
 * Resolves whether a token is a live, correctly signed user token. Rejects
 * when the keys cannot be had, so that the request fails closed.
 */
export function userTokenCheck(fetchJwks: () => Promise<unknown>, nowSeconds: () => number): (jwt: string) => Promise<boolean> {
  let keys: Map<string, CryptoKey> | null = null;
  let loadedAt = -Infinity;
  let failedAt = -Infinity;
  let loading: Promise<void> | null = null;

  function load(): Promise<void> {
    loading ??= (async () => {
      try {
        keys = await importKeys(await fetchJwks());
        loadedAt = nowSeconds();
      } catch (err) {
        failedAt = nowSeconds();
        throw err;
      } finally {
        loading = null;
      }
    })();
    return loading;
  }

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    const now = nowSeconds();
    if (keys === null || now - loadedAt >= CACHE_SECONDS || (!keys.has(kid) && now - loadedAt >= UNKNOWN_KID_REFETCH_SECONDS)) {
      if (now - failedAt < FAILED_FETCH_RETRY_SECONDS) throw new Error("the signing keys are unavailable");
      await load();
    }
    return keys?.get(kid) ?? null;
  }

  return async (jwt) => {
    if (jwt.length > MAX_TOKEN_CHARS) return false;
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const header = jsonPart(parts[0]);
    const claims = jsonPart(parts[1]);
    if (header === null || claims === null) return false;
    if (header.alg !== "ES256" || header.crit !== undefined || typeof header.kid !== "string" || header.kid === "") return false;
    if (typeof claims.exp !== "number" || claims.exp <= nowSeconds()) return false;
    if (claims.role !== "authenticated" || typeof claims.sub !== "string" || claims.sub === "") return false;
    // An anonymous sign-in needs no registration, so a per-account limit would not hold.
    if (claims.is_anonymous === true) return false;
    const signature: Bytes | null = fromB64url(parts[2]);
    if (signature === null || signature.length !== 64) return false;
    const key = await keyFor(header.kid);
    if (key === null) return false;
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  };
}

/** The caller's user id, or null. Auth is asked only about a token that passed the local check. */
export function authenticator(
  check: (jwt: string) => Promise<boolean>,
  askAuth: (jwt: string) => Promise<string | null>,
): (authorization: string | null) => Promise<string | null> {
  return async (authorization) => {
    const jwt = authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!jwt || !(await check(jwt))) return null;
    return await askAuth(jwt);
  };
}
