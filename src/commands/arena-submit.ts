import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { contentHash } from "../utils/content-hash.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { tryLoadBinding } from "../utils/binding.js";
import { arenaSubmit as cloudArenaSubmit, publishEvaluationRuns } from "../cloud/client.js";
import { requireAuth } from "../cloud/auth.js";
import {
  FUEL_LADDER,
  classifyRunFailure,
  constraintsForFuel,
  type RunFailureKind,
} from "../utils/run-fuel-ladder.js";
import { compileOutputValidator, isRunSuccessful } from "../utils/arena-success.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { applyFidelityDiscount, estimateBaseFitness, type DiscountedFitness } from "../utils/fidelity-discount.js";
import { computeBaseFitness } from "../utils/fitness-formula.js";
import { scan } from "../scanner/index.js";
import type { Severity } from "../scanner/types.js";

/**
 * The two §5.1 fitness inputs that still have no measurement behind them.
 *
 * `C_util` (input-space coverage) needs property-based testing and `R_rob`
 * (adversarial stability) needs fuzzing; ADR-318 D4 defines both and v0.9.3 #6
 * carries the implementation. They are named rather than inlined so that the
 * thing making them placeholders is visible from the flag below.
 */
const FITNESS_COVERAGE_PLACEHOLDER = 0.5;
const FITNESS_ROBUSTNESS_PLACEHOLDER = 0.5;

/**
 * Whether F(g) is computed from measurements alone.
 *
 * False today, and deliberately a constant rather than a runtime check: two of
 * the five inputs are the placeholders above. The direction defect is gone —
 * the efficiency scores now multiply, so F(g) falls as latency and cost rise
 * (ADR-318 D2, superseding ADR-215 P1's claim that dividing was equivalent) —
 * but D2's other half is not: L and Cost are still measured against the fixed
 * 1000ms / 10000-fuel constants rather than the season median of the gene's own
 * domain and fidelity, so the number is not yet comparable across bindings.
 *
 * While this is false, ADR-318 D4 requires every submission to be recorded as
 * `estimated` no matter how thoroughly the sandbox ran it. Flip it in the same
 * change that lands D2's reference scale and D4's real C_util / R_rob — not
 * before, and not separately: a `sandbox` label on a number scaled by a
 * guessed constant is the exact claim the Arena's tiers exist to prevent.
 */
const hasCompleteFitnessInputs = false;

const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 1.0,
  HIGH: 0.5,
  MEDIUM: 0.2,
};

function computeSecurityLeakRisk(geneDir: string, geneName: string): number {
  const result = scan(geneDir, geneName, { scanAll: true });
  let risk = 1.0;
  for (const f of result.findings) {
    risk += SEVERITY_WEIGHT[f.severity] ?? 0;
  }
  return risk;
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateTestInput(schema: any, seed: number): Record<string, any> {
  if (!schema || !schema.properties) return { data: `test-input-${seed}` };

  const rng = mulberry32(seed * 2654435761);
  const input: Record<string, any> = {};
  for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
    if (prop.default !== undefined) {
      input[key] = prop.default;
    } else if (prop.enum && prop.enum.length > 0) {
      input[key] = prop.enum[seed % prop.enum.length];
    } else if (prop.type === "array" && prop.items) {
      const count = 50 + seed * 10;
      const arr: any[] = [];
      if (prop.items.type === "number") {
        let price = 100;
        for (let i = 0; i < count; i++) {
          price *= 1 + (rng() - 0.48) * 0.04;
          arr.push(Math.round(price * 100) / 100);
        }
      } else if (prop.items.type === "string") {
        for (let i = 0; i < Math.min(count, 5); i++) arr.push(`item-${i}`);
      } else if (prop.items.type === "object") {
        for (let i = 0; i < Math.min(count, 3); i++) {
          arr.push(generateTestInput({ properties: prop.items.properties }, seed + i));
        }
      }
      input[key] = arr;
    } else if (prop.type === "number") {
      const min = prop.minimum ?? 1;
      const max = prop.maximum ?? 100;
      input[key] = Math.min(min + seed, max);
    } else if (prop.type === "string") {
      input[key] = `test-${seed}`;
    } else if (prop.type === "boolean") {
      input[key] = seed % 2 === 0;
    }
  }
  return input;
}

