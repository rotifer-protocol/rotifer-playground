/**
 * §38.2 gene-level permission check, run before every read,
 * write to an existing entry, and delete.
 *
 * The database already limits every row to the signed-in account (RLS).
 * This narrows it further to the genes the entry's scope allows. The caller
 * gene's id and domain are declared by the user's own client — the gene
 * runs on their machine — so this protects an agent's genes from each
 * other, not one account from another (migration 20261030220000, R3).
 */

import {
  type AccessScope,
  type CallerGene,
  type EntryRow,
  type MemoryAccessPolicy,
  MemoryError,
  type RetentionPolicy,
} from "./wire.ts";

export type AccessOp = "read" | "write";

/**
 * Returns null when allowed, otherwise the reason it is not. A reason names
 * only the key the caller sent and the scope — never the creator gene or its
 * domain, which would hand another gene's identity to the caller.
 */
export function accessDenial(scope: AccessScope, entry: EntryRow, caller: CallerGene): string | null {
  switch (scope) {
    case "ALL_GENES":
      return null;
    case "CREATOR_GENE_ONLY":
      return caller.geneId === entry.created_by ? null : `'${entry.key}' is CREATOR_GENE_ONLY`;
    case "SAME_DOMAIN":
      // An entry with no recorded domain (e.g. imported without one) falls
      // back to its creator only.
      if (entry.created_by_domain === null) {
        return caller.geneId === entry.created_by ? null : `'${entry.key}' is SAME_DOMAIN`;
      }
      return caller.domain === entry.created_by_domain ? null : `'${entry.key}' is SAME_DOMAIN`;
    case "DEPLOYER_CONFIGURED":
      return `'${entry.key}' is DEPLOYER_CONFIGURED, and this version has no DataPolicy field to configure it (§30.2), so access is denied`;
  }
}

export function assertAccess(op: AccessOp, entry: EntryRow, caller: CallerGene): void {
  const scope = op === "read" ? entry.read_scope : entry.write_scope;
  const reason = accessDenial(scope, entry, caller);
  if (reason !== null) throw new MemoryError("MEMORY_ACCESS_DENIED", `${op} denied: ${reason}`);
}

/** Structural equality of JSON values; object key order does not matter (as in jsonb). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  const ka = Object.keys(a as object), kb = Object.keys(b as object);
  return ka.length === kb.length &&
    ka.every((k) => k in (b as object) && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Only the creator gene may change an existing entry's accessPolicy or
 * retentionPolicy, including resetting retentionPolicy to null ("inherit").
 * Sending what the entry already has is
 * not a change. `retention` undefined = not sent. agent_memory_write
 * enforces the same rule in the database.
 */
export function assertPolicyChange(
  entry: EntryRow,
  caller: CallerGene,
  policy: MemoryAccessPolicy | undefined,
  retention: RetentionPolicy | null | undefined,
): void {
  if (caller.geneId === entry.created_by) return;
  const policyChanged = policy !== undefined && (
    policy.readScope !== entry.read_scope || policy.writeScope !== entry.write_scope ||
    policy.sharePolicy !== entry.share_policy
  );
  const retentionChanged = retention !== undefined && !jsonEqual(retention, entry.retention_policy);
  if (policyChanged || retentionChanged) {
    throw new MemoryError(
      "MEMORY_ACCESS_DENIED",
      `only the gene that created '${entry.key}' may change its accessPolicy or retentionPolicy`,
    );
  }
}

export function canRead(entry: EntryRow, caller: CallerGene): boolean {
  return accessDenial(entry.read_scope, entry, caller) === null;
}
