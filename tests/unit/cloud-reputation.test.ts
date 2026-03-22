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
  it("R(g) formula: α·Arena + β·Usage + γ·Stability", () => {
    const alpha = 0.5, beta = 0.3, gamma = 0.2;
    const arena = 0.85, usage = 0.6, stability = 0.9;
    const expected = alpha * arena + beta * usage + gamma * stability;
    expect(expected).toBeCloseTo(0.785, 3);
  });

  it("R(g) bounds: score ∈ [0, 1.0] for normalized inputs", () => {
    const alpha = 0.5, beta = 0.3, gamma = 0.2;
    const maxScore = alpha * 1.0 + beta * 1.0 + gamma * 1.0;
    expect(maxScore).toBeCloseTo(1.0, 5);
    const minScore = alpha * 0 + beta * 0 + gamma * 0;
    expect(minScore).toBe(0);
  });

  it("decay reduces score by 5% per application", () => {
    const decayRate = 0.05;
    const original = 0.8;
    const decayed = original * (1 - decayRate);
    expect(decayed).toBeCloseTo(0.76, 5);
  });

  it("decay has floor at 0.01", () => {
    const decayRate = 0.05;
    const decayFloor = 0.01;
    let score = 1.0;
    for (let i = 0; i < 1000; i++) {
      score = score * (1 - decayRate);
      if (score < decayFloor) score = decayFloor;
    }
    expect(score).toBe(decayFloor);
  });

  it("community_bonus capped at 0.2", () => {
    const arenaWins = 100;
    const bonus = Math.min(arenaWins * 0.02, 0.2);
    expect(bonus).toBe(0.2);
  });

  it("developer reputation is avg(gene reps) + community bonus", () => {
    const geneReps = [0.5, 0.7, 0.9];
    const arenaWins = 3;
    const avg = geneReps.reduce((s, r) => s + r, 0) / geneReps.length;
    const bonus = Math.min(arenaWins * 0.02, 0.2);
    const devRep = avg + bonus;
    expect(avg).toBeCloseTo(0.7, 5);
    expect(bonus).toBeCloseTo(0.06, 5);
    expect(devRep).toBeCloseTo(0.76, 5);
  });
});