export const arenaSubmitCommand = new Command("submit")
  .description("Submit a gene to the Arena for competition")
  .argument("<gene-name>", "gene name to submit")
  .option("--skip-test", "skip pre-submission test", false)
  .option("--cloud", "submit to cloud Arena (requires login)", false)
  .action(async (geneName: string, options: { skipTest: boolean; cloud: boolean }) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);

    display.header("Arena Submission");
    validateGeneName(geneName);

    const geneDir = join(root, config.genes_dir, geneName);
    const phenotypePath = join(geneDir, "phenotype.json");

    if (!existsSync(phenotypePath)) {
      display.rustStyleError({
        code: "E0030",
        message: `Gene '${geneName}' not found or not wrapped`,
        file: phenotypePath,
        suggestion: "Run 'rotifer wrap " + geneName + " --domain <domain>' first",
      });
      process.exit(1);
    }

    const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
    const geneId = contentHash(phenotype);

    if (!options.skipTest) {
      display.info("Running pre-submission tests...");
      const requiredFields = ["domain", "inputSchema", "outputSchema", "version"];
      const isValid = requiredFields.every((f) => f in phenotype);
      if (!isValid) {
        display.error("Phenotype validation failed — cannot submit to Arena");
        display.hint("Check phenotype.json has all required fields: name, version, domain, fidelity, inputSchema, outputSchema.");
        process.exit(1);
      }
      display.success("Pre-submission tests passed");
    }

    // The declared tier, carried through to the discount and to every line of
    // output. Only Native can be measured in the sandbox today — the Hybrid path
    // that ships runs under Node.js and has no artifact to execute — so the
    // other two tiers take the estimate path. They keep their own names there:
    // a Hybrid gene was being reported back to its author as "Wrapped".
    const declaredFidelity: string = phenotype.fidelity || "Wrapped";
    const isNative = declaredFidelity === "Native";
    const irWasmPath = join(geneDir, "gene.ir.wasm");
    const hasIrWasm = existsSync(irWasmPath);
    const binding = tryLoadBinding();

    // How many sandbox runs back a measured submission. Declared out here
    // because the ledger needs it too (ADR-318 D5 evaluation_n), not only the
    // loop that consumes it.
    const SANDBOX_RUNS = 3;

    // The evidence, hoisted out of the measuring branch because the submit
    // needs it too. Empty on the estimate path — an estimate ran nothing and
    // has nothing to show.
    const evaluationRuns: import("../cloud/client.js").EvaluationRun[] = [];

    let fitness: {
      value: number;
      safetyScore: number;
      successRate: number;
      latencyScore: number;
      resourceEfficiency: number;
    };
    // §5.1: F(g) = base_fitness × FIDELITY_DISCOUNT[fidelity]. Both paths
    // produce a base; the discount is applied once, below, so neither path can
    // forget it or apply it twice.
    let discounted: DiscountedFitness;

    if (isNative && hasIrWasm && binding) {
      display.info("Executing gene in WASM sandbox...");
      const irWasm = readFileSync(irWasmPath) as Buffer;
      const { irHash: _strip, ...phenotypeForExec } = phenotype;

      // sandboxOk and schemaOk are kept apart. S_r needs them combined, but the
      // ledger needs them separate: "crashed" and "ran and returned garbage"
      // are different failures, and a reader who cannot tell them apart cannot
      // audit the rule or diagnose the Gene (ADR-319 D3).
      const results: {
        success: boolean;
        sandboxOk: boolean;
        schemaOk: boolean | null;
        latencyMs: number;
        resourceCost: number;
        failureKind: RunFailureKind | null;
      }[] = [];

      // S_r counts a run as successful only when the sandbox succeeded AND the
      // output honours the Gene's own outputSchema (spec §47.5 T1 "legal
      // output"). Sandbox success alone let empty `{}` outputs score S_r = 1.
      const validateOutput = compileOutputValidator(phenotype);
      if (!validateOutput) {
        display.warn("phenotype.outputSchema is empty or unusable — S_r falls back to sandbox success alone");
      }
      let contractFailures = 0;

      let fuelRetries = 0;
      for (let i = 0; i < SANDBOX_RUNS; i++) {
        const testInput = generateTestInput(phenotype.inputSchema, i);
        try {
          // Climb the fuel ladder: a run that fails on fuel alone is retried
          // with a larger budget. Every other failure — and success — is
          // final on the rung where it happened, and the fuel actually burned
          // is what gets recorded, so an expensive Gene still pays its price
          // in the efficiency term.
          let execResult!: ReturnType<typeof binding.executeGene>;
          let failureKind: RunFailureKind | null = null;
          for (let rung = 0; rung < FUEL_LADDER.length; rung++) {
            execResult = binding.executeGene(
              irWasm,
              JSON.stringify(testInput),
              JSON.stringify(phenotypeForExec),
              constraintsForFuel(FUEL_LADDER[rung])
            );
            failureKind = execResult.success
              ? null
              : classifyRunFailure(execResult.errorMessage);
            if (failureKind !== "fuel-exhausted" || rung === FUEL_LADDER.length - 1) break;
            fuelRetries++;
          }
          const isSuccessfulRun = isRunSuccessful(
            { sandboxSuccess: execResult.success, output: execResult.output },
            validateOutput,
          );
          if (execResult.success && !isSuccessfulRun) contractFailures++;
          results.push({
            success: isSuccessfulRun,
            sandboxOk: execResult.success,
            // null when there was nothing to check: either the Gene declared
            // no usable outputSchema, or the sandbox never produced an output
            // to check. Neither is the same as passing.
            schemaOk: (validateOutput && execResult.success) ? isSuccessfulRun : null,
            latencyMs: execResult.durationMs,
            resourceCost: execResult.fuelConsumed,
            failureKind,
          });
        } catch {
          results.push({ success: false, sandboxOk: false, schemaOk: null, latencyMs: 0, resourceCost: 0, failureKind: "crash" });
        }
      }
      if (fuelRetries > 0) {
        display.info(
          `Fuel ladder: ${fuelRetries} run(s) retried with a larger budget — cost recorded as burned`
        );
      }

      for (const [i, r] of results.entries()) {
        evaluationRuns.push({
          run_index: i,
          sandbox_success: r.sandboxOk,
          output_schema_valid: r.schemaOk,
          latency_ms: r.latencyMs,
          resource_cost: r.resourceCost,
          // Separates "ran out of a rationed resource at the top of the fuel
          // ladder" from "crashed" in the public ledger (plan 2.12): a reader
          // auditing S_r can tell an evaluation-design limit from a defect.
          failure_kind: r.failureKind,
        });
      }

      const total = results.length;
      const successes = results.filter((r) => r.success).length;
      if (contractFailures > 0) {
        display.warn(
          `${contractFailures}/${total} run(s) returned output that violates outputSchema — counted as failures for S_r`
        );
        display.hint("An empty or partial result is not a successful run. Check that express() returns the declared fields synchronously.");
      }
      const successRate = successes / total;
      const avgLatency = results.reduce((s, r) => s + r.latencyMs, 0) / total;
      const avgCost = results.reduce((s, r) => s + r.resourceCost, 0) / total;

      // F(g) = S_r · ln(1+C_util) · (1+R_rob) · L_score · Cost_score  (ADR-318 D2)
      // The efficiency terms multiply; see utils/fitness-formula.ts for why
      // dividing by them inverted the penalty into a reward.
      // C_util and R_rob need fuzzing and property-based testing to measure;
      // ADR-318 D4 defines both, and v0.9.3 #6 carries the implementation.
      // Until then they are constants, which is why hasCompleteFitnessInputs
      // is false and every score here is recorded as an estimate.
      const { value: baseValue, latencyScore, resourceEfficiency } = computeBaseFitness({
        successRate,
        avgLatencyMs: avgLatency,
        avgResourceCost: avgCost,
        coverage: FITNESS_COVERAGE_PLACEHOLDER,
        robustness: FITNESS_ROBUSTNESS_PLACEHOLDER,
      });
      discounted = applyFidelityDiscount(baseValue, declaredFidelity);

      // V(g) = Test_Pass_Rate / Security_Leak_Risk  (Spec §5.1, ADR-215 P0)
      // The discount applies to F(g) only; V(g) is untouched by fidelity.
      const testPassRate = successRate;
      const securityLeakRisk = computeSecurityLeakRisk(geneDir, geneName);
      const safetyScore = testPassRate / securityLeakRisk;

      fitness = { value: discounted.fitness, safetyScore, successRate, latencyScore, resourceEfficiency };
      display.success(`Sandbox execution: ${successes}/${total} passed (avg ${avgLatency.toFixed(1)}ms)`);
      if (securityLeakRisk > 1.0) {
        display.warn(`Security scan found issues (leak_risk=${securityLeakRisk.toFixed(2)}, V(g)=${safetyScore.toFixed(4)})`);
      }
    } else {
      // Deterministic fitness from content hash (fallback for F(g) estimation)
      if (isNative && !binding) {
        display.warn("Native addon not available — using deterministic fitness estimation");
      }
      const seed = parseInt(geneId.slice(0, 8), 16);
      // The estimate is fidelity-agnostic on purpose: the tier penalty is the
      // discount's job. The old `isNative ? 0.70 : 0.45` baked a second,
      // undocumented penalty into the estimate itself.
      discounted = applyFidelityDiscount(estimateBaseFitness(geneId), declaredFidelity);

      // V(g) still uses real AST scan even in fallback mode (ADR-215 P0)
      const fallbackTestPassRate = 0.9 + (seed % 100) / 1000;
      const fallbackSecurityLeakRisk = computeSecurityLeakRisk(geneDir, geneName);
      const fallbackSafetyScore = fallbackTestPassRate / fallbackSecurityLeakRisk;

      fitness = {
        value: discounted.fitness,
        safetyScore: fallbackSafetyScore,
        successRate: fallbackTestPassRate,
        latencyScore: 0.7 + ((seed >> 8) % 300) / 1000,
        resourceEfficiency: 0.6 + ((seed >> 16) % 300) / 1000,
      };
      if (fallbackSecurityLeakRisk > 1.0) {
        display.warn(`Security scan found issues (leak_risk=${fallbackSecurityLeakRisk.toFixed(2)}, V(g)=${fallbackSafetyScore.toFixed(4)})`);
      }
    }

    // Which path produced these numbers. The local cache has always recorded
    // this; the cloud submit dropped it, so every score arrived at the Arena
    // indistinguishable from every other one (ADR-319 D2/D3). One variable now,
    // read by both, so the cache and the ledger cannot disagree.
    //
    // Running in the sandbox is necessary but not sufficient to call the result
    // a measurement. Two of the five §5.1 variables are still constants, and
    // the denominator is still inverted (ADR-318 D2, superseding ADR-215 P1) —
    // so the number that comes out is capped at 1.000 for anything slower than
    // ~645 ms and rises with latency rather than falling. Labelling that
    // `sandbox` would put it in the Arena's measured tier, which is exactly the
    // claim it cannot support. ADR-318 D4, routed through v0.9.3 plan §3.4 ④:
    // while C_util and R_rob are transitional values the entry MUST be marked
    // `estimated`.
    //
    // The sandbox run is not thrown away. `evaluation_n` still carries the run
    // count, so a reader can tell the two kinds of estimate apart: n > 0 means
    // the Gene ran and the formula is incomplete; no n means the number came
    // off a content hash and the Gene never ran at all. Latency and resource
    // cost are uploaded either way — that is the population D2's L_ref and
    // Cost_ref are the median of, and it cannot exist until submissions like
    // this one create it.
    const didRunInSandbox = Boolean(isNative && hasIrWasm && binding);
    const evaluationMethod: "sandbox" | "estimated" =
      (didRunInSandbox && hasCompleteFitnessInputs) ? "sandbox" : "estimated";

    try {
      writeFileSync(
        join(geneDir, ".arena-cache.json"),
        JSON.stringify({
          fitness: fitness.value,
          base_fitness: discounted.baseFitness,
          fidelity_discount: discounted.fidelityDiscount,
          safety: fitness.safetyScore,
          success_rate: fitness.successRate,
          latency_score: fitness.latencyScore,
          resource_efficiency: fitness.resourceEfficiency,
          content_hash: geneId,
          method: evaluationMethod,
          security_scanned: true,
          evaluated_at: new Date().toISOString(),
        }, null, 2) + "\n",
      );
    } catch { /* best-effort cache */ }

    const tau = 0.3;
    const vMin = 0.7;

    // V(g) always gates. F(g) does not, while `hasCompleteFitnessInputs` is
    // false: τ is a threshold on the D2 range, and this F(g) is not on it yet.
    // Two of its five inputs are placeholders, and the efficiency terms are
    // scaled by the provisional constants in utils/fitness-formula.ts — against
    // which the bundled Native corpus scores ~0.003, so comparing to τ = 0.3
    // would reject every gene ever measured. Rejecting on a number the same run
    // files as `estimated` and excludes from ranking is not an admission
    // decision, it is an artifact of an uncalibrated scale. Restore the τ gate
    // in the change that lands D2's reference scale and D4's real C_util/R_rob.
    const doesPassSafety = fitness.safetyScore >= vMin;
    const doesPassFitness = fitness.value >= tau;

    if (!doesPassSafety) {
      display.error(
        `Gene does not meet admission threshold (V(g)=${fitness.safetyScore.toFixed(3)} < V_min=${vMin})`
      );
      display.hint("Improve gene security, then try again.");
      process.exit(1);
    }

    if (!doesPassFitness && hasCompleteFitnessInputs) {
      display.error(
        `Gene does not meet admission threshold (F(g)=${fitness.value.toFixed(3)} < τ=${tau})`
      );
      display.hint("Improve gene quality, then try again.");
      process.exit(1);
    }

    console.log();
    display.success(`Gene '${geneName}' submitted to Arena`);
    display.keyValue("Gene ID", c.warn(geneId));
    display.keyValue("Domain", phenotype.domain);
    display.keyValue("Fidelity", declaredFidelity);
    // §33.1 dual-column: the raw base shows what the gene nominally achieved,
    // the discounted F(g) is what ranks against the other tiers.
    display.keyValue("Base fitness", discounted.baseFitness.toFixed(4));
    display.keyValue("F(g)", `${fitness.value.toFixed(4)}  (× ${discounted.fidelityDiscount.toFixed(2)} ${declaredFidelity.toLowerCase()} discount)`);
    display.keyValue("V(g)", fitness.safetyScore.toFixed(4));
    display.keyValue("Success Rate", `${(fitness.successRate * 100).toFixed(1)}%`);
    display.keyValue("Latency Score", fitness.latencyScore.toFixed(4));
    display.keyValue("Admission", doesPassFitness ? "PASSED" : "PASSED (V(g) only)");
    if (didRunInSandbox) {
      display.keyValue("Execution", `Sandbox verified (${SANDBOX_RUNS} runs)`);
    } else {
      display.keyValue("Execution", "Not executed — score derived from the content hash");
    }
    display.keyValue("Recorded as", evaluationMethod);
    // Saying "sandbox verified" and then filing the row as an estimate looks
    // like a contradiction unless the reason is right there. It is not the
    // sandbox that is in doubt.
    if (didRunInSandbox && !hasCompleteFitnessInputs) {
      display.hint(
        "The Gene ran and its output was checked, but F(g) still uses placeholder values for C_util and R_rob, " +
        "and measures latency and cost against fixed constants rather than this domain's season median " +
        "(ADR-318 D2/D4). Until that lands the score is filed as an estimate and does not rank — the run " +
        "itself, its latency and its cost are still recorded."
      );
      if (!doesPassFitness) {
        display.warn(
          `F(g)=${fitness.value.toFixed(4)} is below τ=${tau}, and did not block this submission: the ` +
          "efficiency terms are scaled by provisional constants that every measured Gene scores far under. " +
          "V(g) is what gated here. The τ gate returns with the calibrated scale."
        );
      }
    }
    if (options.cloud) {
      try {
        await requireAuth();
        const cs = display.spinner("Submitting to cloud Arena...");

        const manifestPath = join(geneDir, ".cloud-manifest.json");
        let cloudGeneId: string | null = null;
        if (existsSync(manifestPath)) {
          const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          cloudGeneId = manifest.cloud_id;
        }

        if (!cloudGeneId) {
          cs.stop();
          display.warn(
            "Gene not published to cloud yet. Run 'rotifer publish " +
              geneName +
              "' first, then submit to cloud Arena."
          );
        } else {
          // Evidence before claim. The per-run measurements are what make the
          // score checkable (§9.7.1); publishing the score first and the
          // evidence second would leave a window — and, if the second call
          // fails, a permanent row — asserting a number nobody can verify.
          // Only measured runs have evidence; an estimate has none to offer.
          if (evaluationMethod === "sandbox") {
            await publishEvaluationRuns(
              cloudGeneId,
              randomUUID(),
              evaluationRuns,
            );
          }

          const cloudEntry = await cloudArenaSubmit(cloudGeneId, {
            value: fitness.value,
            base_fitness: discounted.baseFitness,
            fidelity_discount: discounted.fidelityDiscount,
            safety_score: fitness.safetyScore,
            success_rate: fitness.successRate,
            latency_score: fitness.latencyScore,
            resource_efficiency: fitness.resourceEfficiency,
            evaluation_method: evaluationMethod,
            // n only means anything on the measured path; an estimate ran
            // nothing, and claiming a sample size for it would be a lie the
            // Arena cannot detect.
            // Tied to whether the Gene actually ran, not to the method label.
            // The label is `estimated` while the formula is incomplete; the run
            // count is what lets a reader tell that apart from a content-hash
            // estimate that never executed anything (ADR-318 D5).
            evaluation_n: didRunInSandbox ? SANDBOX_RUNS : undefined,
          });
          cs.stop();
          display.success("Submitted to cloud Arena");
          display.keyValue("Cloud Rank", `#${cloudEntry.rank || "pending"}`);
        }
      } catch (err: any) {
        display.error(`Cloud submit failed: ${err.message}`);
        display.hint("Check your network connection and login status with 'rotifer whoami'.");
      }
    }

    console.log();
    display.hint("View rankings: rotifer arena list --domain " + phenotype.domain);
  });
