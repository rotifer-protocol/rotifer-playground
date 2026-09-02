/**
 * The §5.1 fitness formula, in one place.
 *
 *   F(g) = [S_r · ln(1 + C_util) · (1 + R_rob)] / [L · Resource_Cost]
 *
 * `L` and `Resource_Cost` in the spec are the *raw* latency and cost, so both
 * sit in the denominator and a slower, costlier gene scores lower. The
 * implementation does not divide by raw values — an unbounded denominator
 * drives F(g) to zero for any gene with a realistic latency, which is what
 * ADR-215 P1 set out to avoid. It normalizes each into a (0, 1] score first:
 *
 *   L_score    = 1 / (1 + avg_latency_ms / LATENCY_SCALE_MS)
 *   Cost_score = 1 / (1 + avg_cost / RESOURCE_SCALE_UNITS)
 *
 * Those scores are already *inverted* — lower latency means a score nearer 1 —
 * so they belong in the numerator. Dividing by them, as this code did until
 * this module existed, flips the penalty into a reward: F(g) rose with latency
 * and every gene slower than a second pinned at the 1.0 cap. The regression
 * tests in `tests/unit/fitness-formula.test.ts` hold the direction.
 */

/**
 * Latency at which L_score halves. `[N]` — provisional, uncalibrated.
 *
 * ADR-318 D2 replaces both constants with `L_ref` / `Cost_ref` — the season
 * median for the gene's own domain and fidelity, which is what makes F(g)
 * dimensionless and comparable across bindings — and marks their values `[N]`
 * pending ABM / measured calibration under RFC-001 §0. That reference scale
 * needs a season-median pipeline that does not exist yet (v0.9.3 #6); these two
 * fixed constants are the stand-ins until it does.
 */
export const LATENCY_SCALE_MS = 1000;
/**
 * Resource cost (fuel units) at which Cost_score halves. `[N]` — provisional.
 *
 * Badly out of scale, and known to be: ADR-318 recorded both constants as
 * guesses, and measured 7.7e9 fuel on a leaderboard gene from its reported
 * efficiency score. Locally, three
 * sandbox runs each over the bundled Native corpus burn 1.2M–83M fuel
 * (url-extractor 1.22M, debugger 1.44M, citation-manager 1.80M,
 * particle-spatial 83.3M), so at a 10k scale every real gene lands at a
 * Cost_score of 0.008 or below and F(g) collapses to ~0.003 — far under
 * τ = 0.3. While it divided, the same mismatch was invisible: it inflated F(g)
 * past the 1.0 cap instead. This is why `arena submit` does not gate on F(g)
 * while `hasCompleteFitnessInputs` is false: a threshold comparison against a
 * provisional scale is not an admission decision. Picking new values is a
 * protocol-parameter change under RFC-001 §0, not a code cleanup.
 */
export const RESOURCE_SCALE_UNITS = 10_000;

export interface FitnessInputs {
  /** S_r — fraction of evaluation runs that passed, in [0, 1]. */
  successRate: number;
  /** Mean wall-clock latency across the evaluation runs, in milliseconds. */
  avgLatencyMs: number;
  /** Mean fuel consumed across the evaluation runs. */
  avgResourceCost: number;
  /** C_util — input-space coverage in [0, 1]. */
  coverage: number;
  /** R_rob — adversarial robustness in [0, 1]. */
  robustness: number;
}

export interface FitnessBreakdown {
  /**
   * F(g), in (0, 2·ln 2] ≈ (0, 1.386].
   *
   * Not capped. The old `min(1.0)` was there because dividing by the
   * efficiency scores made the value unbounded — with them multiplied the
   * formula is bounded by its own factors, and ADR-318 D2 drops the cap for
   * exactly that reason: a cap erases the difference between everything above
   * it, which is what made six leaderboard genes tie at a perfect 1.000.
   */
  value: number;
  /** L_score — 1 at zero latency, falling monotonically as latency rises. */
  latencyScore: number;
  /** Cost_score — 1 at zero cost, falling monotonically as cost rises. */
  resourceEfficiency: number;
}

/** L_score: 1 at zero latency, strictly decreasing, never zero. */
export function latencyScoreFor(avgLatencyMs: number): number {
  return 1.0 / (1.0 + Math.max(avgLatencyMs, 0) / LATENCY_SCALE_MS);
}

/** Cost_score: 1 at zero cost, strictly decreasing, never zero. */
export function resourceEfficiencyFor(avgResourceCost: number): number {
  return 1.0 / (1.0 + Math.max(avgResourceCost, 0) / RESOURCE_SCALE_UNITS);
}

/**
 * F(g) from one batch of evaluation measurements.
 *
 * Multiplicative throughout: a zero in any factor collapses the score, with no
 * mutual compensation between a gene's strengths and its weaknesses.
 */
export function computeBaseFitness(inputs: FitnessInputs): FitnessBreakdown {
  const latencyScore = latencyScoreFor(inputs.avgLatencyMs);
  const resourceEfficiency = resourceEfficiencyFor(inputs.avgResourceCost);
  const quality =
    inputs.successRate * Math.log1p(inputs.coverage) * (1 + inputs.robustness);
  // Multiplied, not divided: L_score and Cost_score are already inverted, so
  // multiplying by them is what makes slower and costlier score lower. No cap —
  // every factor is bounded, so the product is too.
  const value = quality * latencyScore * resourceEfficiency;
  return { value, latencyScore, resourceEfficiency };
}
