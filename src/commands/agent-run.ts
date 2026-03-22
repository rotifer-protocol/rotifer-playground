import { Command } from "commander";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { tryLoadBinding, type NativeBinding } from "../utils/binding.js";
import { createGatewayFetch, type GatewayFetchOptions, type GatewayResponse } from "../runtime/network-gateway.js";

interface AgentInfo {
  id: string;
  name: string;
  state: string;
  genome: string[];
  composition?: {
    type: string;
    branches?: string[];
    merge?: string;
    predicate?: { field: string; op?: string; value?: unknown; equals?: unknown };
    thenBranch?: string;
    elseBranch?: string;
    primary?: string;
    fallback?: string;
  };
}

export const agentRunCommand = new Command("run")
  .description("Execute an agent's genome pipeline")
  .argument("<name>", "agent name to run")
  .option("--input <json>", "input JSON for the pipeline", '{"name":"world"}')
  .option("--verbose", "show intermediate results", false)
  .option("--no-sandbox", "force Node.js execution (skip WASM sandbox)", false)
  .action(async (name: string, options: { input: string; verbose: boolean; sandbox: boolean }) => {
    const root = getProjectRoot();
    const config = loadConfig(root);

    display.header("Agent Execution");

    const agent = findAgent(root, name);
    if (!agent) {
      display.rustStyleError({
        code: "E0050",
        message: `Agent '${name}' not found`,
        suggestion: "Create one: rotifer agent create " + name + " --genes <g1> <g2>",
      });
      process.exit(1);
    }

    if (agent.genome.length === 0) {
      display.error("Agent has an empty genome — nothing to execute");
      display.info("Recreate with genes: rotifer agent create " + name + " --genes <g1> <g2>");
      process.exit(1);
    }

    let input: unknown;
    try {
      input = JSON.parse(options.input);
    } catch {
      display.error("Invalid --input JSON: " + options.input);
      process.exit(1);
    }

    const compositionType =
      (typeof agent.composition === "object" ? agent.composition?.type : agent.composition) ||
      (agent.genome.length >= 2 ? "Seq" : "Single");

    const separator = compositionType === "Par" ? " ∥ " : " → ";
    display.info(`Agent: ${agent.name} (${agent.id.slice(0, 12)}...)`);
    display.info(`Composition: ${compositionType}`);
    display.info(`Pipeline: ${agent.genome.join(separator)}`);
    console.log();

    const genesDir = join(root, config.genes_dir);
    const binding = options.sandbox ? tryLoadBinding() : null;
    const startTime = performance.now();

    // For non-Seq compositions with WASM support, use executeAlgebra()
    if (compositionType !== "Single" && compositionType !== "Seq" && binding) {
      const algebraResult = executeViaAlgebra(
        agent, genesDir, binding, input, compositionType, options.verbose
      );
      if (algebraResult !== null) {
        const totalElapsed = performance.now() - startTime;
        console.log();
        display.success("Pipeline execution complete");
        display.keyValue("Agent", agent.name);
        display.keyValue("Composition", compositionType);
        display.keyValue("Duration", `${totalElapsed.toFixed(1)}ms`);
        console.log();
        display.info("Final output:");
        console.log(JSON.stringify(algebraResult, null, 2));
        return;
      }
      display.warn("Falling back to sequential execution (some genes not compiled)");
    }

    // Pipeline execution log
    interface StepLog {
      gene: string;
      status: "success" | "error";
      engine: string;
      durationMs: number;
      inputPreview: string;
      outputPreview: string;
      error?: string;
    }
    const pipelineLog: StepLog[] = [];

    // Sequential execution (Seq / Single / fallback)
    let current: unknown = input;

    for (let i = 0; i < agent.genome.length; i++) {
      const geneName = agent.genome[i];
      const geneDir = join(genesDir, geneName);
      const step = `[${i + 1}/${agent.genome.length}]`;
      const irWasmPath = join(geneDir, "gene.ir.wasm");
      const hasIrWasm = existsSync(irWasmPath);
      const phenotypePath = join(geneDir, "phenotype.json");

      display.info(`${step} Executing gene: ${geneName}`);
      const inputPreview = JSON.stringify(current).slice(0, 200);

      if (hasIrWasm && binding) {
        const stepStart = performance.now();
        try {
          const irWasm = readFileSync(irWasmPath) as Buffer;
          const phenotype = existsSync(phenotypePath)
            ? readFileSync(phenotypePath, "utf-8")
            : "{}";

          const result = binding.executeGene(
            irWasm,
            JSON.stringify(current),
            phenotype
          );

          const stepElapsed = performance.now() - stepStart;

          if (result.success) {
            display.success(
              `${step} ${geneName} completed via WASM sandbox (${result.durationMs}ms, fuel: ${result.fuelConsumed})`
            );
            if (options.verbose) {
              display.info(`  Input:  ${inputPreview.slice(0, 150)}`);
              display.info(`  Output: ${JSON.stringify(result.output).slice(0, 150)}`);
            }
            pipelineLog.push({
              gene: geneName, status: "success", engine: "wasm",
              durationMs: stepElapsed, inputPreview,
              outputPreview: JSON.stringify(result.output).slice(0, 200),
            });
            current = result.output;
          } else {
            pipelineLog.push({
              gene: geneName, status: "error", engine: "wasm",
              durationMs: stepElapsed, inputPreview, outputPreview: "",
              error: result.errorMessage || "sandbox execution failed",
            });
            display.rustStyleError({
              code: "E0052",
              message: `Gene '${geneName}' sandbox execution failed: ${result.errorMessage}`,
              suggestion: "Run 'rotifer test " + geneName + " --verbose' to debug",
            });
            printPipelineLog(pipelineLog);
            process.exit(1);
          }
        } catch (err: any) {
          const stepElapsed = performance.now() - stepStart;
          pipelineLog.push({
            gene: geneName, status: "error", engine: "wasm",
            durationMs: stepElapsed, inputPreview, outputPreview: "",
            error: err.message,
          });
          display.rustStyleError({
            code: "E0052",
            message: `Gene '${geneName}' execution failed: ${err.message}`,
            suggestion: "Run 'rotifer test " + geneName + " --verbose' to debug",
          });
          printPipelineLog(pipelineLog);
          process.exit(1);
        }
      } else {
        if (!hasIrWasm) {
          display.warn(`  Running without sandbox — run 'rotifer compile ${geneName}' first`);
        }

        const srcFile = findSourceFile(geneDir);
        if (!srcFile) {
          pipelineLog.push({
            gene: geneName, status: "error", engine: "none",
            durationMs: 0, inputPreview, outputPreview: "",
            error: "no source file or compiled WASM",
          });
          display.rustStyleError({
            code: "E0051",
            message: `Gene '${geneName}' has no source file or compiled WASM`,
            file: geneDir,
            suggestion: "Ensure genes/" + geneName + "/index.ts exists",
          });
          printPipelineLog(pipelineLog);
          process.exit(1);
        }

        const stepStart = performance.now();
        try {
          const absPath = resolve(geneDir, srcFile);
          const mod = await import(pathToFileURL(absPath).href);

          if (typeof mod.express !== "function") {
            pipelineLog.push({
              gene: geneName, status: "error", engine: "node",
              durationMs: performance.now() - stepStart, inputPreview, outputPreview: "",
              error: "does not export express()",
            });
            display.error(`${step} Gene '${geneName}' does not export express()`);
            printPipelineLog(pipelineLog);
            process.exit(1);
          }

          const phenotypeData = existsSync(phenotypePath)
            ? JSON.parse(readFileSync(phenotypePath, "utf-8"))
            : {};

          let result: unknown;

          if (phenotypeData.fidelity === "Hybrid" && phenotypeData.network) {
            const { gatewayFetch, gateway } = createGatewayFetch(phenotypeData.network);
            display.info(`  ${geneName} is Hybrid — gateway active (domains: ${phenotypeData.network.allowedDomains?.join(", ") || "none"})`);
            result = await mod.express(current, { gatewayFetch });
            if (options.verbose) {
              const stats = gateway.stats;
              display.info(`  Gateway stats: ${stats.totalRequests} requests, ${stats.totalBytes} bytes`);
            }
          } else {
            result = await mod.express(current);
          }

          const stepElapsed = performance.now() - stepStart;

          display.success(`${step} ${geneName} completed via Node.js (${stepElapsed.toFixed(1)}ms)`);

          if (options.verbose) {
            display.info(`  Input:  ${inputPreview.slice(0, 150)}`);
            display.info(`  Output: ${JSON.stringify(result).slice(0, 150)}`);
          }

          pipelineLog.push({
            gene: geneName, status: "success", engine: phenotypeData.fidelity === "Hybrid" ? "node+gateway" : "node",
            durationMs: stepElapsed, inputPreview,
            outputPreview: JSON.stringify(result).slice(0, 200),
          });

          current = result;
        } catch (err: any) {
          const stepElapsed = performance.now() - stepStart;
          pipelineLog.push({
            gene: geneName, status: "error", engine: "node",
            durationMs: stepElapsed, inputPreview, outputPreview: "",
            error: err.message,
          });
          display.rustStyleError({
            code: "E0052",
            message: `Gene '${geneName}' execution failed: ${err.message}`,
            suggestion: "Run 'rotifer test " + geneName + " --verbose' to debug",
          });
          printPipelineLog(pipelineLog);
          process.exit(1);
        }
      }
    }

    const totalElapsed = performance.now() - startTime;

    console.log();
    display.success("Pipeline execution complete");
    display.keyValue("Agent", agent.name);
    display.keyValue("Genes Executed", String(agent.genome.length));
    display.keyValue("Composition", compositionType);
    display.keyValue("Duration", `${totalElapsed.toFixed(1)}ms`);

    if (options.verbose) {
      printPipelineLog(pipelineLog);
    }

    console.log();
    display.info("Final output:");
    console.log(JSON.stringify(current, null, 2));
  });

