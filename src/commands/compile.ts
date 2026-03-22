import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { tryLoadBinding } from "../utils/binding.js";
import { toCamelCase } from "../utils/case.js";
import { compileTypeScriptToWasm, findGeneSource } from "../utils/javy-compiler.js";
import { validateLlmNativePhenotype } from "../utils/phenotype-validator.js";

export const compileCommand = new Command("compile")
  .description("Compile a gene to Rotifer IR (WASM + custom sections)")
  .argument("[name]", "gene name to compile")
  .option("--check", "validate only, don't produce artifacts", false)
  .option("--wasm <path>", "path to pre-compiled .wasm file to wrap as IR")
  .option("--lang <ts|wasm>", "force compilation mode (auto-detected by default)")
  .action(async (name: string | undefined, options: { check: boolean; wasm?: string; lang?: string }) => {
    const root = getProjectRoot();
    const config = loadConfig(root);
    const startTime = Date.now();

    display.header("Gene Compiler — Rotifer IR v0.1");

    if (!name) {
      display.error("Specify a gene name: rotifer compile <gene-name>");
      process.exit(1);
    }

    const geneDir = join(root, config.genes_dir, name);
    const phenotypePath = join(geneDir, "phenotype.json");

    if (!existsSync(phenotypePath)) {
      display.rustStyleError({
        code: "E0020",
        message: `Gene '${name}' not found or not wrapped`,
        file: phenotypePath,
        suggestion: "Run 'rotifer wrap " + name + "' first",
      });
      process.exit(1);
    }

    const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));

    display.info("Validating Phenotype...");
    const requiredFields = ["domain", "inputSchema", "outputSchema", "version"];
    for (const field of requiredFields) {
      if (!(field in phenotype)) {
        display.rustStyleError({
          code: "E0021",
          message: `Missing required phenotype field: ${field}`,
          file: phenotypePath,
          suggestion: `Add "${field}" to ${phenotypePath}`,
        });
        process.exit(1);
      }
    }
    display.success("Phenotype validation passed");

    validateLlmNativePhenotype(phenotype, phenotypePath);

    const phenoStr = JSON.stringify(toCamelCase(phenotype));
    const geneId = createHash("sha256").update(phenoStr).digest("hex");

    if (options.check) {
      display.success(`Validation passed for '${name}'`);
      display.keyValue("Gene ID", display.geneId(geneId));
      return;
    }

    let wasmBytes: Buffer | null = null;

    if (options.wasm) {
      if (!existsSync(options.wasm)) {
        display.rustStyleError({
          code: "E0022",
          message: `WASM file not found: ${options.wasm}`,
          suggestion: "Compile your gene source to WASM first (e.g. wasm-pack build)",
        });
        process.exit(1);
      }
      wasmBytes = readFileSync(options.wasm) as Buffer;
      display.info(`Using pre-compiled WASM: ${options.wasm}`);
    } else if (existsSync(join(geneDir, "gene.wasm"))) {
      wasmBytes = readFileSync(join(geneDir, "gene.wasm")) as Buffer;
      display.info("Using existing gene.wasm");
    } else {
      // Auto-detect TypeScript/JavaScript gene source → compile via Javy
      const geneSrc = findGeneSource(geneDir);
      if (geneSrc && (options.lang === "ts" || !options.lang)) {
        display.info("TypeScript gene detected — compiling to Native WASM via Javy");
        console.log();
        const wasmOutput = join(geneDir, "gene.wasm");
        try {
          compileTypeScriptToWasm(geneSrc, wasmOutput);
          wasmBytes = readFileSync(wasmOutput) as Buffer;
        } catch (err: any) {
          display.rustStyleError({
            code: "E0024",
            message: `TypeScript → WASM compilation failed: ${err.message}`,
            suggestion: "Ensure esbuild and javy-cli are installed: npm i -g esbuild && npx javy-cli --version",
          });
          process.exit(1);
        }
        console.log();
      }
    }

    if (!wasmBytes) {
      display.warn("No .wasm or source file found — producing Wrapped fidelity result");
      display.info("To compile to Native fidelity:");
      display.info("  • Write a gene in TypeScript and rotifer will compile it automatically");
      display.info("  • Or provide pre-compiled WASM: rotifer compile " + name + " --wasm path/to/gene.wasm");
      console.log();

      const compileResult = {
        geneId,
        name,
        domain: phenotype.domain,
        compiledAt: new Date().toISOString(),
        fidelity: "Wrapped",
        wasmAvailable: false,
        irHash: null,
        totalSize: 0,
        codeSectionSize: 0,
        durationMs: Date.now() - startTime,
      };

      writeFileSync(
        join(geneDir, ".compile-result.json"),
        JSON.stringify(compileResult, null, 2) + "\n"
      );

      display.success(`Gene '${name}' validated (Wrapped fidelity)`);
      display.keyValue("Gene ID", display.geneId(geneId));
      display.keyValue("Domain", phenotype.domain);
      display.keyValue("Fidelity", "Wrapped");
      return;
    }

    display.info("Compiling to Rotifer IR...");
    display.info(`  Input WASM: ${(wasmBytes.length / 1024).toFixed(1)} KB`);

    const outputPath = join(geneDir, "gene.ir.wasm");

    const binding = tryLoadBinding();

    let irHash: string;
    let totalSize: number;
    let codeSectionSize: number;

    if (binding) {
      display.info("  Engine: Rust IR compiler (napi)");
      try {
        const result = binding.compileGeneToFile(wasmBytes, phenoStr, outputPath);
        irHash = result.irHash;
        totalSize = result.totalSize;
        codeSectionSize = result.codeSectionSize;
      } catch (err: any) {
        display.rustStyleError({
          code: "E0023",
          message: `IR compilation failed: ${err.message}`,
          suggestion: "Ensure the WASM module exports `express(i32,i32)->i32` + `memory`, or `_start` + `memory` (WASI)",
        });
        process.exit(1);
      }
    } else {
      display.warn("Native compiler not available — using TS fallback (no custom sections)");
      display.info("  To enable full IR compilation: npm run build:napi");
      irHash = createHash("sha256")
        .update("rotifer.version:0.1.0")
        .update(phenoStr)
        .update(wasmBytes)
        .digest("hex");
      writeFileSync(outputPath, wasmBytes);
      totalSize = wasmBytes.length;
      codeSectionSize = wasmBytes.length;
    }

    if (phenotype.fidelity !== "Hybrid") {
      phenotype.fidelity = "Native";
    }
    phenotype.ir_hash = irHash;
    writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2) + "\n");

    const durationMs = Date.now() - startTime;

    const compiledFidelity = phenotype.fidelity === "Hybrid" ? "Hybrid" : "Native";

    const compileResult = {
      geneId,
      name,
      domain: phenotype.domain,
      compiledAt: new Date().toISOString(),
      fidelity: compiledFidelity,
      wasmAvailable: true,
      irHash,
      totalSize,
      codeSectionSize,
      durationMs,
    };

    writeFileSync(
      join(geneDir, ".compile-result.json"),
      JSON.stringify(compileResult, null, 2) + "\n"
    );

    console.log();
    display.success(`Gene '${name}' compiled to Rotifer IR`);
    display.keyValue("Gene ID", display.geneId(geneId));
    display.keyValue("Domain", phenotype.domain);
    display.keyValue("Fidelity", compiledFidelity);
    if (phenotype.network) {
      display.keyValue("Network", phenotype.network.allowedDomains?.join(", ") || "(none)");
    }
    display.keyValue("IR Hash", display.geneId(irHash));
    display.keyValue("Output", outputPath);
    display.keyValue("Size", `${(totalSize / 1024).toFixed(1)} KB`);
    if (codeSectionSize !== totalSize) {
      display.keyValue("Code Section", `${(codeSectionSize / 1024).toFixed(1)} KB`);
    }
    display.keyValue("Duration", `${durationMs}ms`);

    if (binding) {
      const verifyResult = binding.verifyIrModule(readFileSync(outputPath) as Buffer);
      if (verifyResult === "PASS") {
        display.success("IR verification: PASS");
      } else if (verifyResult.startsWith("WARN")) {
        display.warn(`IR verification: ${verifyResult}`);
      } else {
        display.error(`IR verification: ${verifyResult}`);
      }
    }

    console.log();
    display.info("Next: rotifer arena submit " + name);
  });
