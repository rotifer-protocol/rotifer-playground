/**
 * Gene reference parsing — single source of truth for how user-facing
 * strings like "@xiaoba-dev/scope-cli-2026" map to Cloud Registry lookups.
 *
 * Why this exists (Issue #50 Bug 2): previously `getGene(idOrName)` only
 * recognized UUID / 64-hex content hash / plain name, so commands that
 * accepted `<gene-ref>` (`info`, `stats`, `compare`, `reputation`) silently
 * treated `@owner/name` as a plain name and returned 0 matches. Only the
 * `versions` command worked because it asks for `<owner> <name>` as two
 * separate positional arguments.
 *
 * This module centralizes the parser so every command resolves the same
 * input to the same kind, and SQL/PostgREST callers can branch on `kind`.
 */

export type GeneRef =
  | { kind: "uuid"; raw: string }
  | { kind: "contentHash"; raw: string }
  | { kind: "ownerName"; owner: string; name: string; raw: string }
  | { kind: "name"; raw: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/i;
const OWNER_NAME_RE = /^@([^/\s@]+)\/([^\s/]+)$/;
const USERNAME_RE = /^@([^/\s@]+)$/;

export function parseGeneRef(input: string): GeneRef {
  const trimmed = input.trim();
  if (UUID_RE.test(trimmed)) return { kind: "uuid", raw: trimmed };
  if (CONTENT_HASH_RE.test(trimmed)) return { kind: "contentHash", raw: trimmed };
  const m = trimmed.match(OWNER_NAME_RE);
  if (m) return { kind: "ownerName", owner: m[1], name: m[2], raw: trimmed };
  return { kind: "name", raw: trimmed };
}

/**
 * Parse a bare `@username` (no slash, no embedded gene name).
 * Returns null for any input that contains a slash or doesn't start with `@`.
 *
 * Used by `rotifer reputation @alice` to route to the developer-reputation
 * path instead of the gene-reputation path (Issue #50 Bug 3).
 */
export function parseUserRef(input: string): { username: string } | null {
  const m = input.trim().match(USERNAME_RE);
  return m ? { username: m[1] } : null;
}