function printPipelineLog(log: Array<{
  gene: string; status: string; engine: string;
  durationMs: number; inputPreview: string;
  outputPreview: string; error?: string;
}>): void {
  console.log();
  display.info("Pipeline execution log:");
  console.log("  ┌─────┬──────────────────────────┬──────────┬──────────────┬───────────┐");
  console.log("  │  #  │ Gene                     │ Status   │ Engine       │ Duration  │");
  console.log("  ├─────┼──────────────────────────┼──────────┼──────────────┼───────────┤");
  for (let i = 0; i < log.length; i++) {
    const l = log[i];
    const num = String(i + 1).padStart(3);
    const name = l.gene.padEnd(24).slice(0, 24);
    const status = (l.status === "success" ? "OK" : "FAIL").padEnd(8);
    const engine = l.engine.padEnd(12).slice(0, 12);
    const dur = `${l.durationMs.toFixed(0)}ms`.padStart(9);
    console.log(`  │ ${num} │ ${name} │ ${status} │ ${engine} │ ${dur} │`);
    if (l.error) {
      console.log(`  │     │  Error: ${l.error.slice(0, 60).padEnd(60)}        │`);
    }
  }
  console.log("  └─────┴──────────────────────────┴──────────┴──────────────┴───────────┘");
}

function geneNameToId(geneName: string): string {
  return createHash("sha256").update(geneName).digest("hex");
}

