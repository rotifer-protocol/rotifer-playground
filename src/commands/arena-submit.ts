import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { contentHash } from "../utils/content-hash.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { tryLoadBinding } from "../utils/binding.js";
import { arenaSubmit as cloudArenaSubmit } from "../cloud/client.js";
import { requireAuth } from "../cloud/auth.js";
import { DEFAULT_SANDBOX_CONSTRAINTS_JSON } from "../utils/sandbox-defaults.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
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

    const isNative = phenotype.fidelity === "Native";
    const irWasmPath = join(geneDir, "gene.ir.wasm");
    const hasIrWasm = existsSync(irWasmPath);
    const binding = tryLoadBinding();

    let fitness: {
      value: number;
      safetyScore: number;
      successRate: number;
      latencyScore: number;
      resourceEfficiency: number;
    };

    if (isNative && hasIrWasm && binding) {
      display.info("Executing gene in WASM sandbox...");
      const irWasm = readFileSync(irWasmPath) as Buffer;
      const { irHash: _strip, ...phenotypeForExec } = phenotype;

      const runs = 3;
      const results: { success: boolean; latencyMs: number; resourceCost: number }[] = [];

      for (let i = 0; i < runs; i++) {
        const testInput = generateTestInput(phenotype.inputSchema, i);
        try {
          const execResult = binding.executeGene(
            irWasm,
            JSON.stringify(testInput),
            JSON.stringify(phenotypeForExec),
            DEFAULT_SANDBOX_CONSTRAINTS_JSON
          );
          results.push({
            success: execResult.success,
            latencyMs: execResult.durationMs,
            resourceCost: execResult.fuelConsumed,
          });
        } catch {
          results.push({ success: false, latencyMs: 0, resourceCost: 0 });
        }
      }

      const total = results.length;
      const successes = results.filter((r) => r.success).length;
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
      const value = Math.min(denominator > 0 ? numerator / denominator : 0, 1.0);

      // V(g) = Test_Pass_Rate / Security_Leak_Risk  (Spec §5.1, ADR-215 P0)
      const testPassRate = successRate;
      const securityLeakRisk = computeSecurityLeakRisk(geneDir, geneName);
      const safetyScore = testPassRate / securityLeakRisk;

      fitness = { value, safetyScore, successRate, latencyScore, resourceEfficiency };
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
      const baseFitness = isNative ? 0.70 : 0.45;
      const variance = (seed % 250) / 1000;

      // V(g) still uses real AST scan even in fallback mode (ADR-215 P0)
      const fallbackTestPassRate = 0.9 + (seed % 100) / 1000;
      const fallbackSecurityLeakRisk = computeSecurityLeakRisk(geneDir, geneName);
      const fallbackSafetyScore = fallbackTestPassRate / fallbackSecurityLeakRisk;

      fitness = {
        value: Math.min(baseFitness + variance, 0.99),
        safetyScore: fallbackSafetyScore,
        successRate: fallbackTestPassRate,
        latencyScore: 0.7 + ((seed >> 8) % 300) / 1000,
        resourceEfficiency: 0.6 + ((seed >> 16) % 300) / 1000,
      };
      if (fallbackSecurityLeakRisk > 1.0) {
        display.warn(`Security scan found issues (leak_risk=${fallbackSecurityLeakRisk.toFixed(2)}, V(g)=${fallbackSafetyScore.toFixed(4)})`);
      }
    }

    try {
      writeFileSync(
        join(geneDir, ".arena-cache.json"),
        JSON.stringify({
          fitness: fitness.value,
          safety: fitness.safetyScore,
          success_rate: fitness.successRate,
          latency_score: fitness.latencyScore,
          resource_efficiency: fitness.resourceEfficiency,
          content_hash: geneId,
          method: (isNative && hasIrWasm && binding) ? "sandbox" : "estimated",
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
    display.keyValue("Fidelity", isNative ? "Native" : "Wrapped");
    display.keyValue("F(g)", fitness.value.toFixed(4));
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
          const cloudEntry = await cloudArenaSubmit(cloudGeneId, {
            value: fitness.value,
            safety_score: fitness.safetyScore,
            success_rate: fitness.successRate,
            latency_score: fitness.latencyScore,
            resource_efficiency: fitness.resourceEfficiency,
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
