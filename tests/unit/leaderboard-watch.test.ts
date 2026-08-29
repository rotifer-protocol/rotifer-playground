import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  diffLeaderboard,
  fitnessCell,
  leaderboardKey,
  rankCell,
  safetyCell,
} from "../../src/utils/leaderboard-watch.js";
import type { LeaderboardRow } from "../../src/cloud/client.js";

function row(overrides: Partial<LeaderboardRow>): LeaderboardRow {
  return {
    tier: "under_evaluation",
    tier_rank: 1,
    gene_id: "00000000-0000-0000-0000-000000000001",
    gene_name: "gene-a",
    gene_version: "0.1.0",
    owner_username: "alice",
    domain: "test.domain",
    fidelity: "Native",
    fitness_value: 0.5,
    base_fitness: 0.5,
    fidelity_discount: 0,
    safety_score: 1,
    evaluation_method: "sandbox",
    evaluation_n: 3,
    unique_callers: 0,
    invalidation_reason: null,
    total_calls: 0,
    last_evaluated: null,
    versions_on_board: 1,
    ...overrides,
  };
}

describe("leaderboardKey", () => {
  it("identifies a logical gene across version changes", () => {
    const before = row({ gene_id: "id-1", gene_version: "0.1.0" });
    const after = row({ gene_id: "id-2", gene_version: "0.2.0" });
    expect(leaderboardKey(before)).toBe(leaderboardKey(after));
  });
});

describe("diffLeaderboard", () => {
  it("returns nothing when nothing changed", () => {
    const rows = [row({})];
    expect(diffLeaderboard(rows, rows)).toEqual([]);
  });

  it("reports a logical gene it has not seen", () => {
    const changes = diffLeaderboard([], [row({})]);
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("new");
  });

  it("does not report a republish as a new arrival", () => {
    const before = row({ gene_id: "id-1", gene_version: "0.1.0" });
    const after = row({ gene_id: "id-2", gene_version: "0.2.0" });
    expect(diffLeaderboard([before], [after])).toEqual([]);
  });

  it("reports rank moves inside a ranked tier", () => {
    const changes = diffLeaderboard(
      [row({ tier_rank: 3 })],
      [row({ tier_rank: 1 })]
    );
    expect(changes).toEqual([
      { kind: "up", key: "alice/gene-a", from: 3, to: 1 },
    ]);
    const down = diffLeaderboard([row({ tier_rank: 1 })], [row({ tier_rank: 4 })]);
    expect(down[0].kind).toBe("down");
  });

  it("reports a tier change as a tier change, never as a rank move", () => {
    const changes = diffLeaderboard(
      [row({ tier: "not_evaluated", tier_rank: null })],
      [row({ tier: "under_evaluation", tier_rank: 1 })]
    );
    expect(changes).toEqual([
      {
        kind: "tier",
        key: "alice/gene-a",
        from: "not_evaluated",
        to: "under_evaluation",
      },
    ]);
  });

  it("never compares ranks across a null", () => {
    // Same tier, but one side has no position: nothing rankable happened.
    const changes = diffLeaderboard(
      [row({ tier: "not_evaluated", tier_rank: null })],
      [row({ tier: "not_evaluated", tier_rank: null })]
    );
    expect(changes).toEqual([]);
  });
});

describe("score cells", () => {
  it("never prints a stored number on a not_evaluated row", () => {
    // The guarded regression: an invalidated 1.000 next to "not evaluated"
    // is exactly how a hash-derived number got read as a measurement.
    const r = row({
      tier: "not_evaluated",
      tier_rank: null,
      fitness_value: 1.0,
      safety_score: 1.0,
    });
    expect(fitnessCell(r)).toBe("—");
    expect(safetyCell(r)).toBe("—");
    expect(rankCell(r)).toBe("—");
  });

  it("prints measured scores on ranked tiers, and dashes for nulls", () => {
    expect(fitnessCell(row({ fitness_value: 0.5014 }))).toBe("0.5014");
    expect(fitnessCell(row({ fitness_value: null }))).toBe("—");
    expect(safetyCell(row({ safety_score: null }))).toBe("—");
    expect(rankCell(row({ tier_rank: 7 }))).toBe("7");
  });
});

describe("the unfiltered rankings path stays deleted", () => {
  // arena watch served invalidated scores for as long as a raw
  // order-by-fitness reader existed; these assertions make re-adding one a
  // red test instead of a silent regression.
  const src = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");

  it("arena watch reads the tiered leaderboard", () => {
    const watch = src("src/commands/arena-watch.ts");
    expect(watch).toContain("arenaLeaderboard");
    expect(watch).not.toContain("arenaRankings");
  });

  it("the cloud client no longer offers a raw rankings reader", () => {
    expect(src("src/cloud/client.ts")).not.toContain("arenaRankings");
  });
});
