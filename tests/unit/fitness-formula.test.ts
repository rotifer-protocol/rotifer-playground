import { describe, it, expect } from "vitest";
import {
  computeBaseFitness,
  latencyScoreFor,
  resourceEfficiencyFor,
  LATENCY_SCALE_MS,
  RESOURCE_SCALE_UNITS,
  type FitnessInputs,
} from "../../src/utils/fitness-formula.js";

/**
 * The direction of the latency and cost terms.
 *
 * Until this suite existed the normalized L_score sat in the *denominator*, so
 * F(g) climbed with latency and every gene slower than a second pinned at the
 * 1.0 cap — a locally measured hello-world at 8.4s scored a perfect 1.0000.
 * Arena ranking was selecting against performance. These tests fail if the
 * penalty ever flips back into a reward.
 */

const BASE: FitnessInputs = {
  successRate: 1.0,
  avgLatencyMs: 0,
  avgResourceCost: 0,
  // The placeholders arena-submit still uses for C_util and R_rob.
  coverage: 0.5,
  robustness: 0.5,
};

const fitnessAtLatency = (avgLatencyMs: number) =>
  computeBaseFitness({ ...BASE, avgLatencyMs }).value;
const fitnessAtCost = (avgResourceCost: number) =>
  computeBaseFitness({ ...BASE, avgResourceCost }).value;

describe("F(g) latency direction", () => {
  it("scores a faster gene above a slower one", () => {
    expect(fitnessAtLatency(5)).toBeGreaterThan(fitnessAtLatency(12));
    expect(fitnessAtLatency(12)).toBeGreaterThan(fitnessAtLatency(100));
    expect(fitnessAtLatency(100)).toBeGreaterThan(fitnessAtLatency(1000));
    expect(fitnessAtLatency(1000)).toBeGreaterThan(fitnessAtLatency(8370));
  });

  it("falls monotonically across the whole measured range", () => {
    const ladder = [0, 1, 5, 12, 50, 100, 500, 1000, 3000, 8370, 60_000];
    const scores = ladder.map(fitnessAtLatency);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it("does not let slow genes pin at the 1.0 cap", () => {
    // The old shape returned exactly 1.0 for everything at or above ~1s.
    expect(fitnessAtLatency(1000)).toBeLessThan(1.0);
    expect(fitnessAtLatency(8370)).toBeLessThan(fitnessAtLatency(100) / 2);
  });
});

describe("F(g) resource-cost direction", () => {
  it("scores a cheaper gene above a costlier one", () => {
    expect(fitnessAtCost(100)).toBeGreaterThan(fitnessAtCost(10_000));
    expect(fitnessAtCost(10_000)).toBeGreaterThan(fitnessAtCost(1_000_000));
  });
});

describe("normalized component scores", () => {
  it("halves L_score at the latency scale constant", () => {
    expect(latencyScoreFor(0)).toBe(1.0);
    expect(latencyScoreFor(LATENCY_SCALE_MS)).toBeCloseTo(0.5, 10);
  });

  it("halves Cost_score at the resource scale constant", () => {
    expect(resourceEfficiencyFor(0)).toBe(1.0);
    expect(resourceEfficiencyFor(RESOURCE_SCALE_UNITS)).toBeCloseTo(0.5, 10);
  });

  it("reports the same component scores it scored with", () => {
    const b = computeBaseFitness({ ...BASE, avgLatencyMs: 250, avgResourceCost: 5000 });
    expect(b.latencyScore).toBeCloseTo(0.8, 10);
    expect(b.resourceEfficiency).toBeCloseTo(2 / 3, 10);
  });
});

describe("multiplicative collapse", () => {
  it("returns zero when no run succeeded", () => {
    expect(computeBaseFitness({ ...BASE, successRate: 0 }).value).toBe(0);
  });

  it("returns zero when coverage is zero", () => {
    expect(computeBaseFitness({ ...BASE, coverage: 0 }).value).toBe(0);
  });

  it("is bounded by its own factors, with no cap applied", () => {
    // ADR-318 D2's range: (0, 2·ln 2] ≈ (0, 1.386]. The old min(1.0) is gone —
    // it erased every difference above 1.0, which is how six leaderboard genes
    // came to tie at a perfect 1.000.
    const best = computeBaseFitness({
      successRate: 1,
      avgLatencyMs: 0,
      avgResourceCost: 0,
      coverage: 1,
      robustness: 1,
    }).value;
    expect(best).toBeCloseTo(2 * Math.LN2, 10);
    expect(best).toBeGreaterThan(1.0);
  });

  it("keeps two near-perfect genes distinguishable instead of tying them", () => {
    const perfect = { successRate: 1, avgResourceCost: 0, coverage: 1, robustness: 1 };
    const a = computeBaseFitness({ ...perfect, avgLatencyMs: 1 }).value;
    const b = computeBaseFitness({ ...perfect, avgLatencyMs: 2 }).value;
    expect(a).toBeGreaterThan(b);
  });
});
