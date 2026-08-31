import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { tryLoadBinding, type NativeBinding } from "../utils/binding.js";
import { evaluateL0, isExternallySourced } from "../utils/l0-gate.js";
import { createGatewayFetch, type GatewayFetchOptions, type GatewayResponse } from "../runtime/network-gateway.js";
import { DomainFailoverEngine, type GeneExecutionResult } from "../runtime/domain-failover.js";
import { flushInvocationReports } from "../cloud/invocation.js";
import { flushHeartbeat } from "../telemetry/heartbeat.js";
import { logGeneExecution } from "../utils/run-logger.js";
import { DEFAULT_SANDBOX_CONSTRAINTS_JSON } from "../utils/sandbox-defaults.js";

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
  .argument("<agent-name>", "agent name to run")
  .option("--input <json>", "input JSON for the pipeline", '{"name":"world"}')
  .option("--verbose", "show intermediate results", false)
  .option("--no-sandbox", "force Node.js execution (skip WASM sandbox)")
  .action(async (agentName: string, options: { input: string; verbose: boolean; sandbox: boolean }) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);

    display.header("Agent Execution");

    const agent = findAgent(root, agentName);
    if (!agent) {
      display.rustStyleError({
        code: "E0050",
        message: `Agent '${agentName}' not found`,
        suggestion: "Create one: rotifer agent create " + agentName + " --genes <g1> <g2>",
      });
      await flushInvocationReports();
      process.exit(1);
    }

    if (agent.genome.length === 0) {
      display.error("Agent has an empty genome — nothing to execute");
      display.info("Recreate with genes: rotifer agent create " + agentName + " --genes <g1> <g2>");
      await flushInvocationReports();
      process.exit(1);
    }

    let input: unknown;
    try {
      input = JSON.parse(options.input);
    } catch {
      display.error("Invalid --input JSON: " + options.input);
      display.hint('Example: --input \'{"name":"world"}\'');
      await flushInvocationReports();
      process.exit(1);
    }

    const isSandboxEnabled = options.sandbox;

    const compositionType =
      (typeof agent.composition === "object" ? agent.composition?.type : agent.composition) ||
      (agent.genome.length >= 2 ? "Seq" : "Single");

    const separator = compositionType === "Par" ? " ∥ " : " → ";
    display.info(`Agent: ${agent.name} (${agent.id})`);
    display.info(`Composition: ${compositionType}`);
    display.info(`Pipeline: ${agent.genome.join(separator)}`);
    console.log();

    const genesDir = join(root, config.genes_dir);
    // 两个角色，两个变量：L0 门控只查元数据、不需要沙箱，所以它不该随
    // --no-sandbox 一起关掉——那个开关的意思是「不用沙箱执行」，不是
    // 「跳过宪法级约束」。binding 保持原语义，供沙箱执行路径使用。
    const l0Binding = tryLoadBinding();
    const binding = isSandboxEnabled ? l0Binding : null;
    const startTime = performance.now();

    // TryPool: domain-based failover with fitness tracking
    if (compositionType === "TryPool") {
      await executeTryPool(agent, genesDir, binding, l0Binding, input, root, options.verbose);
      return;
    }

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
          const rawPhenotype = existsSync(phenotypePath)
            ? JSON.parse(readFileSync(phenotypePath, "utf-8"))
            : {};
          const { irHash: _strip, ...phenotypeForExec } = rawPhenotype;

          const result = binding.executeGene(
            irWasm,
            JSON.stringify(current),
            JSON.stringify(phenotypeForExec),
            DEFAULT_SANDBOX_CONSTRAINTS_JSON,
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
            logGeneExecution({ geneDir,
              geneName, success: true, durationMs: stepElapsed,
              inputSize: inputPreview.length,
              outputSize: JSON.stringify(result.output).length,
            });
            current = result.output;
          } else {
            pipelineLog.push({
              gene: geneName, status: "error", engine: "wasm",
              durationMs: stepElapsed, inputPreview, outputPreview: "",
              error: result.errorMessage || "sandbox execution failed",
            });
            logGeneExecution({ geneDir,
              geneName, success: false, durationMs: stepElapsed,
              inputSize: inputPreview.length, outputSize: 0,
              error: result.errorMessage || "sandbox execution failed",
            });
            display.rustStyleError({
              code: "E0052",
              message: `Gene '${geneName}' sandbox execution failed: ${result.errorMessage}`,
              suggestion: "Run 'rotifer test " + geneName + " --verbose' to debug",
            });
            printPipelineLog(pipelineLog);
            await flushInvocationReports();
            await flushHeartbeat();
            process.exit(1);
          }
        } catch (err: any) {
          const stepElapsed = performance.now() - stepStart;
          pipelineLog.push({
            gene: geneName, status: "error", engine: "wasm",
            durationMs: stepElapsed, inputPreview, outputPreview: "",
            error: err.message,
          });
          logGeneExecution({ geneDir,
            geneName, success: false, durationMs: stepElapsed,
            inputSize: inputPreview.length, outputSize: 0,
            error: err.message,
          });
          display.rustStyleError({
            code: "E0052",
            message: `Gene '${geneName}' execution failed: ${err.message}`,
            suggestion: "Run 'rotifer test " + geneName + " --verbose' to debug",
          });
          printPipelineLog(pipelineLog);
          await flushInvocationReports();
          await flushHeartbeat();
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
          await flushInvocationReports();
          await flushHeartbeat();
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
            await flushInvocationReports();
            await flushHeartbeat();
            process.exit(1);
          }

          const phenotypeData = existsSync(phenotypePath)
            ? JSON.parse(readFileSync(phenotypePath, "utf-8"))
            : {};

          const l0 = evaluateL0(l0Binding, phenotypeData);
          const violation =
            l0.kind === "violation"
              ? l0.detail
              : l0.kind === "unavailable" && isExternallySourced(geneDir)
                ? `could not run (${l0.detail}) on an installed gene`
                : null;
          if (l0.kind === "unavailable" && !violation) {
            display.warn(`${step} L0 gate could not run (${l0.detail}) — running this local gene unchecked.`);
          }
          if (violation) {
            pipelineLog.push({
              gene: geneName, status: "error", engine: "node",
              durationMs: performance.now() - stepStart, inputPreview, outputPreview: "",
              error: `L0 gate blocked: ${violation}`,
            });
            display.error(`${step} L0 gate blocked '${geneName}': ${violation}`);
            printPipelineLog(pipelineLog);
            await flushInvocationReports();
            await flushHeartbeat();
            process.exit(1);
          }

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
          logGeneExecution({ geneDir,
            geneName, success: true, durationMs: stepElapsed,
            inputSize: inputPreview.length,
            outputSize: JSON.stringify(result).length,
          });

          current = result;
        } catch (err: any) {
          const stepElapsed = performance.now() - stepStart;
          pipelineLog.push({
            gene: geneName, status: "error", engine: "node",
            durationMs: stepElapsed, inputPreview, outputPreview: "",
            error: err.message,
          });
          logGeneExecution({ geneDir,
            geneName, success: false, durationMs: stepElapsed,
            inputSize: inputPreview.length, outputSize: 0,
            error: err.message,
          });
          display.rustStyleError({
            code: "E0052",
            message: `Gene '${geneName}' execution failed: ${err.message}`,
            suggestion: "Run 'rotifer test " + geneName + " --verbose' to debug",
          });
          printPipelineLog(pipelineLog);
          await flushInvocationReports();
          await flushHeartbeat();
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

    printProtocolInsights(agent.genome, genesDir, totalElapsed);

    // Every gene in the pipeline succeeded, so this falls all the way through
    // without ever calling process.exit() — the same shape run.ts's success
    // path had, which turned out not to drain the pending heartbeat request
    // on its own (see heartbeat.ts's top comment). Flush explicitly here too.
    await flushHeartbeat();
  });

