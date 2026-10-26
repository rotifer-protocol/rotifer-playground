/**
 * The fidelity discount follows what ran, not what the phenotype declares (T-95).
 *
 * §5.1 gives Native 1.00 because "pure WASM execution is fully verifiable".
 * `arena submit` took the tier from phenotype.fidelity, so a Gene that declared
 * Native and never ran in the sandbox — no gene.ir.wasm (every Native gene in
 * the npm package), no sandbox on this platform, or one of the estimates that
 * run nothing at all — scored ×1.00 on a number derived from its content hash.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  effectiveFidelity,
  estimateUnexecutedFitness,
  applyFidelityDiscount,
  estimateBaseFitness,
} from "../../src/utils/fidelity-discount.js";
import { FIDELITY_DISCOUNT } from "../../src/types/phenotype.js";

describe("effectiveFidelity", () => {
  it("a declared Native that did not run in the sandbox counts as Wrapped", () => {
    expect(effectiveFidelity("Native", false)).toBe("Wrapped");
    expect(effectiveFidelity("NATIVE", false)).toBe("Wrapped");
  });

  it("a declared Native that ran in the sandbox stays Native", () => {
    expect(effectiveFidelity("Native", true)).toBe("Native");
  });

  it("Hybrid and Wrapped keep their declared tier either way", () => {
    for (const ran of [true, false]) {
      expect(effectiveFidelity("Hybrid", ran)).toBe("Hybrid");
      expect(effectiveFidelity("Wrapped", ran)).toBe("Wrapped");
    }
  });

  it("an undeclared tier is Wrapped, as fidelityDiscountFor already treats it", () => {
    expect(effectiveFidelity(undefined, false)).toBe("Wrapped");
    expect(effectiveFidelity("", true)).toBe("Wrapped");
  });
});

describe("estimateUnexecutedFitness — the estimates that run nothing", () => {
  const geneId = "a1b2c3d4" + "0".repeat(56);

  it("never gives a declared Native the Native discount", () => {
    const native = estimateUnexecutedFitness("Native", geneId);
    expect(native.fidelityDiscount).toBe(FIDELITY_DISCOUNT.wrapped);
    expect(native.fitness).toBeCloseTo(estimateBaseFitness(geneId) * FIDELITY_DISCOUNT.wrapped, 12);
  });

  it("leaves Hybrid and Wrapped as they were", () => {
    expect(estimateUnexecutedFitness("Hybrid", geneId)).toEqual(applyFidelityDiscount(estimateBaseFitness(geneId), "Hybrid"));
    expect(estimateUnexecutedFitness("Wrapped", geneId)).toEqual(applyFidelityDiscount(estimateBaseFitness(geneId), "Wrapped"));
  });
});

describe("the commands that score use the effective tier", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf-8");

  it("arena submit decides whether the Gene ran before it scores, and discounts by that", () => {
    const src = read("src/commands/arena-submit.ts");
    const decided = src.indexOf("const didRunInSandbox = Boolean(isNative && hasIrWasm && binding);");
    const firstDiscount = src.indexOf("applyFidelityDiscount(");
    expect(decided, "didRunInSandbox must be decided once, from artifact + binding").toBeGreaterThan(-1);
    expect(decided, "and before either scoring path").toBeLessThan(firstDiscount);
    expect(src).toContain("effectiveFidelity(declaredFidelity, didRunInSandbox)");
    expect(src).not.toMatch(/applyFidelityDiscount\([^)]*declaredFidelity\)/);
  });

  it("arena watch and agent create, which never run a Gene, use the unexecuted estimate", () => {
    for (const p of ["src/commands/arena-watch.ts", "src/commands/agent-create.ts"]) {
      const src = read(p);
      expect(src, p).toContain("estimateUnexecutedFitness(");
      expect(src, p).not.toMatch(/applyFidelityDiscount\(estimateBaseFitness\([^)]*\), phenotype\.fidelity\)/);
    }
  });
});
