import { FIDELITY_DISCOUNT } from "../types/phenotype.js";

/**
 * The §5.1 fidelity discount, applied in one place.
 *
 *   F(g) = base_fitness × FIDELITY_DISCOUNT[fidelity]
 *
 * The constant has lived in `types/phenotype.ts` since spec v2.11 landed and
 * was called from nowhere: every fitness the CLI produced was the undiscounted
 * base, for every fidelity alike, while three separate commands carried their
 * own hand-tuned `isNative ? 0.7 : 0.45` that baked a different, undocumented
 * penalty into the *estimate* instead. This module is the single seam between
 * the protocol parameter and every number the CLI submits or shows.
 *
 * Fidelity is matched case-insensitively because the three layers disagree on
 * case — the spec enum is UPPERCASE, phenotype.json is PascalCase, the
 * parameter keys are lowercase — and that reconciliation belongs here, once,
 * not in each caller.
 */

export interface DiscountedFitness {
  /** The raw value before the discount — what the gene nominally achieved. */
  baseFitness: number;
  /** The FIDELITY_DISCOUNT entry that was applied, recorded so the row stays reconstructible. */
  fidelityDiscount: number;
  /** base × discount, the value that ranks. */
  fitness: number;
}

/**
 * Look up the discount for a declared fidelity.
 *
 * An unrecognised fidelity gets the Wrapped discount, not the Native one:
 * the tier that makes no claim about execution should not be mistaken for the
 * tier that makes the strongest. Undeclared fidelity is treated as Wrapped for
 * the same reason — that is also what `compile` reports for a gene with no
 * source and no artifact.
 */
export function fidelityDiscountFor(fidelity: string | null | undefined): number {
  const key = (fidelity ?? "").trim().toLowerCase();
  return FIDELITY_DISCOUNT[key] ?? FIDELITY_DISCOUNT.wrapped;
}

/**
 * The tier a score is entitled to, given what actually ran.
 *
 * §5.1 gives Native 1.00 because "pure WASM execution is fully verifiable".
 * A Gene that declares Native but did not run in the sandbox — no compiled
 * artifact, no sandbox on this platform, or an estimate that runs nothing at
 * all — earned none of that: its logic ran under Node.js or did not run. It
 * takes the Wrapped discount, the tier that makes no claim about execution.
 * Hybrid and Wrapped keep their declared tier: Hybrid is defined to run under
 * Node.js behind the network gateway, and Wrapped already claims nothing.
 */
export function effectiveFidelity(declared: string | null | undefined, didRunInSandbox: boolean): string {
  const tier = (declared ?? "").trim();
  if (!tier) return "Wrapped";
  if (tier.toLowerCase() === "native" && !didRunInSandbox) return "Wrapped";
  return tier;
}

/**
 * F(g) for the listings that estimate from the content hash and run nothing
 * (`arena watch`, `agent create`). Nothing ran, so a declared Native is
 * discounted as Wrapped (see effectiveFidelity).
 */
export function estimateUnexecutedFitness(
  declared: string | null | undefined,
  geneId: string,
): DiscountedFitness {
  return applyFidelityDiscount(estimateBaseFitness(geneId), effectiveFidelity(declared, false));
}

/** Apply the discount and return all three numbers the ledger wants. */
export function applyFidelityDiscount(
  baseFitness: number,
  fidelity: string | null | undefined
): DiscountedFitness {
  const fidelityDiscount = fidelityDiscountFor(fidelity);
  return {
    baseFitness,
    fidelityDiscount,
    fitness: baseFitness * fidelityDiscount,
  };
}

/**
 * The deterministic estimate used when nothing was actually run.
 *
 * This is the *base*, fidelity-agnostic by design: the fidelity penalty is
 * the discount's job, applied afterwards, so that an estimated Native gene and
 * an estimated Hybrid gene differ by exactly the protocol parameter and not by
 * a second, invisible constant. 0.70 is kept as the Native-tier baseline the
 * old code used, so Native estimates are numerically unchanged; Wrapped lands
 * at 0.70 × 0.70 = 0.49, close to the old 0.45 but now derived rather than
 * declared.
 */
export const ESTIMATED_BASE_FITNESS = 0.7;

export function estimateBaseFitness(geneId: string): number {
  const seed = parseInt(geneId.slice(0, 8), 16);
  const variance = (seed % 250) / 1000;
  return Math.min(ESTIMATED_BASE_FITNESS + variance, 0.99);
}
