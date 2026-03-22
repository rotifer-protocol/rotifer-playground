import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";

export const runCommand = new Command("run")
  .description("Execute a single gene directly")
  .argument("<name>", "gene name (directory name under genes/)")
  .option("--input <json>", "input JSON string", '{"name":"world"}')
  .option("--verbose", "show detailed execution output", false)
  .option("--no-sandbox", "run without WASM sandbox (Node.js only)")
  .action(
    async (
      name: string,
      options: { input: string; verbose: boolean; sandbox: boolean }
    ) => {
      display.header(`Run Gene: ${name}`);

      let root: string;
      try {
        root = getProjectRoot();
      } catch {
        display.error("Not in a Rotifer project. Run 'rotifer init' first.");
        process.exit(1);
        return;
      }

      const config = loadConfig(root);
      const geneDir = join(root, config.genes_dir, name);

      if (!existsSync(join(geneDir, "phenotype.json"))) {
        display.error(`Gene '${name}' not found at ${geneDir}`);
        display.info("List local genes: rotifer list");
        process.exit(1);
        return;
      }

      let phenotype: any;
      try {
        phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
      } catch (err: any) {
        display.error("Failed to read phenotype.json: " + err.message);
        process.exit(1);
        return;
      }

      let input: Record<string, unknown>;
      try {
        input = JSON.parse(options.input);
      } catch {
        display.error("Invalid --input JSON: " + options.input);
        process.exit(1);
        return;
      }

      if (options.verbose) {
        display.keyValue("Gene", name);
        display.keyValue("Domain", phenotype.domain || "unknown");
        display.keyValue("Fidelity", phenotype.fidelity || "Wrapped");
        display.keyValue("Input", JSON.stringify(input));
        console.log();
      }

      const wasmPath = join(geneDir, "gene.ir.wasm");
      const sourcePath = join(geneDir, "index.ts");

      if (existsSync(wasmPath) && options.sandbox) {
        display.info("Running via WASM sandbox...");
        try {
          const { tryLoadBinding } = await import("../utils/binding.js");
          const binding = tryLoadBinding();
          if (binding) {
            const wasmBytes = readFileSync(wasmPath);
            const phenoJson = readFileSync(join(geneDir, "phenotype.json"), "utf-8");
            const execResult = binding.executeGene(wasmBytes, JSON.stringify(input), phenoJson);
            console.log();
            if (execResult.success) {
              display.success("Output:");
              console.log(JSON.stringify(execResult.output, null, 2));
            } else {
              display.error("Execution failed: " + (execResult.errorMessage || "unknown"));
            }
            display.info(`Duration: ${execResult.durationMs}ms`);
            return;
          }
        } catch { /* fall through to Node.js */ }
        display.warn("WASM sandbox unavailable, falling back to Node.js");
      }

      if (existsSync(sourcePath)) {
        display.info("Running via Node.js...");
        try {
          const mod = await import(sourcePath);
          const fn = mod.express || mod.default || mod.main;
          if (typeof fn !== "function") {
            display.error("No exported express/default/main function found in index.ts");
            process.exit(1);
            return;
          }
          const output = await fn(input);
          console.log();
          display.success("Output:");
          console.log(JSON.stringify(output, null, 2));
        } catch (err: any) {
          display.error("Execution failed: " + err.message);
          if (options.verbose && err.stack) {
            console.error(err.stack);
          }
          process.exit(1);
        }
      } else {
        display.error("No runnable source found (need gene.ir.wasm or index.ts)");
        display.info("Compile first: rotifer compile " + name);
        process.exit(1);
      }
    }
  );
