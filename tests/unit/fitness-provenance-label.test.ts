/**
 * What a submission is allowed to call itself (ADR-318 D4, v0.9.3 plan §3.4 ④).
 *
 * Running in the sandbox is necessary but not sufficient to record a score as
 * `sandbox`. Two of the five §5.1 inputs are still constants, and the
 * denominator divides by efficiency scores instead of multiplying by them, so
 * F(g) is capped at 1.000 and *rises* with latency. ADR-318 D2 supersedes
 * ADR-215 P1's claim that the direction was equivalent, and D4 requires the
 * entry to be marked `estimated` while that holds.
 *
 * The point of these tests is the pair of them: the label has to go down to
 * `estimated`, and the run count has to survive anyway. Without the run count
 * an author is told "never measured — run arena submit", which for a Gene that
 * did run is both false and a waste of their afternoon.
 *
 * The arithmetic tests are here because the reason for the label should be
 * checkable, not taken on trust. If someone later flips
 * `hasCompleteFitnessInputs` without fixing the denominator, the curve tests
 * still describe what the number does.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SUBMIT_SRC = readFileSync(join(process.cwd(), "src/commands/arena-submit.ts"), "utf-8");

/** The shipped formula, transcribed. Kept in sync by the source assertions below. */
function fitnessAsShipped(latencyMs: number, resourceCost: number, successRate = 1.0): number {
  const coverage = 0.5;
  const robustness = 0.5;
  const latencyScore = 1.0 / (1.0 + latencyMs / 1000.0);
  const resourceEfficiency = 1.0 / (1.0 + resourceCost / 10000.0);
  const numerator = successRate * Math.log1p(coverage) * (1 + robustness);
  const denominator = Math.max(latencyScore, 0.001) * Math.max(resourceEfficiency, 0.001);
  return Math.min(denominator > 0 ? numerator / denominator : 0, 1.0);
}

describe("fitness inputs are declared incomplete", () => {
  it("ships with the completeness flag false", () => {
    expect(SUBMIT_SRC).toMatch(/const hasCompleteFitnessInputs = false;/);
  });

  it("requires both a sandbox run and complete inputs before recording `sandbox`", () => {
    // Either condition alone must not be enough. Pinning the expression keeps a
    // future edit from quietly restoring `didRunInSandbox ? "sandbox" : ...`.
    expect(SUBMIT_SRC).toMatch(
      /\(didRunInSandbox && hasCompleteFitnessInputs\) \? "sandbox" : "estimated"/,
    );
  });

  it("keeps the run count tied to execution, not to the label", () => {
    expect(SUBMIT_SRC).toMatch(/evaluation_n: didRunInSandbox \? SANDBOX_RUNS : undefined/);
    expect(SUBMIT_SRC).not.toMatch(/evaluation_n: evaluationMethod === "sandbox"/);
  });

  it("still uploads latency and cost, which D2's reference medians are computed from", () => {
    expect(SUBMIT_SRC).toMatch(/latency_score: fitness\.latencyScore/);
    expect(SUBMIT_SRC).toMatch(/resource_efficiency: fitness\.resourceEfficiency/);
  });
});

describe("the reason the label is withheld", () => {
  it("caps at 1.000 for anything slower than roughly 645ms", () => {
    expect(fitnessAsShipped(1000, 0)).toBe(1.0);
    expect(fitnessAsShipped(5000, 0)).toBe(1.0);
    expect(fitnessAsShipped(60000, 0)).toBe(1.0);
  });

  it("rewards being slower — the denominator is inverted", () => {
    const fast = fitnessAsShipped(50, 0);
    const slow = fitnessAsShipped(400, 0);
    expect(slow).toBeGreaterThan(fast);
  });

  it("gives a gene that returns instantly the worst score it can produce", () => {
    // 0ms is the floor of the range, not the ceiling. This is the defect in one
    // assertion: the best possible latency yields the lowest possible fitness.
    const instant = fitnessAsShipped(0, 0);
    expect(instant).toBeCloseTo(Math.log1p(0.5) * 1.5, 10);
    expect(instant).toBeLessThan(1.0);
    for (const ms of [1, 10, 100, 500]) {
      expect(fitnessAsShipped(ms, 0)).toBeGreaterThanOrEqual(instant);
    }
  });

  it("cannot distinguish three genes that all take longer than the cap", () => {
    // Why the particle family all scored exactly 1.0000 despite measurably
    // different latencies: brute force, spatial hashing and Barnes-Hut are
    // indistinguishable once every one of them is past the cap.
    const scores = [700, 900, 1200].map((ms) => fitnessAsShipped(ms, 0));
    expect(new Set(scores).size).toBe(1);
    expect(scores[0]).toBe(1.0);
  });
});
