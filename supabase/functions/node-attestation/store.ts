/**
 * AttestationStore on Postgres: the two SECURITY DEFINER functions of the
 * deferred migration 20261102200000 (supabase/migrations-deferred-v095-por/),
 * called over a connection logged in as por_issuer. That role may execute
 * these two functions and nothing else (not revoke, not the JWKS export), so
 * the function holds no credential that can read or write a table directly.
 *
 * The connection is passed in as a plain query function, so the calls here
 * are tested without a database (store.test.ts); index.ts supplies the driver.
 */

import { type AttestationStore, type IssueRecord, PorError, storeCode } from "./handler.ts";
import type { Bytes } from "./por.ts";

/** Runs one parameterised statement and returns its rows. */
export type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

/** The only role the function may connect as: por_issuer, or por_issuer.<project> through the pooler. */
export const ISSUER_ROLE = "por_issuer";

/**
 * This machine, or "db", the service name inside a local Supabase stack. Only
 * the exact name: Supabase's direct production host is db.<ref>.supabase.co.
 */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "db" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

/**
 * The modes that cannot end up in plain text. "prefer" and "allow" fall back
 * to it, and the connection would carry the issuing role's password.
 */
const TLS_MODES = ["require", "verify-full"];

/**
 * Checks that a connection string logs in as the issuing role, over TLS unless
 * the database is local. A string for postgres or any other broad role would
 * still work, with far more rights than the function needs, so it is refused
 * rather than used.
 */
export function issuerUser(dbUrl: string): string {
  let url: URL;
  try {
    url = new URL(dbUrl);
  } catch {
    throw new Error("POR_DB_URL is not a URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error("POR_DB_URL is not a postgres URL");
  const user = decodeURIComponent(url.username);
  if (user !== ISSUER_ROLE && !user.startsWith(`${ISSUER_ROLE}.`)) {
    throw new Error(`POR_DB_URL must log in as ${ISSUER_ROLE}, not "${user}"`);
  }
  // The driver takes the last value of a repeated parameter; get() returns the first.
  const sslmode = url.searchParams.getAll("sslmode").at(-1);
  if (!isLocalHost(url.hostname) && !TLS_MODES.includes(sslmode ?? "")) {
    throw new Error("POR_DB_URL must set sslmode=require or sslmode=verify-full for a database that is not local");
  }
  return user;
}

function hex(bytes: Bytes): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: unknown): Bytes {
  if (typeof text !== "string" || !/^[0-9a-f]{64}$/.test(text)) throw new PorError("POR_INTERNAL", "unexpected nonce from the database");
  return Uint8Array.from(text.match(/../g)!, (b) => parseInt(b, 16));
}

/** The single jsonb value a statement returns, as an object. */
function result(rows: Record<string, unknown>[], fn: string): Record<string, unknown> {
  const r = rows.length === 1 ? rows[0].r : undefined;
  if (r === null || typeof r !== "object" || Array.isArray(r)) throw new PorError("POR_INTERNAL", `unexpected result from ${fn}`);
  return r as Record<string, unknown>;
}

export function postgresStore(query: Query): AttestationStore {
  return {
    async challenge(userId, aud) {
      const data = result(
        await query("SELECT public.node_attestation_challenge($1::uuid, $2::text) AS r", [userId, aud]),
        "node_attestation_challenge",
      );
      if (data.error !== undefined) return { error: storeCode(data.error) };
      if (!Number.isSafeInteger(data.challenge_exp)) throw new PorError("POR_INTERNAL", "unexpected challenge from the database");
      return { nonce: fromHex(data.nonce), challengeExp: data.challenge_exp as number };
    },
    async issue(r: IssueRecord) {
      const data = result(
        await query(
          `SELECT public.node_attestation_issue($1::uuid, $2::text, decode($3::text, 'hex'), $4::bigint,
                                                $5::text, $6::text, $7::bigint, $8::bigint, $9::text) AS r`,
          [r.userId, r.aud, hex(r.nonce), r.challengeExp, r.peerId, r.sub, r.iat, r.exp, r.kid],
        ),
        "node_attestation_issue",
      );
      if (data.error !== undefined) return { error: storeCode(data.error) };
      if (data.ok !== true) throw new PorError("POR_INTERNAL", "unexpected issue result from the database");
      return { ok: true };
    },
  };
}
