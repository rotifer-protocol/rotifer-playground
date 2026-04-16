import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { DEFAULT_SANDBOX_CONSTRAINTS_JSON } from "../utils/sandbox-defaults.js";
import { validateGeneName } from "../utils/validate-gene-name.js";

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
        display.error("Not in a Rotifer project. Run 'rotifer init' first.");
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

      const isSandboxEnabled = !process.argv.includes("--no-sandbox");

      if (options.verbose) {
        display.keyValue("Gene", geneName);
        display.keyValue("Domain", phenotype.domain || "unknown");
        display.keyValue("Fidelity", phenotype.fidelity || "Wrapped");
        display.keyValue("Input", JSON.stringify(input));
        console.log();
      }

      const wasmPath = join(geneDir, "gene.ir.wasm");
      const sourcePath = join(geneDir, "index.ts");

      if (existsSync(wasmPath) && isSandboxEnabled) {
        display.info("Running via WASM sandbox...");
        try {
          const { tryLoadBinding } = await import("../utils/binding.js");
          const binding = tryLoadBinding();
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
            if (execResult.success) {
              display.success("Output:");
              console.log(JSON.stringify(execResult.output, null, 2));
            } else {
              display.error("Execution failed: " + (execResult.errorMessage || "unknown"));
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
        const isCloudGene = existsSync(join(geneDir, ".cloud-manifest.json"));
        if (isCloudGene && !options.trustUnsigned) {
          display.error("Cloud-installed genes cannot run via Node.js without sandbox.");
          display.hint("Use --trust-unsigned to explicitly allow unsandboxed execution.");
          display.hint("Or compile the gene first: rotifer compile " + geneName);
          process.exit(1);
          return;
        }
        display.info("Running via Node.js...");
        try {
          const mod = await import(sourcePath);
          const fn = mod.express || mod.default || mod.main;
          if (typeof fn !== "function") {
            display.error("No exported express/default/main function found in index.ts");
            display.hint("Gene must export an 'express' function: export function express(input) { ... }");
            process.exit(1);
            return;
          }
          const output = await fn(input);
          console.log();
          display.success("Output:");
          console.log(JSON.stringify(output, null, 2));
        } catch (err: any) {
          display.error("Execution failed: " + err.message);
          display.hint("Use --verbose for full stack trace.");
          if (options.verbose && err.stack) {
            console.error(err.stack);
          }
          process.exit(1);
        }
      } else {
        display.error("No runnable source found (need gene.ir.wasm or index.ts)");
        display.hint("Compile first: rotifer compile " + geneName);
        process.exit(1);
      }
    }
  );
