import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { DEFAULT_SANDBOX_CONSTRAINTS_JSON } from "../utils/sandbox-defaults.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { flushInvocationReports, recordGeneInvocation } from "../cloud/invocation.js";
import { evaluateL0, isExternallySourced } from "../utils/l0-gate.js";

export const runCommand = new Command("run")
  .description("Execute a single gene directly")
  .argument("<gene-name>", "gene name to execute")
  .option("--input <json>", "input JSON string", '{"name":"world"}')
  .option("--verbose", "show detailed execution output", false)
  .option("--no-sandbox", "run without WASM sandbox (Node.js only)")
  .option("--trust-unsigned", "allow Node.js execution for Cloud-installed genes", false)
  .action(
    async (
      geneName: string,
      options: { input: string; verbose: boolean; sandbox: boolean; trustUnsigned: boolean }
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
            if (execResult.success) {
              display.success("Output:");
              console.log(JSON.stringify(execResult.output, null, 2));
            } else {
              display.error("Execution failed: " + (execResult.errorMessage || "unknown"));
              // The report above is fire-and-forget; process.exit would kill it
              // in flight (that is exactly how the first real end-to-end run
              // produced no row at all). Let it settle first.
              await flushInvocationReports();
              process.exit(1);
              return;
            }
            display.kv("Duration", `${execResult.durationMs}ms`);
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
          const mod = await import(sourcePath);
          const fn = mod.express || mod.default || mod.main;
          if (typeof fn !== "function") {
            display.error("No exported express/default/main function found in index.ts");
            display.hint("Gene must export an 'express' function: export function express(input) { ... }");
            await flushInvocationReports();
            process.exit(1);
            return;
          }
          // A Hybrid gene expects the network gateway on its second argument —
          // `rotifer test` and `rotifer agent run` already inject it; `run` did
          // not, so the same gene that passed `test` threw here asking for a
          // gatewayFetch nobody gave it.
          let output: unknown;
          if (phenotype.fidelity === "Hybrid" && phenotype.network) {
            const { createGatewayFetch } = await import("../runtime/network-gateway.js");
            const { gatewayFetch, gateway } = createGatewayFetch(phenotype.network);
            display.info(`Hybrid gene — gateway active (domains: ${phenotype.network.allowedDomains?.join(", ") || "none"})`);
            output = await fn(input, { gatewayFetch });
            if (options.verbose) {
              display.info(`Gateway: ${gateway.stats.totalRequests} requests, ${gateway.stats.totalBytes} bytes`);
            }
          } else {
            output = await fn(input);
          }
          console.log();
          display.success("Output:");
          console.log(JSON.stringify(output, null, 2));
        } catch (err: any) {
          display.error("Execution failed: " + err.message);
          display.hint("Use --verbose for full stack trace.");
          if (options.verbose && err.stack) {
            console.error(err.stack);
          }
          await flushInvocationReports();
          process.exit(1);
        }
      } else {
        display.error("No runnable source found (need gene.ir.wasm or index.ts)");
        display.hint("Compile first: rotifer compile " + geneName);
        process.exit(1);
      }
    }
  );
