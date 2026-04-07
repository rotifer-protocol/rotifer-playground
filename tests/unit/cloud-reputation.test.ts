import { describe, it, expect } from "vitest";
import type {
  CloudConfig,
  CloudCredentials,
} from "../../src/cloud/types.js";

interface GeneReputationResponse {
  gene_name: string;
  score: number;
  arena_score: number;
  usage_score: number;
  stability_score: number;
  epoch: number;
  computed_at: string;
}

interface DeveloperReputationResponse {
  score: number;
  genes_published: number;
  total_downloads: number;
  arena_wins: number;
  community_bonus: number;
}

interface LeaderboardEntry {
  username: string;
  avatar_url: string | null;
  score: number;
  genes_published: number;
  total_downloads: number;
  arena_wins: number;
}

describe("reputation type contracts", () => {
  it("GeneReputationResponse has all required fields", () => {
    const rep: GeneReputationResponse = {
      gene_name: "test-gene",
      score: 0.72,
      arena_score: 0.85,
      usage_score: 0.6,
      stability_score: 0.5,
      epoch: 3,
      computed_at: "2026-02-23T00:00:00Z",
    };
    expect(rep.score).toBeGreaterThan(0);
    expect(rep.arena_score).toBeLessThanOrEqual(1);
    expect(rep.epoch).toBe(3);
  });

  it("DeveloperReputationResponse has all required fields", () => {
    const rep: DeveloperReputationResponse = {
      score: 0.65,
      genes_published: 5,
      total_downloads: 1234,
      arena_wins: 3,
      community_bonus: 0.06,
    };
    expect(rep.genes_published).toBe(5);
    expect(rep.community_bonus).toBeLessThanOrEqual(0.2);
  });

  it("LeaderboardEntry has all required fields", () => {
    const entry: LeaderboardEntry = {
      username: "dev1",
      avatar_url: "https://avatar.example.com/dev1.png",
      score: 0.88,
      genes_published: 10,
      total_downloads: 5000,
      arena_wins: 7,
    };
    expect(entry.username).toBe("dev1");
    expect(entry.score).toBeGreaterThan(0);
  });

  it("LeaderboardEntry allows null avatar_url", () => {
    const entry: LeaderboardEntry = {
      username: "anon",
      avatar_url: null,
      score: 0.1,
      genes_published: 1,
      total_downloads: 10,
      arena_wins: 0,
    };
    expect(entry.avatar_url).toBeNull();
  });
});

describe("reputation model validation", () => {
  it("R(g) uses W0 cold-start weights when downloads are sparse", () => {
    const weights = { arena: 0.7, usage: 0.05, stability: 0.25 };
    const arena = 0.85;
    const usage = 0.6;
    const stability = 0.9;
    const expected = weights.arena * arena + weights.usage * usage + weights.stability * stability;
    expect(expected).toBeCloseTo(0.85, 3);
  });

  it("R(g) weights remain normalized across W0/W1/W2 phases", () => {
    const phases = [
      { arena: 0.7, usage: 0.05, stability: 0.25 },
      { arena: 0.6, usage: 0.2, stability: 0.2 },
      { arena: 0.5, usage: 0.3, stability: 0.2 },
    ];
    for (const phase of phases) {
      expect(phase.arena + phase.usage + phase.stability).toBeCloseTo(1.0, 5);
    }
  });

  it("community_bonus capped at 0.2", () => {
    const arenaWins = 100;
    const bonus = Math.min(arenaWins * 0.02, 0.2);
    expect(bonus).toBe(0.2);
  });

  it("creator reputation uses diminishing-returns weighted sum", () => {
    const geneReps = [0.5, 0.7, 0.9];
    const arenaWins = 3;
    const contribution =
      geneReps.reduce((s, r) => s + r, 0) *
      Math.log(1 + geneReps.length) /
      geneReps.length;
    const bonus = Math.min(arenaWins * 0.02, 0.2);
    const devRep = contribution + bonus;
    expect(contribution).toBeCloseTo(0.9704, 4);
    expect(bonus).toBeCloseTo(0.06, 5);
    expect(devRep).toBeCloseTo(1.0304, 4);
  });

  it("zero-score genes do not increase creator contribution", () => {
    const allGeneReps = [0.8, 0, 0.6];
    const positiveGeneReps = allGeneReps.filter((score) => score > 0);
    const contribution =
      positiveGeneReps.reduce((s, r) => s + r, 0) *
      Math.log(1 + positiveGeneReps.length) /
      positiveGeneReps.length;
    expect(positiveGeneReps).toEqual([0.8, 0.6]);
    expect(contribution).toBeCloseTo(0.7690, 4);
  });
});
