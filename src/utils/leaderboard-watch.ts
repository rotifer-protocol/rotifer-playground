import type { LeaderboardRow } from "../cloud/client.js";

/**
 * Stable identity of a leaderboard row across polls. The board folds to one
 * row per logical gene, so the logical name (owner + name) is the key — the
 * shown version (and with it the gene_id) legitimately changes when an author
 * publishes, and that must not read as a disappearance plus an arrival.
 */
export function leaderboardKey(row: LeaderboardRow): string {
  return `${row.owner_username}/${row.gene_name}`;
}

export type LeaderboardChange =
  | { kind: "new"; key: string; row: LeaderboardRow }
  | {
      kind: "tier";
      key: string;
      from: LeaderboardRow["tier"];
      to: LeaderboardRow["tier"];
    }
  | { kind: "up" | "down"; key: string; from: number; to: number };

/**
 * Diff two polls of the tiered leaderboard.
 *
 * Rank moves only exist inside a ranked tier: `tier_rank` is null for
 * `not_evaluated` rows, and a null on either side is a tier story, not a rank
 * story. A tier change is reported as such and suppresses the rank comparison
 * for that row — "#3 → #1" across two different ladders compares nothing.
 */
export function diffLeaderboard(
  prev: LeaderboardRow[],
  curr: LeaderboardRow[]
): LeaderboardChange[] {
  const prevMap = new Map(prev.map((r) => [leaderboardKey(r), r]));
  const changes: LeaderboardChange[] = [];

  for (const row of curr) {
    const key = leaderboardKey(row);
    const before = prevMap.get(key);
    if (!before) {
      changes.push({ kind: "new", key, row });
      continue;
    }
    if (before.tier !== row.tier) {
      changes.push({ kind: "tier", key, from: before.tier, to: row.tier });
      continue;
    }
    if (
      before.tier_rank != null &&
      row.tier_rank != null &&
      before.tier_rank !== row.tier_rank
    ) {
      changes.push({
        kind: row.tier_rank < before.tier_rank ? "up" : "down",
        key,
        from: before.tier_rank,
        to: row.tier_rank,
      });
    }
  }

  return changes;
}

/**
 * What the score column may show for a row. A `not_evaluated` row never shows
 * a number, even when the ledger stores one — printing a stored value next to
 * the words "not evaluated" is how a hash-derived number got read as a
 * measurement in the first place (ADR-319 D4 display decision).
 */
export function fitnessCell(row: LeaderboardRow): string {
  if (row.tier === "not_evaluated" || row.fitness_value == null) return "—";
  return row.fitness_value.toFixed(4);
}

/** Same rule for V(g): no numbers on an unevaluated row. */
export function safetyCell(row: LeaderboardRow): string {
  if (row.tier === "not_evaluated" || row.safety_score == null) return "—";
  return row.safety_score.toFixed(4);
}

/** Position column: `not_evaluated` rows have no position, not position zero. */
export function rankCell(row: LeaderboardRow): string {
  return row.tier_rank == null ? "—" : String(row.tier_rank);
}