function printPipelineLog(log: Array<{
  gene: string; status: string; engine: string;
  durationMs: number; inputPreview: string;
  outputPreview: string; error?: string;
}>): void {
  console.log();
  display.info("Pipeline execution log:");
  display.table(
    log.map((l, i) => ({
      _idx: i + 1,
      gene: l.gene,
      status: l.status,
      engine: l.engine,
      duration: `${l.durationMs.toFixed(0)}ms`,
      error: l.error || "",
    })),
    [
      { key: "_idx", label: "#", width: 4, align: "right" },
      { key: "gene", label: "Gene", width: 24 },
      { key: "status", label: "Status", width: 10,
        format: (v) => String(v) === "success" ? c.success("OK") : c.error("FAIL") },
      { key: "engine", label: "Engine", width: 14 },
      { key: "duration", label: "Duration", width: 10 },
    ],
  );
  for (const l of log) {
    if (l.error) {
      display.error(`${l.gene}: ${l.error}`);
    }
  }
}

async function executeTryPool(
  agent: AgentInfo,
  genesDir: string,
  binding: NativeBinding | null,
  l0Binding: NativeBinding | null,
  input: unknown,
  root: string,
  isVerbose: boolean,
): Promise<void> {
  const engine = new DomainFailoverEngine();
  const startTime = performance.now();

  for (const geneName of agent.genome) {
    const geneDir = join(genesDir, geneName);
    const phenotypePath = join(geneDir, "phenotype.json");
    const phenotype = existsSync(phenotypePath)
      ? JSON.parse(readFileSync(phenotypePath, "utf-8"))
      : {};
    const domain: string = phenotype.domain || "default";
    const irWasmPath = join(geneDir, "gene.ir.wasm");
    const hasWasm = existsSync(irWasmPath);

    const executor = await buildGeneExecutor(
      geneName, geneDir, irWasmPath, hasWasm, phenotype, binding, l0Binding
    );
    engine.registerGene(geneName, domain, executor);
  }

  const fitnessPath = join(root, ".rotifer", "agents", `${agent.name}.fitness.json`);
  if (existsSync(fitnessPath)) {
    try {
      const saved = JSON.parse(readFileSync(fitnessPath, "utf-8"));
      engine.loadFitnessState(saved);
      display.info("Loaded fitness state from previous run");
    } catch { /* fresh start */ }
  }

  engine.initialize();

  const domains = engine.getDomains();
  display.info(`TryPool: ${domains.length} domain(s), ${agent.genome.length} gene(s)`);
  for (const d of domains) {
    const active = engine.getActiveGene(d);
    display.info(`  ${d}: ${engine.getPoolSize(d)} genes (active: ${active})`);
  }
  console.log();

  const results = await engine.executeAll(input);

  let hasAnyFailed = false;
  const outputs: Record<string, unknown> = {};

  for (const r of results) {
    if (r.status === "success") {
      const sw = r.switchedFrom ? ` (switched from ${r.switchedFrom})` : "";
      display.success(
        `${r.domain}: ${r.geneUsed} (${r.attempts} attempt(s), ${r.durationMs.toFixed(1)}ms)${sw}`
      );
      outputs[r.domain] = r.output;
    } else {
      display.error(`${r.domain}: all ${r.attempts} gene(s) failed`);
      hasAnyFailed = true;
    }
  }

  try {
    writeFileSync(fitnessPath, JSON.stringify(engine.exportFitnessState(), null, 2));
  } catch { /* non-fatal */ }

  const totalElapsed = performance.now() - startTime;
  console.log();

  if (isVerbose) {
    display.info("Fitness state:");
    const state = engine.exportFitnessState();
    for (const [name, s] of Object.entries(state)) {
      const bar = "█".repeat(Math.round(s.fitness * 20)).padEnd(20, "░");
      console.log(`  ${name.padEnd(30)} ${bar} ${s.fitness.toFixed(3)}  (${s.successes}✓ ${s.failures}✗)`);
    }
    console.log();
  }

  const switches = results.filter((r) => r.switchedFrom).length;
  if (hasAnyFailed) {
    display.warn("TryPool execution finished with failures");
  } else {
    display.success("TryPool execution complete");
  }
  display.keyValue("Agent", agent.name);
  display.keyValue("Domains", `${domains.length}`);
  display.keyValue("Succeeded", `${results.filter((r) => r.status === "success").length}/${domains.length}`);
  if (switches > 0) {
    display.keyValue("Gene Switches", `${switches}`);
  }
  display.keyValue("Duration", `${totalElapsed.toFixed(1)}ms`);
  console.log();
  display.info("Output:");
  console.log(JSON.stringify(outputs, null, 2));

  if (hasAnyFailed) {
    void Promise.allSettled([flushInvocationReports(), flushHeartbeat()]).finally(() => process.exit(1));
    return undefined as never;
  }

  // Success: every domain's active gene ran through buildGeneExecutor, which
  // calls logGeneExecution (and therefore recordHeartbeat) per gene. This
  // falls through without process.exit(), the same shape that dropped the
  // heartbeat in run.ts's success path — flush explicitly rather than trust
  // the event loop to drain it.
  await flushHeartbeat();
}

