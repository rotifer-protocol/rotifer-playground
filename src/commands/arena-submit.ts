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
import { DEFAULT_SANDBOX_CONSTRAINTS_JSON } from "../utils/sandbox-defaults.js";
import { compileOutputValidator, isRunSuccessful } from "../utils/arena-success.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { applyFidelityDiscount, estimateBaseFitness, type DiscountedFitness } from "../utils/fidelity-discount.js";
import { scan } from "../scanner/index.js";
import type { Severity } from "../scanner/types.js";

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
    const evaluationRuns: {
      run_index: number;
      sandbox_success: boolean;
      output_schema_valid: boolean | null;
      latency_ms: number;
      resource_cost: number;
    }[] = [];

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
      }[] = [];

      // S_r counts a run as successful only when the sandbox succeeded AND the
      // output honours the Gene's own outputSchema (spec §47.5 T1 "legal
      // output"). Sandbox success alone let empty `{}` outputs score S_r = 1.
      const validateOutput = compileOutputValidator(phenotype);
      if (!validateOutput) {
        display.warn("phenotype.outputSchema is empty or unusable — S_r falls back to sandbox success alone");
      }
      let contractFailures = 0;

      for (let i = 0; i < SANDBOX_RUNS; i++) {
        const testInput = generateTestInput(phenotype.inputSchema, i);
        try {
          const execResult = binding.executeGene(
            irWasm,
            JSON.stringify(testInput),
            JSON.stringify(phenotypeForExec),
            DEFAULT_SANDBOX_CONSTRAINTS_JSON
          );
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
          });
        } catch {
          results.push({ success: false, sandboxOk: false, schemaOk: null, latencyMs: 0, resourceCost: 0 });
        }
      }

      for (const [i, r] of results.entries()) {
        evaluationRuns.push({
          run_index: i,
          sandbox_success: r.sandboxOk,
          output_schema_valid: r.schemaOk,
          latency_ms: r.latencyMs,
          resource_cost: r.resourceCost,
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
      const latencyScore = 1.0 / (1.0 + avgLatency / 1000.0);
      const avgCost = results.reduce((s, r) => s + r.resourceCost, 0) / total;
      const resourceEfficiency = 1.0 / (1.0 + avgCost / 10000.0);

      // F(g) = [S_r · log(1+C_util) · (1+R_rob)] / [L · Resource_Cost]  (Spec §5.1)
      // C_util and R_rob require fuzzing infrastructure — hardcoded until v0.9 (ADR-215 P2)
      const coverage = 0.5;   // TODO(v0.9): property-based testing input space coverage
      const robustness = 0.5; // TODO(v0.9): adversarial input stability from fuzzing
      const numerator = successRate * Math.log1p(coverage) * (1 + robustness);
      // Spec uses raw L × Resource_Cost (linear penalty); implementation uses sigmoid
      // normalization 1/(1+x/k) to prevent extreme values from zeroing F(g) (ADR-215 P1)
      const denominator = Math.max(latencyScore, 0.001) * Math.max(resourceEfficiency, 0.001);
      const baseValue = Math.min(denominator > 0 ? numerator / denominator : 0, 1.0);
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
    const evaluationMethod: "sandbox" | "estimated" =
      (isNative && hasIrWasm && binding) ? "sandbox" : "estimated";

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
    const doesPassAdmission = fitness.value >= tau && fitness.safetyScore >= vMin;

    if (!doesPassAdmission) {
      display.error(
        `Gene does not meet admission threshold (F(g)=${fitness.value.toFixed(3)} < τ=${tau} or V(g)=${fitness.safetyScore.toFixed(3)} < V_min=${vMin})`
      );
      display.hint("Improve gene quality or security, then try again.");
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
    display.keyValue("Admission", "PASSED");
    if (isNative && hasIrWasm && binding) {
      display.keyValue("Execution", "Sandbox verified");
    } else {
      display.keyValue("Execution", "Estimated");
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
            evaluation_n: evaluationMethod === "sandbox" ? SANDBOX_RUNS : undefined,
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
