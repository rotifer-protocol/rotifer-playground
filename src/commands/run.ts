import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { DEFAULT_SANDBOX_CONSTRAINTS_JSON } from "../utils/sandbox-defaults.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { flushInvocationReports, recordGeneInvocation } from "../cloud/invocation.js";
import { recordHeartbeat, flushHeartbeat } from "../telemetry/heartbeat.js";
import { evaluateL0, isExternallySourced } from "../utils/l0-gate.js";
import { compileSchemaCheck } from "../utils/arena-success.js";
import { readErrorEnvelope } from "../testsuite/gate.js";

export const runCommand = new Command("run")
  .description("Execute a single gene directly, checking its input and output against the gene's schema")
  .argument("<gene-name>", "gene name to execute")
  .option("--input <json>", "input JSON string", '{"name":"world"}')
  .option("--verbose", "show detailed execution output", false)
  .option("--no-sandbox", "run without WASM sandbox (Node.js only)")
  .option("--trust-unsigned", "allow Node.js execution for Cloud-installed genes", false)
  .option("--no-validate", "skip checking the input and output against the gene's inputSchema / outputSchema")
  .action(
    async (
      geneName: string,
      options: { input: string; verbose: boolean; sandbox: boolean; trustUnsigned: boolean; validate: boolean }
    ) => {
      display.header(`Run Gene: ${geneName}`);
      validateGeneName(geneName);

      let root: string;
      try {
        root = getProjectRoot();
      } catch {
        display.error("Not in a Rotifer Agent workspace. Run 'rotifer init' first.");
        process.exit(1);
        return;
      }

      const config = loadConfig(root);
      const geneDir = join(root, config.genes_dir, geneName);

      if (!existsSync(join(geneDir, "phenotype.json"))) {
        display.error(`Gene '${geneName}' not found at ${geneDir}`);
        display.hint("List local genes: rotifer list");
        process.exit(1);
        return;
      }

      let phenotype: any;
      try {
        phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
      } catch (err: any) {
        display.error("Failed to read phenotype.json: " + err.message);
        display.hint("Ensure phenotype.json exists and is valid JSON.");
        process.exit(1);
        return;
      }

      let input: Record<string, unknown>;
      try {
        input = JSON.parse(options.input);
      } catch {
        display.error("Invalid --input JSON: " + options.input);
        display.hint('Example: --input \'{"name":"world"}\'');
        process.exit(1);
        return;
      }

      // The gene's own schema is the contract (#451): an input it does not
      // accept is refused before anything runs, as INVALID_INPUT (spec §4.2),
      // and an output it did not promise fails the run, as the Arena counts it
      // (utils/arena-success.ts — the same check). Both paths, WASM and Node.js.
      const checkOutput = options.validate ? compileSchemaCheck(phenotype.outputSchema) : null;
      if (options.validate) {
        const inputViolation = compileSchemaCheck(phenotype.inputSchema)?.(input) ?? null;
        if (inputViolation) {
          display.error(`INVALID_INPUT: the input does not match ${geneName}'s inputSchema: ${inputViolation}`);
          display.hint("Nothing was run. Fix --input, or pass --no-validate to run it anyway.");
          process.exit(1);
          return;
        }
      } else {
        display.warn("Schema validation is off (--no-validate): input and output are not checked against the gene's schema.");
      }
      /** Fails the run when the output breaks outputSchema; true when it may stand. */
      const acceptOutput = async (output: unknown): Promise<boolean> => {
        const violation = checkOutput?.(output) ?? null;
        if (!violation) return true;
        display.error(`The output does not match ${geneName}'s outputSchema: ${violation}`);
        display.info("Output returned:");
        console.log(JSON.stringify(output, null, 2));
        display.hint("The run counts as failed, as it would in the Arena.");
        await flushInvocationReports();
        await flushHeartbeat();
        process.exit(1);
        return false;
      };

      const isSandboxEnabled = options.sandbox;

      if (options.verbose) {
        display.keyValue("Gene", geneName);
        display.keyValue("Domain", phenotype.domain || "unknown");
        display.keyValue("Fidelity", phenotype.fidelity || "Wrapped");
        display.keyValue("Input", JSON.stringify(input));
        console.log();
      }

      const wasmPath = join(geneDir, "gene.ir.wasm");
      const sourcePath = join(geneDir, "index.ts");

      // L0 门控只检查元数据（域、资源上限声明、文件系统路径），不需要沙箱。
      // 加载点必须在两条执行路径之外：原先它关在 WASM 分支内部，降级路径根本
      // 拿不到它——那正是「Node.js 降级整条绕过 L0」的成因。
      const { tryLoadBinding } = await import("../utils/binding.js");
      const binding = tryLoadBinding();

      if (existsSync(wasmPath) && isSandboxEnabled) {
        // #58: warn when the source was edited after the last compile — the
        // sandbox would otherwise silently execute stale WASM.
        const { isWasmStale } = await import("../utils/javy-compiler.js");
        if (isWasmStale(wasmPath, sourcePath)) {
          display.warn(
            `gene.ir.wasm is older than index.ts — running stale WASM. Re-run \`rotifer compile ${geneName}\` to refresh.`,
          );
        }
        display.info("Running via WASM sandbox...");
        try {
          if (binding) {
            const wasmBytes = readFileSync(wasmPath);
            const rawPhenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
            const { irHash: _strip, ...phenotypeForExec } = rawPhenotype;
            const execResult = binding.executeGene(
              wasmBytes,
              JSON.stringify(input),
              JSON.stringify(phenotypeForExec),
              DEFAULT_SANDBOX_CONSTRAINTS_JSON,
            );
            console.log();
            // A Cloud-installed Gene that ran is an invocation the protocol's
            // anti-manipulation metrics count on; report it (signed in + telemetry
            // on only — see cloud/invocation.ts). Success or not: it was called.
            recordGeneInvocation(geneDir);
            // Separate, narrower signal: any Gene running at all, no identity
            // required, on by default (ADR-329). Its own consent check —
            // independent of whether recordGeneInvocation above decided to
            // report anything.
            recordHeartbeat();
            if (execResult.success) {
              if (!(await acceptOutput(execResult.output))) return;
              display.success("Output:");
              console.log(JSON.stringify(execResult.output, null, 2));
            } else {
              display.error("Execution failed: " + (execResult.errorMessage || "unknown"));
              // Both reports above are fire-and-forget; process.exit would kill
              // them in flight (that is exactly how the first real end-to-end
              // run produced no invocation row, and how a later production run
              // produced no heartbeat row either — see heartbeat.ts's top
              // comment). Let them settle first.
              await flushInvocationReports();
              await flushHeartbeat();
              process.exit(1);
              return;
            }
            display.kv("Duration", `${execResult.durationMs}ms`);
            // Success does not call process.exit(), but "the event loop stays
            // open until the fetch settles" turned out not to hold for the
            // heartbeat request either (heartbeat.ts's top comment) — flush
            // explicitly rather than trust that assumption a second time.
            await flushHeartbeat();
            return;
          }
        } catch { /* fall through to Node.js */ }
        display.warn("WASM sandbox unavailable, falling back to Node.js");
      }

      if (existsSync(sourcePath)) {
        // 「外来」按纸条的写入者判（install 写的才算），不按纸条有没有——随包发的
        // 起步基因和用户自己发布过的基因都带纸条，但那是他们自己的代码。见 l0-gate.ts。
        const isCloudGene = isExternallySourced(geneDir);
        if (isCloudGene && !options.trustUnsigned) {
          display.error("Cloud-installed genes cannot run via Node.js without sandbox.");
          display.hint("Use --trust-unsigned to explicitly allow unsandboxed execution.");
          display.hint("Or compile the gene first: rotifer compile " + geneName);
          process.exit(1);
          return;
        }
        // ── L0 门控：降级路径同样必须过 ──────────────────────────────────
        // 这条路径没有沙箱，基因以宿主进程的完整权限运行（fs / child_process /
        // 全局 fetch 都在手）。Spec 定义 L0 是唯一不参与进化、不可绕过的约束，
        // 因此这里 fail closed：门控跑不了就不执行，而不是静默放行。
        const l0 = evaluateL0(binding, phenotype);
        if (l0.kind === "violation") {
          display.error("L0 gate blocked: " + l0.detail);
          display.hint("The Node.js fallback runs the gene with full host privileges, unchecked.");
          process.exit(1);
          return;
        }
        if (l0.kind === "unavailable") {
          // 门控跑不了。外部来源的基因一律拒绝；本地源码基因放行并警告——
          // 否则拿不到原生插件的平台上，CLI 会整个不可用。
          if (isCloudGene) {
            display.error(`L0 gate could not run (${l0.detail}) — refusing to run an installed gene unchecked.`);
            display.hint("Reinstall the platform package, or compile and run under the sandbox.");
            process.exit(1);
            return;
          }
          display.warn(`L0 gate could not run (${l0.detail}) — running this local gene unchecked.`);
        } else if (options.verbose) {
          display.info("L0 gate: PASS");
        }

        display.info("Running via Node.js...");
        try {
          recordGeneInvocation(geneDir);
          recordHeartbeat();
          // A file: URL, not the path: on Windows a raw C:\... path parses as a
          // URL with scheme "c:" and the ESM loader refuses it (T-112).
          const mod = await import(pathToFileURL(sourcePath).href);
          const fn = mod.express || mod.default || mod.main;
          if (typeof fn !== "function") {
            display.error("No exported express/default/main function found in index.ts");
            display.hint("Gene must export an 'express' function: export function express(input) { ... }");
            await flushInvocationReports();
            await flushHeartbeat();
            process.exit(1);
            return;
          }
          // A Hybrid gene expects the network gateway on its second argument —
          // `rotifer test` and `rotifer agent run` already inject it; `run` did
          // not, so the same gene that passed `test` threw here asking for a
          // gatewayFetch nobody gave it.
          let output: unknown;
          // No agent here: ctx.memory is present and refuses "no agent context".
          const { projectNoAgentMemory } = await import("../memory/host.js");
          const memory = projectNoAgentMemory(root, geneDir);
          if (phenotype.fidelity === "Hybrid" && phenotype.network) {
            const { createGatewayFetch } = await import("../runtime/network-gateway.js");
            const { gatewayFetch, gateway } = createGatewayFetch(phenotype.network);
            display.info(`Hybrid gene — gateway active (domains: ${phenotype.network.allowedDomains?.join(", ") || "none"})`);
            output = await fn(input, { gatewayFetch, memory });
            if (options.verbose) {
              display.info(`Gateway: ${gateway.stats.totalRequests} requests, ${gateway.stats.totalBytes} bytes`);
            }
          } else {
            output = await fn(input, { memory });
          }
          console.log();
          // A lone __rotifer_error is the gene refusing (ADR-334). The sandbox
          // reports it as INVALID_INPUT; read it the same way here, rather than
          // as output that breaks outputSchema.
          const refusal = readErrorEnvelope(output);
          if (refusal) {
            display.error("Execution failed: " + refusal);
            await flushInvocationReports();
            await flushHeartbeat();
            process.exit(1);
            return;
          }
          if (!(await acceptOutput(output))) return;
          display.success("Output:");
          console.log(JSON.stringify(output, null, 2));
          // See the WASM branch above: success falls through without
          // process.exit(), but that alone does not guarantee the heartbeat
          // fetch settles before Node's event loop empties — flush explicitly.
          await flushHeartbeat();
        } catch (err: any) {
          display.error("Execution failed: " + err.message);
          display.hint("Use --verbose for full stack trace.");
          if (options.verbose && err.stack) {
            console.error(err.stack);
          }
          await flushInvocationReports();
          await flushHeartbeat();
          process.exit(1);
        }
      } else {
        display.error("No runnable source found (need gene.ir.wasm or index.ts)");
        display.hint("Compile first: rotifer compile " + geneName);
        process.exit(1);
      }
    }
  );
