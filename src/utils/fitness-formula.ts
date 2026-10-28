/**
 * The §5.1 fitness formula, in one place, normalized to [0, 1] (ADR-345):
 *
 *   F(g) = S_r · log₂(1 + C_util) · (1 + R_rob)/2 · L_score · Cost_score
 *
 * Five factors, each in [0, 1], so F(g) is in [0, 1] with no cap; the maximum,
 * exactly 1, is S_r = C_util = R_rob = 1 at zero latency and cost. This equals
 * the ADR-318 D2 form divided by 2·ln 2, but is written as the product so the
 * maximum comes out as exactly 1 rather than as a quotient that could round
 * past it. The spec's original statement was
 *
 *   F(g) = [S_r · ln(1 + C_util) · (1 + R_rob)] / [L · Resource_Cost]
 *
 * `L` and `Resource_Cost` in the spec are the *raw* latency and cost, so both
 * sit in the denominator and a slower, costlier gene scores lower. The
 * implementation does not divide by raw values — an unbounded denominator
 * drives F(g) to zero for any gene with a realistic latency, which is what
 * ADR-215 P1 set out to avoid. It normalizes each into a (0, 1] score first,
 * against a reference scale (ADR-318 D2):
 *
 *   L_score    = 1 / (1 + avg_latency_ms / L_ref)
 *   Cost_score = 1 / (1 + avg_cost / Cost_ref)
 *
 * L_ref / Cost_ref are the current-season median of the gene's own domain and
 * fidelity, computed by the registry (`get_fitness_reference`); a gene exactly
 * at its peers' median scores 1/2 on each. While the season has too few
 * measured genes, or the registry cannot be reached, the fixed constants below
 * stand in (FALLBACK_REFERENCE).
 *
 * Those scores are already *inverted* — lower latency means a score nearer 1 —
 * so they belong in the numerator. Dividing by them, as this code did until
 * this module existed, flips the penalty into a reward: F(g) rose with latency
 * and every gene slower than a second pinned at the 1.0 cap. The regression
 * tests in `tests/unit/fitness-formula.test.ts` hold the direction.
 */

/**
 * Which formula `computeBaseFitness` implements, numbered as rotifer-core's
 * `fitness::FORMULA_VERSION`: 1 additive, 2 multiplicative in (0, 2·ln 2]
 * (ADR-318 D2), 3 multiplicative normalized to [0, 1] (ADR-345). Sent with
 * every Arena upload as `formula_version`, so the registry can tell the scales
 * apart.
 */
export const FITNESS_FORMULA_VERSION = 3;

/**
 * Fallback L_ref: latency at which L_score halves when no season median is
 * available. `[N]` — provisional, uncalibrated.
 *
 * ADR-318 D2 defines `L_ref` / `Cost_ref` as the season median for the gene's
 * own domain and fidelity, which is what makes F(g) dimensionless and
 * comparable across bindings. The registry computes it (v0.9.3 #6); these two
 * fixed constants are used only while that median does not exist for a group
 * — too few measured genes this season — or cannot be fetched.
 */
export const LATENCY_SCALE_MS = 1000;
/**
 * Fallback Cost_ref: resource cost (fuel units) at which Cost_score halves
 * when no season median is available. `[N]` — provisional.
 *
 * Badly out of scale, and known to be: ADR-318 recorded both constants as
 * guesses, and measured 7.7e9 fuel on a leaderboard gene from its reported
 * efficiency score. Locally, three
 * sandbox runs each over the bundled Native corpus burn 1.2M–83M fuel
 * (url-extractor 1.22M, debugger 1.44M, citation-manager 1.80M,
 * particle-spatial 83.3M), so at a 10k scale every real gene lands at a
 * Cost_score of 0.008 or below and F(g) collapses to ~0.002 — far under
 * any admission threshold. While it divided, the same mismatch was invisible: it inflated F(g)
 * past the 1.0 cap instead. This is why `arena submit` does not gate on F(g)
 * while `hasCompleteFitnessInputs` is false: a threshold comparison against a
 * provisional scale is not an admission decision. Picking new values is a
 * protocol-parameter change under RFC-001 §0, not a code cleanup.
 */
export const RESOURCE_SCALE_UNITS = 10_000;

/** The scale the two efficiency terms are measured against (ADR-318 D2). */
export interface ReferenceScale {
  /** L_ref, in milliseconds. */
  latencyMs: number;
  /** Cost_ref, in fuel units. */
  resourceCost: number;
}

/** The fixed constants, used whenever no season median is available. */
export const FALLBACK_REFERENCE: Readonly<ReferenceScale> = Object.freeze({
  latencyMs: LATENCY_SCALE_MS,
  resourceCost: RESOURCE_SCALE_UNITS,
});

/** Both values finite and positive; anything else would divide by zero or flip a sign. */
export function isUsableReference(reference: ReferenceScale): boolean {
  return (
    Number.isFinite(reference.latencyMs) && reference.latencyMs > 0 &&
    Number.isFinite(reference.resourceCost) && reference.resourceCost > 0
  );
}