function executeViaAlgebra(
  agent: AgentInfo,
  genesDir: string,
  binding: NativeBinding,
  input: unknown,
  compositionType: string,
  verbose: boolean,
): unknown | null {
  const comp = agent.composition;
  if (!comp) return null;

  const geneEntries: Record<string, { wasm: number[]; phenotype: Record<string, unknown> }> = {};

  for (const geneName of agent.genome) {
    const geneDir = join(genesDir, geneName);
    const irWasmPath = join(geneDir, "gene.ir.wasm");
    const phenotypePath = join(geneDir, "phenotype.json");

    if (!existsSync(irWasmPath)) {
      display.warn(`  Gene '${geneName}' not compiled — cannot use ${compositionType} via Rust executor`);
      return null;
    }

    const wasmBytes = readFileSync(irWasmPath);
    const phenotype = existsSync(phenotypePath)
      ? JSON.parse(readFileSync(phenotypePath, "utf-8"))
      : {};

    const hexId = geneNameToId(geneName);
    geneEntries[hexId] = {
      wasm: Array.from(wasmBytes),
      phenotype,
    };
  }

  const geneIds = agent.genome.map(geneNameToId);

  let algebraExpr: unknown;

  switch (compositionType) {
    case "Par": {
      const mergeMap: Record<string, string> = {
        first: "FirstSuccess",
        concat: "WaitAll",
        merge: "WaitAll",
      };
      algebraExpr = {
        Par: {
          branches: geneIds.map((id) => ({ Gene: hexToGeneIdArray(id) })),
          merge: mergeMap[comp?.merge || "first"] || "WaitAll",
          deadline: null,
        },
      };
      display.info(`Executing ${geneIds.length} genes in parallel via Rust AlgebraExecutor`);
      break;
    }
    case "Cond": {
      if (geneIds.length < 2) return null;
      const pred = comp?.predicate;
      algebraExpr = {
        Cond: {
          predicate: {
            field: pred?.field || "type",
            op: pred?.op || "Eq",
            value: pred?.value ?? pred?.equals ?? "primary",
          },
          then_branch: { Gene: hexToGeneIdArray(geneIds[0]) },
          else_branch: { Gene: hexToGeneIdArray(geneIds[1]) },
        },
      };
      display.info(`Conditional branch: ${agent.genome[0]} / ${agent.genome[1]}`);
      break;
    }
    case "Try": {
      if (geneIds.length < 2) return null;
      algebraExpr = {
        Try: {
          primary: { Gene: hexToGeneIdArray(geneIds[0]) },
          fallback: { Gene: hexToGeneIdArray(geneIds[1]) },
        },
      };
      display.info(`Try/Fallback: ${agent.genome[0]} → ${agent.genome[1]}`);
      break;
    }
    default:
      return null;
  }

  try {
    const result = binding.executeAlgebra(
      JSON.stringify(algebraExpr),
      JSON.stringify(geneEntries),
      JSON.stringify(input),
    );

    if (result.success) {
      display.success(
        `${compositionType} execution completed (${result.totalDurationMs}ms, fuel: ${result.totalFuelConsumed})`
      );
      if (verbose) {
        display.info(`  Steps executed: ${result.stepsExecuted}`);
        display.info(`  Output: ${JSON.stringify(result.output).slice(0, 200)}`);
      }
      return result.output;
    } else {
      display.rustStyleError({
        code: "E0053",
        message: `${compositionType} execution failed: ${result.errorMessage}`,
        suggestion: "Run 'rotifer test <gene> --verbose' to debug individual genes",
      });
      process.exit(1);
    }
  } catch (err: any) {
    display.rustStyleError({
      code: "E0053",
      message: `AlgebraExecutor error: ${err.message}`,
      suggestion: "Ensure all genes are compiled and valid",
    });
    process.exit(1);
  }
}

function hexToGeneIdArray(hex: string): number[] {
  const bytes: number[] = [];
  const padded = hex.padEnd(64, "0").slice(0, 64);
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(padded.slice(i, i + 2), 16));
  }
  return bytes;
}

function findAgent(root: string, name: string): AgentInfo | null {
  const agentsDir = join(root, ".rotifer", "agents");
  if (!existsSync(agentsDir)) return null;

  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const agent: AgentInfo = JSON.parse(
        readFileSync(join(agentsDir, file), "utf-8")
      );
      if (agent.name === name) return agent;
    } catch {
      // skip malformed
    }
  }
  return null;
}

function findSourceFile(geneDir: string): string | null {
  const candidates = ["index.ts", "index.js", "index.mjs"];
  for (const c of candidates) {
    if (existsSync(join(geneDir, c))) return c;
  }
  return null;
}
