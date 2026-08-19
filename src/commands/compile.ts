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

    const { irHash: _strip, ...phenotypeForCompile } = phenotype;
    const geneId = contentHash(phenotypeForCompile);
    const phenoStr = canonicalSerialize(phenotypeForCompile);

    if (options.check) {
      display.success(`Validation passed for '${geneName}'`);
      display.keyValue("Gene ID", c.warn(geneId));
      return;
    }

    // Compile follows the declared fidelity. Only Native goes through Javy to a
    // WASM artifact. A Hybrid gene runs under Node.js with the network gateway
    // injected — that is the path the toolchain chose for Hybrid as its interim,
    // and it is the path `rotifer run`, `rotifer test` and `rotifer agent run`
    // take for it. Forcing a Hybrid gene through Javy refused every one of them
    // (async express() under QuickJS, E0025), while the error's own hint
    // pointed at "a Hybrid Gene" as the way out. The fidelity is left exactly
    // as declared; compile does not promote a tier the author did not claim.
    if (phenotype.fidelity === "Hybrid") {
      display.info("Hybrid gene — runs under Node.js with the network gateway; no WASM artifact is produced");
      if (!phenotype.network?.allowedDomains?.length) {
        display.warn("phenotype.network.allowedDomains is empty — the gateway will refuse every request");
        display.hint("Declare the hosts this gene calls, e.g. \"network\": { \"allowedDomains\": [\"api.example.com\"] }");
      }

      const compileResult = {
        geneId,
        name: geneName,
        domain: phenotype.domain,
        compiledAt: new Date().toISOString(),
        fidelity: "Hybrid",
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

      display.success(`Gene '${geneName}' validated (Hybrid fidelity)`);
      display.keyValue("Gene ID", c.warn(geneId));
      display.keyValue("Domain", phenotype.domain);
      display.keyValue("Fidelity", "Hybrid");
      display.keyValue("Gateway domains", phenotype.network?.allowedDomains?.join(", ") || "(none)");
      console.log();
      display.hint(`Next: rotifer test ${geneName}   (runs through the gateway)`);
      return;
    }

    let wasmBytes: Buffer | null = null;
    const geneSrc = findGeneSource(geneDir);

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
    } else if (geneSrc && options.lang !== "wasm") {
      display.info("TypeScript gene detected — compiling to Native WASM");
      console.log();
      const wasmOutput = join(geneDir, "gene.wasm");
      try {
        compileTypeScriptToWasm(geneSrc, wasmOutput);
        wasmBytes = readFileSync(wasmOutput) as Buffer;
      } catch (err: any) {
        if (err?.name === "AsyncExpressError") {
          display.rustStyleError({
            code: "E0025",
            message: err.message,
            suggestion: "Javy/QuickJS has no event loop. Either export a synchronous express(), or declare \"fidelity\": \"Hybrid\" with network.allowedDomains in phenotype.json — Hybrid genes skip WASM and run under Node.js through the network gateway.",
          });
        } else if (err?.name === "ToolchainError") {
          display.rustStyleError({
            code: "E0024",
            message: err.message,
            suggestion: "Install the toolchain (npm i -g esbuild javy-cli) and re-run; rotifer never downloads tools implicitly.",
          });
        } else {
          display.rustStyleError({
            code: "E0024",
            message: `TypeScript → WASM compilation failed: ${err.message}`,
            suggestion: "Ensure esbuild and javy-cli are installed: npm i -g esbuild javy-cli && npx --no-install esbuild --version",
          });
        }
        process.exit(1);
      }
      console.log();
    } else if (existsSync(join(geneDir, "gene.wasm"))) {
      wasmBytes = readFileSync(join(geneDir, "gene.wasm")) as Buffer;
      display.info("Using existing gene.wasm");
      display.hint("No source file found; using pre-built gene.wasm");
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

    // Reaching here means a WASM artifact was produced, and a gene with an
    // artifact is Native by definition — this is the documented upgrade path
    // from a Wrapped scaffold. Hybrid never reaches this line (returned above).
    // Say so when it actually changes something, so the rewrite is not silent.
    if (phenotype.fidelity !== "Native") {
      display.info(`Fidelity ${phenotype.fidelity || "(undeclared)"} → Native: a compiled WASM artifact now exists`);
      phenotype.fidelity = "Native";
    }
    phenotype.irHash = irHash;
    writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2) + "\n");

    const durationMs = Date.now() - startTime;


    const compileResult = {
      geneId,
      name: geneName,
      domain: phenotype.domain,
      compiledAt: new Date().toISOString(),
      fidelity: "Native",
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
    display.keyValue("Fidelity", "Native");
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
