import { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { tryLoadBinding } from "../utils/binding.js";
import { compileTypeScriptToWasm, findGeneSource } from "../utils/javy-compiler.js";
import { contentHash, canonicalSerialize } from "../utils/content-hash.js";
import { validateLlmNativePhenotype } from "../utils/phenotype-validator.js";
import { validateGeneName } from "../utils/validate-gene-name.js";

export const compileCommand = new Command("compile")
  .description("Compile a gene to Rotifer IR (WASM)")
  .argument("[gene-name]", "gene name to compile")
  .option("--check", "validate only, don't produce artifacts", false)
  .option("--wasm <path>", "path to pre-compiled .wasm file to wrap as IR")
  .option("--lang <ts|wasm>", "force compilation mode (auto-detected by default)")
  .action(async (geneName: string | undefined, options: { check: boolean; wasm?: string; lang?: string }) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);
    const startTime = Date.now();

    display.header("Gene Compiler");

    if (!geneName) {
      display.error("Specify a gene name: rotifer compile <gene-name>");
      display.hint("List local genes: rotifer list");
      process.exit(1);
    }
    validateGeneName(geneName);

    const geneDir = join(root, config.genes_dir, geneName);
    const phenotypePath = join(geneDir, "phenotype.json");

    if (!existsSync(phenotypePath)) {
      display.rustStyleError({
        code: "E0020",
        message: `Gene '${geneName}' not found or not wrapped`,
        file: phenotypePath,
        suggestion: "Run 'rotifer wrap " + geneName + "' first",
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
    if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(phenotype.domain)) {
      display.rustStyleError({
        code: "E0022",
        message: `Invalid domain format: "${phenotype.domain}"`,
        file: phenotypePath,
        suggestion: "Use lowercase letters, digits, and dots only (e.g., \"nlp\", \"code.analysis\")",
      });
      process.exit(1);
    }
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(phenotype.version)) {
      display.rustStyleError({
        code: "E0023",
        message: `Invalid version format: "${phenotype.version}"`,
        file: phenotypePath,
        suggestion: "Use semver format (e.g., \"1.0.0\", \"0.1.0-beta.1\")",
      });
      process.exit(1);
    }
    display.success("Phenotype validation passed");

    validateLlmNativePhenotype(phenotype, phenotypePath);

    const geneId = contentHash(phenotype);
    const phenoStr = canonicalSerialize(phenotype);

    if (options.check) {
      display.success(`Validation passed for '${geneName}'`);
      display.keyValue("Gene ID", c.warn(geneId));
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
        display.info("TypeScript gene detected — compiling to Native WASM");
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
      display.hint("To compile to Native fidelity:");
      display.hint("  • Write a gene in TypeScript and rotifer will compile it automatically");
      display.hint("  • Or provide pre-compiled WASM: rotifer compile " + geneName + " --wasm path/to/gene.wasm");
      console.log();

      const compileResult = {
        geneId,
        name: geneName,
        domain: phenotype.domain,
        compiledAt: new Date().toISOString(),
        fidelity: "Wrapped",
        wasmAvailable: false,
        irHash: null,
        wasmSize: 0,
        codeSectionSize: 0,
        durationMs: Date.now() - startTime,
      };

      writeFileSync(
        join(geneDir, ".compile-result.json"),
        JSON.stringify(compileResult, null, 2) + "\n"
      );

      display.success(`Gene '${geneName}' validated (Wrapped fidelity)`);
      display.keyValue("Gene ID", c.warn(geneId));
      display.keyValue("Domain", phenotype.domain);
      display.keyValue("Fidelity", "Wrapped");
      return;
    }

    display.info("Compiling to Rotifer IR...");
    display.info(`  Input WASM: ${(wasmBytes.length / 1024).toFixed(1)} KB`);

    const outputPath = join(geneDir, "gene.ir.wasm");

    const binding = tryLoadBinding();

    let irHash: string;
    let wasmSize: number;
    let codeSectionSize: number;

    if (binding) {
      display.info("  Engine: native IR compiler");
      try {
        const result = binding.compileGeneToFile(wasmBytes, phenoStr, outputPath);
        irHash = result.irHash;
        wasmSize = result.totalSize;
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
      display.warn("Native compiler not available — using fallback (no custom sections)");
      display.hint("  Run 'rotifer self-update' to check for compiler updates");
      irHash = createHash("sha256")
        .update("rotifer.version:0.1.0")
        .update(phenoStr)
        .update(wasmBytes)
        .digest("hex");
      writeFileSync(outputPath, wasmBytes);
      wasmSize = wasmBytes.length;
      codeSectionSize = wasmBytes.length;
    }

    if (phenotype.fidelity !== "Hybrid") {
      phenotype.fidelity = "Native";
    }
    phenotype.irHash = irHash;
    writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2) + "\n");

    const durationMs = Date.now() - startTime;

    const compiledFidelity = phenotype.fidelity === "Hybrid" ? "Hybrid" : "Native";

    const compileResult = {
      geneId,
      name: geneName,
      domain: phenotype.domain,
      compiledAt: new Date().toISOString(),
      fidelity: compiledFidelity,
      wasmAvailable: true,
      irHash,
      wasmSize,
      codeSectionSize,
      durationMs,
    };

    writeFileSync(
      join(geneDir, ".compile-result.json"),
      JSON.stringify(compileResult, null, 2) + "\n"
    );

    console.log();
    display.success(`Gene '${geneName}' compiled to Rotifer IR`);
    display.keyValue("Gene ID", c.warn(geneId));
    display.keyValue("Domain", phenotype.domain);
    display.keyValue("Fidelity", compiledFidelity);
    if (phenotype.network) {
      display.keyValue("Network", phenotype.network.allowedDomains?.join(", ") || "(none)");
    }
    display.keyValue("IR Hash", c.warn(irHash));
    display.keyValue("Output", outputPath);
    display.keyValue("Size", `${(wasmSize / 1024).toFixed(1)} KB`);
    if (codeSectionSize !== wasmSize) {
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
    display.hint("Next: rotifer arena submit " + geneName);
  });
