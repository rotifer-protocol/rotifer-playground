import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import * as display from "../utils/display.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { tryLoadBinding } from "../utils/binding.js";
import { evaluateL0 } from "../utils/l0-gate.js";
import { DEFAULT_SANDBOX_CONSTRAINTS_JSON } from "../utils/sandbox-defaults.js";
import { createGatewayFetch } from "../runtime/network-gateway.js";
import { validateGeneName } from "../utils/validate-gene-name.js";

export const testCommand = new Command("test")
  .description("Test a gene in sandbox")
  .argument("[gene-name]", "gene name to test")
  .option("--verbose", "show detailed output", false)
  .option("--compliance", "run structural compliance checks", false)
  .action(async (geneName: string | undefined, options: { verbose: boolean; compliance: boolean }) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);

    display.header("Gene Test Runner");

    if (!geneName) {
      display.error("Specify a gene name: rotifer test <gene-name>");
      display.hint("List local genes: rotifer list");
      process.exit(1);
    }

    validateGeneName(geneName);
    const geneDir = join(root, config.genes_dir, geneName);
    const phenotypePath = join(geneDir, "phenotype.json");

    if (!existsSync(phenotypePath)) {
      display.rustStyleError({
        code: "E0010",
        message: "Phenotype not found for gene: " + geneName,
        file: phenotypePath,
        suggestion: "Run 'rotifer wrap " + geneName + "' first",
      });
      process.exit(1);
    }

    const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
    const ajv = new Ajv({ allErrors: true });
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const markSkipped = (message: string): void => {
      skipped++;
      display.warn(message);
    };

    // --- Test 1: Phenotype schema ---
    display.info("Test 1: Phenotype Schema Validation");
    const requiredFields = ["domain", "inputSchema", "outputSchema", "version"];
    const isPhenotypeValid = requiredFields.every((k) => k in phenotype);
    if (isPhenotypeValid) { passed++; display.success("  Phenotype schema is valid"); }
    else { failed++; display.error("  Phenotype schema validation failed"); }

    // --- Test 2: Input schema ---
    display.info("Test 2: Input Schema Validation");
    try { ajv.compile(phenotype.inputSchema || {}); passed++; display.success("  inputSchema is valid JSON Schema"); }
    catch (e) { failed++; display.error("  inputSchema is invalid", String(e)); }

    // --- Test 3: Output schema ---
    display.info("Test 3: Output Schema Validation");
    let outputValidator: ReturnType<typeof ajv.compile> | null = null;
    try {
      outputValidator = ajv.compile(phenotype.outputSchema || {});
      passed++; display.success("  outputSchema is valid JSON Schema");
    } catch (e) { failed++; display.error("  outputSchema is invalid", String(e)); }

    // --- Test 4: Auto-generated input conformance ---
    display.info("Test 4: Auto-generated Input Conformance");
    const testInput = generateTestInput(phenotype.inputSchema);
    const inputValidate = ajv.compile(phenotype.inputSchema || {});
    if (inputValidate(testInput)) { passed++; display.success("  Generated input conforms to schema"); }
    else { failed++; display.error("  Generated input does not conform"); }

    // --- Test 5: Source file existence ---
    display.info("Test 5: Source File Existence");
    const srcFile = findSourceFile(geneDir);
    if (srcFile) { passed++; display.success("  Gene source file found: " + srcFile); }
    else { failed++; display.error("  No gene source file found (index.ts / index.js)"); }

    // --- Test 6: Sandbox execution ---
    const irWasmPath = join(geneDir, "gene.ir.wasm");
    const hasIrWasm = existsSync(irWasmPath);
    const binding = tryLoadBinding();

    if (hasIrWasm && binding) {
      // WASM sandbox path — preferred for compiled genes
      display.info("Test 6: WASM Sandbox — executeGene() Execution");
      try {
        const irWasm = readFileSync(irWasmPath) as Buffer;
        const { irHash: _strip, ...phenotypeForExec } = phenotype;
        const result = binding.executeGene(
          irWasm,
          JSON.stringify(testInput),
          JSON.stringify(phenotypeForExec),
          DEFAULT_SANDBOX_CONSTRAINTS_JSON,
        );

        if (result.success) {
          passed++;
          display.success(
            `  executeGene() succeeded (${result.durationMs}ms, fuel: ${result.fuelConsumed})`
          );
          if (options.verbose) {
            display.info("  Input:  " + JSON.stringify(testInput));
            display.info("  Output: " + JSON.stringify(result.output).slice(0, 200));
            display.info(`  Sandbox: ${result.sandboxType}`);
          }

          // --- Test 7: Output conforms to outputSchema ---
          display.info("Test 7: Output Schema Conformance");
          if (outputValidator && outputValidator(result.output)) {
            passed++;
            display.success("  Output conforms to outputSchema");
          } else if (outputValidator) {
            failed++;
            display.error("  Output does not conform to outputSchema");
            if (options.verbose && outputValidator.errors) {
              for (const err of outputValidator.errors) {
                display.error(`    ${err.instancePath}: ${err.message}`);
              }
            }
          } else {
            passed++;
            display.success("  Output schema check skipped (no validator)");
          }
        } else {
          failed++;
          display.error("  executeGene() failed: " + result.errorMessage);
        }
      } catch (err: any) {
        failed++;
        display.error("  WASM sandbox execution error: " + err.message);
      }
    } else if (srcFile) {
      // Node.js fallback path — for uncompiled (Wrapped) genes
      const isCloudGene = existsSync(join(geneDir, ".cloud-manifest.json"));
      if (isCloudGene) {
        failed++;
        display.error("Test 6: Cloud-installed genes cannot run via Node.js without sandbox.");
        display.info("  Compile the gene first: rotifer compile " + geneName);
      } else {
      display.info("Test 6: Node.js Fallback — express() Execution");
      if (hasIrWasm) {
        display.warn("  ⚠ Native addon not available — falling back to Node.js");
      } else {
        display.warn("  ⚠ Running without sandbox — run 'rotifer compile " + geneName + "' first");
      }
      // 门控必须在 import 之前：动态 import 本身就会执行模块顶层代码，
      // 等到 express() 才拦就已经晚了。C3 那个 L0Gate 检查项不承担这个职责——
      // 它挂在 opt-in 的 --compliance 下、且排在本段之后，判定失败也只是给
      // 报告计一笔，基因早跑完了。
      const l0 = evaluateL0(binding, phenotype);
      // isCloudGene 在上面已把外部来源基因挡在这条分支之外，所以这里
      // unavailable 只会落在本地源码基因上：警告并继续，不阻断。
      if (l0.kind === "unavailable") {
        display.warn(`  L0 gate could not run (${l0.detail}) — checking this local gene unchecked.`);
      }
      if (l0.kind === "violation") {
        failed++;
        display.error("  L0 gate blocked: " + l0.detail);
        display.info("  The Node.js fallback would run this gene with full host privileges.");
      } else {
      try {
        const absPath = resolve(geneDir, srcFile);
        const mod = await import(pathToFileURL(absPath).href);
        if (typeof mod.express !== "function") {
          failed++;
          display.error("  Gene does not export an 'express' function");
        } else {
          const isHybrid = phenotype.fidelity === "Hybrid" && phenotype.network;
          let result: unknown;
          let gatewayStats: { totalRequests: number; totalBytes: number } | null = null;

          const start = performance.now();
          if (isHybrid) {
            const { gatewayFetch, gateway } = createGatewayFetch(phenotype.network);
            display.info(`  Hybrid Gene — gateway active (domains: ${phenotype.network.allowedDomains?.join(", ") || "none"})`);
            result = await mod.express(testInput, { gatewayFetch });
            gatewayStats = gateway.stats;
          } else {
            result = await mod.express(testInput);
          }
          const elapsed = performance.now() - start;

          if (result === undefined || result === null) {
            failed++;
            display.error("  express() returned null/undefined");
          } else {
            passed++;
            display.success(`  express() returned successfully (${elapsed.toFixed(1)}ms)`);
            if (options.verbose) {
              display.info("  Input:  " + JSON.stringify(testInput));
              display.info("  Output: " + JSON.stringify(result).slice(0, 200));
              if (gatewayStats) {
                display.info(`  Gateway: ${gatewayStats.totalRequests} requests, ${gatewayStats.totalBytes} bytes`);
              }
            }

            // --- Test 7: Output conforms to outputSchema ---
            display.info("Test 7: Output Schema Conformance");
            if (outputValidator && outputValidator(result)) {
              passed++;
              display.success("  Output conforms to outputSchema");
            } else if (outputValidator) {
              failed++;
              display.error("  Output does not conform to outputSchema");
              if (options.verbose && outputValidator.errors) {
                for (const err of outputValidator.errors) {
                  display.error(`    ${err.instancePath}: ${err.message}`);
                }
              }
            } else {
              passed++;
              display.success("  Output schema check skipped (no validator)");
            }
          }
        }
      } catch (err: any) {
        failed++;
        display.error("  express() threw an error: " + err.message);
      }
      }
      }
    } else {
      markSkipped("  Skipped — no source file or compiled WASM");
    }

    // --- Test 8: IR verification (if gene.ir.wasm exists) ---
    if (hasIrWasm) {
      display.info("Test 8: IR Module Verification");
      if (binding) {
        const irWasm = readFileSync(irWasmPath) as Buffer;
        const verifyResult = binding.verifyIrModule(irWasm);
        if (verifyResult === "PASS") {
          passed++;
          display.success("  IR verification: PASS");
        } else if (verifyResult.startsWith("WARN")) {
          passed++;
          display.warn("  IR verification: " + verifyResult);
        } else {
          failed++;
          display.error("  IR verification: " + verifyResult);
        }
      } else {
        markSkipped("  Skipped — native addon not available");
      }
    }

    // --- Compliance Tests (optional, --compliance flag) ---
    if (options.compliance) {
      console.log();
      display.header("Compliance Checks");

      // C1: Sandbox execution verification
      display.info("C1: Sandbox Execution Verification");
      if (hasIrWasm && binding) {
        const irWasm = readFileSync(irWasmPath) as Buffer;
        const { irHash: _strip, ...phenotypeForExec } = phenotype;
        const result = binding.executeGene(
          irWasm,
          JSON.stringify(testInput),
          JSON.stringify(phenotypeForExec),
          DEFAULT_SANDBOX_CONSTRAINTS_JSON,
        );
        if (result.success && result.sandboxType === "wasm") {
          passed++;
          display.success("  Native gene executed through WASM sandbox");
        } else {
          failed++;
          display.error(`  Sandbox type: ${result.sandboxType}, expected: wasm`);
        }
      } else {
        markSkipped("  Skipped — no compiled WASM or native addon");
      }

      // C2: Fuel consumption verification
      display.info("C2: Fuel Consumption Verification");
      if (hasIrWasm && binding) {
        const irWasm = readFileSync(irWasmPath) as Buffer;
        const { irHash: _strip, ...phenotypeForExec } = phenotype;
        const result = binding.executeGene(
          irWasm,
          JSON.stringify(testInput),
          JSON.stringify(phenotypeForExec),
          DEFAULT_SANDBOX_CONSTRAINTS_JSON,
        );
        if (result.fuelConsumed > 0) {
          passed++;
          display.success(`  Fuel consumed: ${result.fuelConsumed} units`);
        } else {
          failed++;
          display.error("  fuel_consumed is 0 — sandbox may not be metering");
        }
      } else {
        markSkipped("  Skipped — no compiled WASM or native addon");
      }

      // C3: L0Gate check
      display.info("C3: L0Gate Pre-execution Check");
      if (binding) {
        const l0Result = binding.l0Check(JSON.stringify(phenotype));
        if (l0Result.passed) {
          passed++;
          display.success(`  L0Gate: PASS (${l0Result.checksPerformed} checks)`);
        } else {
          failed++;
          display.error(`  L0Gate violations: ${l0Result.violations.join("; ")}`);
        }
      } else {
        markSkipped("  Skipped — native addon not available");
      }

      // C4: Phenotype completeness
      display.info("C4: Phenotype Compliance (Gene Standard)");
      const requiredPhenotypeFields = [
        "domain", "inputSchema", "outputSchema", "version", "fidelity",
      ];
      const missingFields = requiredPhenotypeFields.filter((f) => !(f in phenotype));
      if (missingFields.length === 0) {
        passed++;
        display.success("  All required phenotype fields present");
      } else {
        failed++;
        display.error(`  Missing fields: ${missingFields.join(", ")}`);
      }

      // C5: F(g) computability
      display.info("C5: Fitness Score Computability");
      if (hasIrWasm && binding) {
        const irWasm = readFileSync(irWasmPath) as Buffer;
        const { irHash: _strip, ...phenotypeForExec } = phenotype;
        const result = binding.executeGene(
          irWasm,
          JSON.stringify(testInput),
          JSON.stringify(phenotypeForExec),
          DEFAULT_SANDBOX_CONSTRAINTS_JSON,
        );
        if (result.success && result.fuelConsumed > 0 && result.durationMs >= 0) {
          passed++;
          display.success("  All F(g) input metrics available");
        } else {
          failed++;
          display.error("  Cannot compute F(g) — missing execution metrics");
        }
      } else {
        markSkipped("  Skipped — no compiled WASM or native addon");
      }

      // C6: IR segment integrity
      display.info("C6: IR Segment Integrity");
      if (hasIrWasm && binding) {
        const irWasm = readFileSync(irWasmPath) as Buffer;
        const verifyResult = binding.verifyIrModule(irWasm);
        if (verifyResult === "PASS") {
          passed++;
          display.success("  IR module contains all required custom sections");
        } else {
          failed++;
          display.error("  IR verification: " + verifyResult);
        }
      } else {
        markSkipped("  Skipped — no compiled WASM or native addon");
      }
    }

    // --- Summary ---
    console.log();
    const total = passed + failed + skipped;
    if (failed === 0 && skipped === 0) {
      display.success(`All ${total} tests passed`);
    } else if (failed === 0) {
      display.warn(`${passed}/${total} checks passed, ${skipped} skipped`);
    } else {
      display.warn(`${passed}/${total} checks passed, ${failed} failed, ${skipped} skipped`);
    }

    console.log();
    display.info("Next: rotifer compile " + geneName);

    if (failed > 0) process.exit(1);
  });

function findSourceFile(geneDir: string): string | null {
  const candidates = ["index.ts", "index.js", "index.mjs"];
  for (const c of candidates) {
    if (existsSync(join(geneDir, c))) return c;
  }
  return null;
}

function generateTestInput(schema: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  for (const [key, prop] of Object.entries(properties)) {
    const enumVal = prop.enum as unknown[] | undefined;
    if (Array.isArray(enumVal) && enumVal.length > 0) {
      result[key] = enumVal[0];
    } else if (prop.default !== undefined) {
      result[key] = prop.default;
    } else {
    switch (prop.type) {
      case "string": result[key] = "test_value"; break;
        case "number": case "integer": {
          const min = typeof prop.minimum === "number" ? prop.minimum : 0;
          const max = typeof prop.maximum === "number" ? prop.maximum : min + 10;
          result[key] = Math.floor((min + max) / 2) || 1;
          break;
        }
      case "boolean": result[key] = true; break;
      case "array": result[key] = []; break;
        case "object": result[key] = {}; break;
      default: result[key] = null;
      }
    }
  }
  return result;
}