async function buildGeneExecutor(
  geneName: string,
  geneDir: string,
  irWasmPath: string,
  hasWasm: boolean,
  phenotype: Record<string, unknown>,
  binding: NativeBinding | null,
  l0Binding: NativeBinding | null,
): Promise<(input: unknown) => Promise<GeneExecutionResult>> {
  if (hasWasm && binding) {
    const wasmBytes = readFileSync(irWasmPath) as Buffer;
    const { irHash: _strip, ...phenotypeForExec } = phenotype;
    const phenoStr = JSON.stringify(phenotypeForExec);
    return async (input: unknown): Promise<GeneExecutionResult> => {
      const start = performance.now();
      try {
        const result = binding.executeGene(
          wasmBytes,
          JSON.stringify(input),
          phenoStr,
          DEFAULT_SANDBOX_CONSTRAINTS_JSON,
        );
        const elapsed = performance.now() - start;
        logGeneExecution({ geneDir,
          geneName, success: result.success, durationMs: elapsed,
          inputSize: JSON.stringify(input).length,
          outputSize: result.output ? JSON.stringify(result.output).length : 0,
          error: result.errorMessage || undefined,
        });
        return {
          success: result.success,
          output: result.output,
          error: result.errorMessage || undefined,
          engine: "wasm",
          durationMs: elapsed,
          fuelConsumed: result.fuelConsumed,
        };
      } catch (err: any) {
        const elapsed = performance.now() - start;
        logGeneExecution({ geneDir,
          geneName, success: false, durationMs: elapsed,
          inputSize: JSON.stringify(input).length, outputSize: 0,
          error: err.message,
        });
        return {
          success: false,
          error: err.message,
          engine: "wasm",
          durationMs: elapsed,
        };
      }
    };
  }

  // 走到这里说明没有可用的 WASM 路径，接下来是 Node.js 执行——它没有沙箱，
  // 所以门控必须在这里拦。TryPool 语义下拦截表现为「该基因失败」而非终止进程，
  // 这样 failover 会照常换下一个基因。
  const l0 = evaluateL0(l0Binding, phenotype);
  const blocked =
    l0.kind === "violation"
      ? l0.detail
      : l0.kind === "unavailable" && isExternallySourced(geneDir)
        ? `could not run (${l0.detail}) on an installed gene`
        : null;
  if (blocked) {
    return async (): Promise<GeneExecutionResult> => ({
      success: false,
      error: `L0 gate blocked: ${blocked}`,
      engine: "none",
      durationMs: 0,
    });
  }

  const srcFile = findSourceFile(geneDir);
  if (!srcFile) {
    return async (): Promise<GeneExecutionResult> => ({
      success: false,
      error: `Gene '${geneName}' has no source file or compiled WASM`,
      engine: "none",
      durationMs: 0,
    });
  }

  const absPath = resolve(geneDir, srcFile);
  const mod = await import(pathToFileURL(absPath).href);

  if (typeof mod.express !== "function") {
    return async (): Promise<GeneExecutionResult> => ({
      success: false,
      error: `Gene '${geneName}' does not export express()`,
      engine: "none",
      durationMs: 0,
    });
  }

  const isHybrid = phenotype.fidelity === "Hybrid" && phenotype.network;

  return async (input: unknown): Promise<GeneExecutionResult> => {
    const start = performance.now();
    try {
      let result: unknown;
      if (isHybrid) {
        const { gatewayFetch } = createGatewayFetch(phenotype.network as any);
        result = await mod.express(input, { gatewayFetch });
      } else {
        result = await mod.express(input);
      }
      const elapsed = performance.now() - start;
      logGeneExecution({ geneDir,
        geneName, success: true, durationMs: elapsed,
        inputSize: JSON.stringify(input).length,
        outputSize: JSON.stringify(result).length,
      });
      return {
        success: true,
        output: result,
        engine: isHybrid ? "node+gateway" : "node",
        durationMs: elapsed,
      };
    } catch (err: any) {
      const elapsed = performance.now() - start;
      logGeneExecution({ geneDir,
        geneName, success: false, durationMs: elapsed,
        inputSize: JSON.stringify(input).length, outputSize: 0,
        error: err.message,
      });
      return {
        success: false,
        error: err.message,
        engine: "node",
        durationMs: elapsed,
      };
    }
  };
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
  isVerbose: boolean,
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
      if (isVerbose) {
        display.info(`  Steps executed: ${result.stepsExecuted}`);
        display.info(`  Output: ${JSON.stringify(result.output).slice(0, 200)}`);
      }
      return result.output;
    } else {
      display.rustStyleError({
        code: "E0053",
        message: `${compositionType} execution failed: ${result.errorMessage}`,
        suggestion: "Run 'rotifer test <gene-name> --verbose' to debug individual genes",
      });
      // Not an async scope here: defer the exit until the report settles.
      void flushInvocationReports().finally(() => process.exit(1));
      return undefined as never;
    }
  } catch (err: any) {
    display.rustStyleError({
      code: "E0053",
      message: `AlgebraExecutor error: ${err.message}`,
      suggestion: "Ensure all genes are compiled and valid",
    });
    void flushInvocationReports().finally(() => process.exit(1));
    return undefined as never;
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

export function findAgent(root: string, agentName: string): AgentInfo | null {
  const agentsDir = join(root, ".rotifer", "agents");
  if (!existsSync(agentsDir)) return null;

  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const agent: AgentInfo = JSON.parse(
        readFileSync(join(agentsDir, file), "utf-8")
      );
      if (agent.name === agentName) return agent;
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

export function printProtocolInsights(
  genome: string[],
  genesDir: string,
  durationMs: number,
): void {
  if (genome.length === 0) return;

  const geneStats: Array<{ name: string; domain: string; executable: boolean }> = [];

  for (const name of genome) {
    const phenotypePath = join(genesDir, name, "phenotype.json");
    if (!existsSync(phenotypePath)) continue;

    try {
      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
      const hasExpress = existsSync(join(genesDir, name, "index.ts")) ||
                         existsSync(join(genesDir, name, "index.js")) ||
                         existsSync(join(genesDir, name, "index.mjs"));

      geneStats.push({
        name,
        domain: phenotype.domain || "general",
        executable: hasExpress,
      });
    } catch {
      // skip
    }
  }

  if (geneStats.length === 0) return;

  const primaryDomain = geneStats[0]?.domain || "general";
  const domains = new Set(geneStats.map((g) => g.domain));
  const executableCount = geneStats.filter((g) => g.executable).length;

  console.log();
  display.header("Genome Snapshot");
  display.keyValue("Primary Domain", primaryDomain);
  display.keyValue("Distinct Domains", `${domains.size}`);
  display.keyValue("Genes in Genome", `${geneStats.length}`);
  display.keyValue("Executable Genes", `${executableCount}/${geneStats.length}`);
  display.keyValue("Run Duration", `${durationMs.toFixed(0)}ms`);
  console.log();

  const suggestions: string[] = [];
  if (domains.size === 1) {
    suggestions.push("Try adding genes from another domain for cross-domain resilience");
  }
  if (genome.length === 1) {
    suggestions.push("Add a second gene with TryPool composition for automatic failover");
  }
  if (executableCount < geneStats.length) {
    suggestions.push("Some genes are metadata-only — add executable implementations for end-to-end runs");
  }
  suggestions.push("Run `rotifer arena submit <gene>` to compete and refine fitness");

  display.info("Genome suggestions:");
  for (const s of suggestions) {
    display.hint(`  → ${s}`);
  }
}