/** One row of `get_fitness_reference`: the season median for a (domain, fidelity) group. */
export interface SeasonReferenceRow {
  l_ref_ms: number;
  cost_ref: number;
  sample_genes: number;
  season_number: number;
}

/**
 * `code` on the error a reference fetcher throws when the registry has no
 * `get_fitness_reference` (HTTP 404): a registry from before the migration,
 * whose arena_entries has no reference columns either. A code rather than an
 * error class, so the check survives two copies of this module.
 */
export const REFERENCE_FUNCTION_MISSING = "REFERENCE_FUNCTION_MISSING";

export interface ResolvedReference {
  scale: ReferenceScale;
  source: "season-median" | "fallback";
  /**
   * Whether a submission may record this reference in the row. False only
   * when the registry said it has no `get_fitness_reference` (404): the
   * columns ship in the same migration as the function, so that registry
   * would reject them. Any other failure — a timeout, a 500 — still records
   * the fallback with its constants: the upsert keeps columns it is not sent,
   * so leaving them out would leave an older median on a row whose F(g) used
   * the constants, and the row could no longer be recomputed on its own.
   */
  isRecordable: boolean;
  /** Why the fallback was used; absent for a season median. */
  reason?: string;
  sampleGenes?: number;
  seasonNumber?: number;
}

/**
 * The reference scale for one gene's F(g): its group's season median when the
 * registry has one, the fixed constants otherwise. Never throws — a missing
 * median is a reason to fall back, not to fail the evaluation.
 */
export async function resolveFitnessReference(
  domain: string,
  fidelity: string,
  fetchReference: (domain: string, fidelity: string) => Promise<SeasonReferenceRow | null>,
): Promise<ResolvedReference> {
  let row: SeasonReferenceRow | null;
  try {
    row = await fetchReference(domain, fidelity);
  } catch (err) {
    const isFunctionMissing = (err as { code?: unknown } | null)?.code === REFERENCE_FUNCTION_MISSING;
    return {
      scale: { ...FALLBACK_REFERENCE },
      source: "fallback",
      isRecordable: !isFunctionMissing,
      reason: isFunctionMissing
        ? "the registry has no season median yet (get_fitness_reference is not deployed)"
        : `the registry's season median could not be read (${(err as Error).message})`,
    };
  }
  if (row === null) {
    return {
      scale: { ...FALLBACK_REFERENCE },
      source: "fallback",
      isRecordable: true,
      reason: `too few measured ${domain} / ${fidelity} genes this season for a median`,
    };
  }
  const scale = { latencyMs: Number(row.l_ref_ms), resourceCost: Number(row.cost_ref) };
  if (!isUsableReference(scale)) {
    return {
      scale: { ...FALLBACK_REFERENCE },
      source: "fallback",
      isRecordable: true,
      reason: "the registry returned a median that is not a positive number",
    };
  }
  return {
    scale,
    source: "season-median",
    isRecordable: true,
    sampleGenes: row.sample_genes,
    seasonNumber: row.season_number,
  };
}

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
   * F(g), in [0, 1] (ADR-345).
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

/** L_score: 1 at zero latency, 1/2 at L_ref, strictly decreasing, never zero. */
export function latencyScoreFor(avgLatencyMs: number, latencyRefMs: number = LATENCY_SCALE_MS): number {
  return 1.0 / (1.0 + Math.max(avgLatencyMs, 0) / latencyRefMs);
}

/** Cost_score: 1 at zero cost, 1/2 at Cost_ref, strictly decreasing, never zero. */
export function resourceEfficiencyFor(avgResourceCost: number, costRef: number = RESOURCE_SCALE_UNITS): number {
  return 1.0 / (1.0 + Math.max(avgResourceCost, 0) / costRef);
}

/**
 * F(g) from one batch of evaluation measurements, against `reference` (the
 * fixed constants when omitted, or when the given scale is not usable).
 *
 * Multiplicative throughout: a zero in any factor collapses the score, with no
 * mutual compensation between a gene's strengths and its weaknesses.
 */
export function computeBaseFitness(
  inputs: FitnessInputs,
  reference: ReferenceScale = FALLBACK_REFERENCE,
): FitnessBreakdown {
  const scale = isUsableReference(reference) ? reference : FALLBACK_REFERENCE;
  const latencyScore = latencyScoreFor(inputs.avgLatencyMs, scale.latencyMs);
  const resourceEfficiency = resourceEfficiencyFor(inputs.avgResourceCost, scale.resourceCost);
  // Each factor is in [0, 1]: log₂(1 + C) is 1 at C = 1 and (1 + R)/2 is 1 at
  // R = 1 — exactly, which keeps the product's maximum at exactly 1.
  const quality =
    inputs.successRate * Math.log2(1 + inputs.coverage) * ((1 + inputs.robustness) / 2);
  // Multiplied, not divided: L_score and Cost_score are already inverted, so
  // multiplying by them is what makes slower and costlier score lower. No cap —
  // every factor is in [0, 1], so the product is too.
  const value = quality * latencyScore * resourceEfficiency;
  return { value, latencyScore, resourceEfficiency };
}
