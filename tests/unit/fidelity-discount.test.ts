import { describe, expect, it } from "vitest";
import {
  applyFidelityDiscount,
  fidelityDiscountFor,
  estimateBaseFitness,
  ESTIMATED_BASE_FITNESS,
} from "../../src/utils/fidelity-discount.js";
import { FIDELITY_DISCOUNT } from "../../src/types/phenotype.js";

/**
 * Spec §5.1 (v2.11): F(g) = base_fitness × FIDELITY_DISCOUNT[fidelity].
 *
 * The constant had been defined since the spec landed and applied by nothing.
 * These tests pin the seam that now applies it — and, more importantly, pin
 * that the seam reads the protocol parameter rather than restating it. A
 * second copy of {1.0, 0.85, 0.7} in this file would pass today and drift the
 * first time the parameter moves under PAP.
 */
describe("fidelityDiscountFor", () => {
  it("reads the protocol parameter, not a local copy", () => {
    // Deliberately compared against the exported constant, never a literal.
    expect(fidelityDiscountFor("Native")).toBe(FIDELITY_DISCOUNT.native);
    expect(fidelityDiscountFor("Hybrid")).toBe(FIDELITY_DISCOUNT.hybrid);
    expect(fidelityDiscountFor("Wrapped")).toBe(FIDELITY_DISCOUNT.wrapped);
  });

  /** Spec enum is UPPERCASE, phenotype.json is PascalCase, keys are lowercase. */
  it("reconciles the three layers' casing in one place", () => {
    expect(fidelityDiscountFor("HYBRID")).toBe(FIDELITY_DISCOUNT.hybrid);
    expect(fidelityDiscountFor("hybrid")).toBe(FIDELITY_DISCOUNT.hybrid);
    expect(fidelityDiscountFor("  Native ")).toBe(FIDELITY_DISCOUNT.native);
  });

  /**
   * The tier that makes no execution claim must not be mistaken for the one
   * that makes the strongest. Unknown and undeclared both fall to Wrapped.
   */
  it("treats unknown or undeclared fidelity as Wrapped, never Native", () => {
    expect(fidelityDiscountFor(undefined)).toBe(FIDELITY_DISCOUNT.wrapped);
    expect(fidelityDiscountFor(null)).toBe(FIDELITY_DISCOUNT.wrapped);
    expect(fidelityDiscountFor("")).toBe(FIDELITY_DISCOUNT.wrapped);
    expect(fidelityDiscountFor("Quantum")).toBe(FIDELITY_DISCOUNT.wrapped);
  });

  it("orders the tiers as the spec does", () => {
    expect(fidelityDiscountFor("Native")).toBeGreaterThan(fidelityDiscountFor("Hybrid"));
    expect(fidelityDiscountFor("Hybrid")).toBeGreaterThan(fidelityDiscountFor("Wrapped"));
    expect(fidelityDiscountFor("Native")).toBe(1.0);
  });
});

describe("applyFidelityDiscount", () => {
  it("returns all three numbers the ledger wants, and they multiply", () => {
    const d = applyFidelityDiscount(0.8, "Hybrid");
    expect(d.baseFitness).toBe(0.8);
    expect(d.fidelityDiscount).toBe(FIDELITY_DISCOUNT.hybrid);
    expect(d.fitness).toBeCloseTo(0.8 * FIDELITY_DISCOUNT.hybrid, 10);
  });

  it("leaves a Native score numerically unchanged", () => {
    expect(applyFidelityDiscount(0.9, "Native").fitness).toBe(0.9);
  });

  it("applies the discount to F(g) only — the caller keeps V(g) separate", () => {
    // The helper has no V(g) input at all; this pins that it cannot touch it.
    const d = applyFidelityDiscount(0.5, "Wrapped");
    expect(Object.keys(d).sort()).toEqual(["baseFitness", "fidelityDiscount", "fitness"]);
  });
});

describe("estimateBaseFitness", () => {
  it("is deterministic for a gene id", () => {
    expect(estimateBaseFitness("0123abcd-0000-0000-0000-000000000000")).toBe(
      estimateBaseFitness("0123abcd-ffff-ffff-ffff-ffffffffffff")
    );
  });

  /**
   * The old code had `isNative ? 0.70 : 0.45` — a second, undocumented tier
   * penalty hidden in the estimate. The estimate is now one number regardless
   * of fidelity; the tier shows up exactly once, through the discount.
   */
  it("does not know about fidelity", () => {
    const id = "89abcdef-0000-0000-0000-000000000000";
    const base = estimateBaseFitness(id);
    expect(applyFidelityDiscount(base, "Native").baseFitness).toBe(base);
    expect(applyFidelityDiscount(base, "Hybrid").baseFitness).toBe(base);
    expect(applyFidelityDiscount(base, "Wrapped").baseFitness).toBe(base);
  });

  it("stays inside [ESTIMATED_BASE_FITNESS, 0.99]", () => {
    for (const head of ["00000000", "ffffffff", "7fffffff", "12345678"]) {
      const v = estimateBaseFitness(`${head}-0000-0000-0000-000000000000`);
      expect(v).toBeGreaterThanOrEqual(ESTIMATED_BASE_FITNESS);
      expect(v).toBeLessThanOrEqual(0.99);
    }
  });

  /**
   * Native estimates used to come out at 0.70 + variance; they still do. The
   * change is to Hybrid (now 0.85× that) and Wrapped (0.70× it, near the old
   * 0.45 floor but derived rather than declared).
   */
  it("keeps the Native estimate where it was", () => {
    const id = "00000000-0000-0000-0000-000000000000";
    expect(applyFidelityDiscount(estimateBaseFitness(id), "Native").fitness).toBeCloseTo(0.7, 10);
  });
});
