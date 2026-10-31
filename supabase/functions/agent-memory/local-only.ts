/**
 * The test scripts (l2-smoke.ts, parity/run-cloud.ts) create and delete
 * users and rewrite rows as a superuser, so they only ever talk to the local
 * stack. A shell profile can export SUPABASE_URL or DB_URL for a hosted
 * project (it happened on 2026-11-01: a parity run sent its calls to the
 * hosted project until this guard existed), so a variable is used only when
 * it points at this machine.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** `value` (or `fallback` when unset), refused unless its host is loopback. */
export function localUrl(name: string, value: string | undefined, fallback: string): string {
  const url = value ?? fallback;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`${name} is not a URL; these scripts run against the local stack only`);
  }
  if (!LOOPBACK.has(host)) {
    // Host only: a database URL can carry a password.
    throw new Error(`${name} points at ${host}; these scripts run against the local stack only (127.0.0.1)`);
  }
  return url;
}
