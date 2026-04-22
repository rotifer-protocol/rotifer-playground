import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { createAgentCore } from "./agent-create.js";
import { findAgent, printProtocolInsights } from "./agent-run.js";

interface HelloTemplate {
  id: string;
  name: string;
  description: string;
  genes: string[];
  fallbackGenes: string[];
  composition: string;
  exampleInput: Record<string, unknown>;
  section: "quick" | "power" | "custom";
  badge?: string;
  fileMapping?: Record<string, string>;
  dirMapping?: { mapTo: string };
}

const TEMPLATES: HelloTemplate[] = [
  {
    id: "quality-advisor",
    name: "Gene Quality Advisor",
    description: "Diagnose & optimize your gene library",
    genes: ["gene-health-scanner"],
    fallbackGenes: ["genesis-web-search", "genesis-web-search-lite"],
    composition: "Seq",
    exampleInput: { verbose: false },
    section: "quick",
    dirMapping: { mapTo: "genesDir" },
  },
  {
    id: "uiux-diagnosis",
    name: "UI/UX Quality Diagnosis",
    description: "Stop your UI from looking AI-generated",
    genes: ["uiux-analyzer", "uiux-reporter"],
    fallbackGenes: ["genesis-web-search"],
    composition: "Seq",
    exampleInput: { html: "<html><body><img src='logo.png'><div style='color:red'><div style='font-size:10px'><input type='text'></div></div></body></html>", css: "body { color: white; background: #eee; } .btn { z-index: 999; } .card { z-index: 100; } .modal { z-index: 50; } .nav { z-index: 200; } .popup { z-index: 300; } .overlay { z-index: 400; }" },
    section: "quick",
    fileMapping: { ".html": "html", ".htm": "html", ".css": "css" },
  },
  {
    id: "content-analysis",
    name: "Content Quality Analysis",
    description: "Write articles that actually go viral",
    genes: ["content-quality-analyzer", "content-optimizer"],
    fallbackGenes: ["genesis-web-search"],
    composition: "Seq",
    exampleInput: { text: "# How to Build Your First AI Agent in 5 Minutes\n\nHave you ever wanted to create an AI agent but felt overwhelmed? In this guide, I'll show you exactly how to do it.\n\n## Step 1: Install Rotifer\n\n```bash\nnpm install -g @rotifer/playground\n```\n\n## Step 2: Initialize\n\nRun `rotifer init my-agent` and you're ready to go!\n\nThis amazing framework makes it incredibly easy to get started.", platform: "dev.to" },
    section: "quick",
    fileMapping: { ".md": "text", ".txt": "text", ".html": "text" },
  },
  {
    id: "code-security",
    name: "Code Security Scan",
    description: "Find vulnerabilities before hackers do",
    genes: ["security-scanner"],
    fallbackGenes: ["genesis-code-format", "genesis-file-read"],
    composition: "Seq",
    exampleInput: { path: "./genes", includeTests: false },
    section: "quick",
    dirMapping: { mapTo: "path" },
  },
  {
    id: "doc-qa",
    name: "Smart Document Q&A",
    description: "Ask your docs, get cited answers",
    genes: ["doc-retrieval", "answer-synthesizer"],
    fallbackGenes: ["genesis-file-read", "genesis-web-search"],
    composition: "Seq",
    exampleInput: { question: "What is the Rotifer Protocol?", topK: 3 },
    section: "power",
    badge: "API key",
  },
  {
    id: "web3-toolkit",
    name: "Web3 Creator Toolkit",
    description: "Contract audit + chain data",
    genes: ["solidity-parser", "vuln-detector", "audit-reporter"],
    fallbackGenes: ["genesis-code-format", "genesis-file-read"],
    composition: "Seq",
    exampleInput: { source: "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\n\ncontract SimpleToken {\n    mapping(address => uint256) public balances;\n\n    function deposit() public payable {\n        balances[msg.sender] += msg.value;\n    }\n\n    function withdraw(uint256 amount) public {\n        require(balances[msg.sender] >= amount);\n        (bool success, ) = msg.sender.call{value: amount}(\"\");\n        require(success);\n        balances[msg.sender] -= amount;\n    }\n}" },
    section: "power",
    badge: "Web3",
    fileMapping: { ".sol": "source" },
  },
];

interface HelloOptions {
  template?: string;
  input?: string;
  file?: string;
  dir?: string;
  verbose: boolean;
  json: boolean;
  listTemplates?: boolean;
}

interface PipelineExecutionResult {
  result: unknown;
  failed: boolean;
  failedGene?: string;
  error?: string;
}

interface GenomeResolution {
  genome: string[];
  missingPrimary: string[];
  fallbackAvailable: string[];
  fallbackCompatible: string[];
}

export const helloCommand = new Command("hello")
  .description("Interactive agent builder — create and run an agent in seconds")
  .option("--template <id>", "skip TUI and use a template by ID")
  .option("--input <json>", "provide custom input JSON (skip prompt)")
  .option("--file <path>", "read input from a local file")
  .option("--dir <path>", "scan a directory as input")
  .option("--verbose", "show detailed output (L2)", false)
  .option("--json", "output raw JSON (L3)", false)
  .option("--list-templates", "list available templates and exit")
  .action(async (options: HelloOptions) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);
    const genesDir = join(root, config.genes_dir);

    if (options.listTemplates) {
      printTemplateList();
      return;
    }

    if (options.json) {
      display.setOutputMode("json");
    }

    display.header("Rotifer Hello");
    display.info("Create and run an agent in seconds\n");

    let selected: HelloTemplate;

    if (options.template) {
      const found = TEMPLATES.find((t) => t.id === options.template);
      if (!found) {
        display.error(`Template '${options.template}' not found`);
        display.hint("Use --list-templates to see available options");
        process.exit(1);
      }
      selected = found;
    } else {
      selected = await promptTemplateSelection();
    }

    const resolution = resolveAvailableGenes(selected, genesDir);
    const availableGenes = resolution.genome;

    if (availableGenes.length === 0) {
      display.error("None of the required genes are available in this project");
      if (resolution.missingPrimary.length > 0) {
        display.hint(`Missing primary genes: ${resolution.missingPrimary.join(", ")}`);
      }
      if (
        resolution.fallbackAvailable.length > 0 &&
        resolution.fallbackCompatible.length === 0
      ) {
        display.hint(
          `Fallback genes found but incompatible with template input contract: ${resolution.fallbackAvailable.join(", ")}`
        );
      }
      display.hint("Install/import the required genes, or choose another template");
      process.exit(1);
    }

    const agentName = `hello-${selected.id}`;

    const input = await resolveInput(selected, options, genesDir);
    const shouldShowProtocolInsights = hasMeaningfulHelloInput(input);

    const existing = findAgent(root, agentName);
    if (existing) {
      display.info(`Reusing existing agent '${agentName}'`);
    } else {
      try {
        createAgentCore({
          root,
          genesDir: config.genes_dir,
          agentName,
          genome: availableGenes,
          compositionType: selected.composition,
          strategy: "hello-template",
        });
        display.success(`Agent '${agentName}' created`);
      } catch (err: any) {
        display.error(`Failed to create agent: ${err.message}`);
        process.exit(1);
      }
    }

    const separator = selected.composition === "Par" ? " ∥ " : " → ";
    display.keyValue("Template", selected.name);
    display.keyValue("Genome", availableGenes.join(separator));
    display.keyValue("Composition", selected.composition);
    console.log();

    const startTime = performance.now();
    const pipeline = await executeGenomePipeline(availableGenes, genesDir, input);
    const elapsed = performance.now() - startTime;

    console.log();
    if (pipeline.failed) {
      display.error(
        `Execution failed at ${pipeline.failedGene ?? "unknown gene"}: ${pipeline.error ?? "unknown error"}`
      );
      display.keyValue("Duration", `${elapsed.toFixed(0)}ms`);
      display.hint("Fix the failing gene or input, then re-run this template.");
      process.exit(1);
    }

    display.success("Execution complete");
    display.keyValue("Duration", `${elapsed.toFixed(0)}ms`);
    console.log();

    await renderOutput(pipeline.result, availableGenes, genesDir, options);

    if (shouldShowProtocolInsights) {
      printProtocolInsights(availableGenes, genesDir, elapsed);
    }

    console.log();
    display.hint("Next steps:");
    display.hint("  → Customize your agent:  rotifer agent create my-agent --genes <g1> <g2>");
    display.hint("  → Browse more genes:     rotifer search <keyword>");
    display.hint("  → Compete in Arena:      rotifer arena submit <gene>");
  });

async function resolveInput(
  template: HelloTemplate,
  options: HelloOptions,
  genesDir: string,
): Promise<Record<string, unknown>> {
  if (options.json && options.input) {
    return JSON.parse(options.input);
  }

  if (options.input) {
    try {
      return JSON.parse(options.input);
    } catch {
      display.error("Invalid --input JSON: " + options.input);
      process.exit(1);
    }
  }

  if (options.file) {
    return readFileInput(options.file, template);
  }

  if (options.dir) {
    return readDirInput(options.dir, template);
  }

  // D46: stdin pipe detection
  if (!process.stdin.isTTY) {
    const stdinContent = await readStdin();
    if (stdinContent.trim()) {
      try {
        return JSON.parse(stdinContent);
      } catch {
        return mapStdinToInput(stdinContent, template);
      }
    }
  }

  if (!process.stdin.isTTY) {
    return template.exampleInput;
  }

  return promptInputSelection(template, genesDir);
}

function readFileInput(filePath: string, template: HelloTemplate): Record<string, unknown> {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    display.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  const content = readFileSync(absPath, "utf-8");
  const ext = extname(absPath).toLowerCase();

  if (template.fileMapping && template.fileMapping[ext]) {
    return { [template.fileMapping[ext]]: content };
  }

  try {
    return JSON.parse(content);
  } catch {
    return { text: content };
  }
}

function readDirInput(dirPath: string, template: HelloTemplate): Record<string, unknown> {
  const absPath = resolve(dirPath);
  if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
    display.error(`Directory not found: ${dirPath}`);
    process.exit(1);
  }

  if (template.dirMapping) {
    return { [template.dirMapping.mapTo]: absPath };
  }

  if (template.fileMapping) {
    const result: Record<string, string> = {};
    const extensions = Object.keys(template.fileMapping);

    function walkDir(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (extensions.includes(ext)) {
            const field = template.fileMapping![ext];
            try {
              const content = readFileSync(full, "utf-8");
              result[field] = (result[field] || "") + content + "\n";
            } catch { /* skip unreadable files */ }
          }
        }
      }
    }

    walkDir(absPath);

    if (Object.keys(result).length === 0) {
      display.warn(`No matching files (${extensions.join(", ")}) found in ${dirPath}`);
      display.hint("Try a subdirectory or use --file with a specific file");
    }

    return result;
  }

  return { path: absPath };
}

function mapStdinToInput(content: string, template: HelloTemplate): Record<string, unknown> {
  const inputKeys = Object.keys(template.exampleInput);
  const textField = inputKeys.find((k) =>
    ["text", "html", "css", "source", "code"].includes(k)
  );
  if (textField) {
    return { [textField]: content };
  }
  return { text: content };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function renderOutput(
  result: unknown,
  genome: string[],
  genesDir: string,
  options: HelloOptions,
): Promise<void> {
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const lastGene = genome[genome.length - 1];
  const didRender = await tryGeneDisplay(lastGene, genesDir, result, { verbose: options.verbose });
  if (!didRender) {
    display.info("Output:");
    console.log(JSON.stringify(result, null, 2));
  }
}

async function tryGeneDisplay(
  geneName: string,
  genesDir: string,
  output: unknown,
  options: { verbose: boolean },
): Promise<boolean> {
  const geneDir = join(genesDir, geneName);
  const srcFile = findGeneSource(geneDir);
  if (!srcFile) return false;

  try {
    const absPath = resolve(geneDir, srcFile);
    const mod = await import(pathToFileURL(absPath).href);

    if (typeof mod.display === "function") {
      mod.display(output, options);
      return true;
    }
  } catch {
    // display() not available
  }

  return false;
}

function hasMeaningfulHelloInput(input: unknown): boolean {
  if (input == null) return false;
  if (typeof input === "string") return input.trim().length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (typeof input === "object") return Object.keys(input as Record<string, unknown>).length > 0;
  return true;
}

function printTemplateList(): void {
  display.header("Available Templates");
  console.log();

  const quickStart = TEMPLATES.filter((t) => t.section === "quick");
  const power = TEMPLATES.filter((t) => t.section === "power");

  display.info(c.accent.bold("Quick Start") + c.muted(" (works instantly, no setup)"));
  for (const t of quickStart) {
    console.log(`  ${c.brand(t.id.padEnd(24))} ${t.description}`);
  }
  console.log();

  display.info(c.accent.bold("Power Templates") + c.muted(" (may need API key or domain knowledge)"));
  for (const t of power) {
    const badge = t.badge ? c.warn(` [${t.badge}]`) : "";
    console.log(`  ${c.brand(t.id.padEnd(24))} ${t.description}${badge}`);
  }

  console.log();
  display.hint("Usage: rotifer hello --template <id>");
  display.hint("       rotifer hello --template <id> --file <path>");
  display.hint("       cat file.md | rotifer hello --template content-analysis");
}

async function promptTemplateSelection(): Promise<HelloTemplate> {
  const clack = await import("@clack/prompts");

  const quickOptions = TEMPLATES.filter((t) => t.section === "quick").map((t) => ({
    value: t.id,
    label: t.name,
    hint: t.description,
  }));

  const powerOptions = TEMPLATES.filter((t) => t.section === "power").map((t) => ({
    value: t.id,
    label: t.name,
    hint: `${t.description}${t.badge ? ` [${t.badge}]` : ""}`,
  }));

  const customOption = {
    value: "__custom__",
    label: "Something else (describe it)",
    hint: "We'll guide you to build a custom agent",
  };

  const allOptions = [
    ...quickOptions,
    ...powerOptions,
    customOption,
  ];

  const choice = await clack.select({
    message: "What would you like your Agent to do?",
    options: allOptions,
  });

  if (clack.isCancel(choice)) {
    display.info("Cancelled");
    process.exit(0);
  }

  if (choice === "__custom__") {
    console.log();
    display.info("Custom agent creation is coming soon!");
    display.hint("For now, try these approaches:");
    display.hint("  → Browse genes:   rotifer search <keyword>");
    display.hint("  → Create manually: rotifer agent create my-agent --genes <g1> <g2>");
    display.hint("  → Use Cloud search: rotifer.ai (semantic gene discovery)");
    process.exit(0);
  }

  const selected = TEMPLATES.find((t) => t.id === choice);
  if (!selected) {
    display.error("Template not found");
    process.exit(1);
  }

  return selected;
}

function resolveAvailableGenes(template: HelloTemplate, genesDir: string): GenomeResolution {
  const missingPrimary = template.genes.filter((g) =>
    !existsSync(join(genesDir, g, "phenotype.json"))
  );

  if (missingPrimary.length === 0) {
    return {
      genome: template.genes,
      missingPrimary: [],
      fallbackAvailable: [],
      fallbackCompatible: [],
    };
  }

  const fallbackAvailable = template.fallbackGenes.filter((g) =>
    existsSync(join(genesDir, g, "phenotype.json"))
  );
  const fallbackCompatible = fallbackAvailable.filter((g) =>
    isFallbackCompatibleWithTemplateInput(g, genesDir, template.exampleInput)
  );

  return {
    genome: fallbackCompatible.length > 0 ? [fallbackCompatible[0]] : [],
    missingPrimary,
    fallbackAvailable,
    fallbackCompatible,
  };
}

function isFallbackCompatibleWithTemplateInput(
  geneName: string,
  genesDir: string,
  exampleInput: Record<string, unknown>,
): boolean {
  const phenotypePath = join(genesDir, geneName, "phenotype.json");
  if (!existsSync(phenotypePath)) return false;

  try {
    const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
    const required = Array.isArray(phenotype?.inputSchema?.required)
      ? (phenotype.inputSchema.required as string[])
      : [];
    if (required.length === 0) return true;

    const keys = new Set(Object.keys(exampleInput));
    return required.every((key) => keys.has(key));
  } catch {
    return false;
  }
}

async function promptInputSelection(
  template: HelloTemplate,
  genesDir: string,
): Promise<Record<string, unknown>> {
  const clack = await import("@clack/prompts");

  const inputOptions: Array<{ value: string; label: string; hint?: string }> = [
    {
      value: "example",
      label: "Use example input",
      hint: JSON.stringify(template.exampleInput).slice(0, 60),
    },
  ];

  if (template.fileMapping) {
    const extensions = Object.keys(template.fileMapping).join(", ");
    inputOptions.push({
      value: "file",
      label: "Read from a local file",
      hint: `Supports: ${extensions}`,
    });
  }

  if (template.dirMapping || template.fileMapping) {
    inputOptions.push({
      value: "dir",
      label: "Scan a directory",
    });
  }

  inputOptions.push({
    value: "custom",
    label: "Enter custom JSON input",
  });

  const choice = await clack.select({
    message: "How would you like to provide input?",
    options: inputOptions,
  });

  if (clack.isCancel(choice)) {
    display.info("Cancelled");
    process.exit(0);
  }

  if (choice === "example") {
    return template.exampleInput;
  }

  if (choice === "file") {
    const filePath = await clack.text({
      message: "Enter file path:",
      placeholder: "./my-file" + (template.fileMapping ? ` (${Object.keys(template.fileMapping).join(", ")})` : ""),
      validate(value: string | undefined) {
        if (!value) return "Please enter a file path.";
        const abs = resolve(value);
        if (!existsSync(abs)) return `File not found: ${value}`;
        return undefined;
      },
    });

    if (clack.isCancel(filePath) || filePath === undefined) {
      display.info("Cancelled");
      process.exit(0);
    }

    return readFileInput(filePath, template);
  }

  if (choice === "dir") {
    const dirPath = await clack.text({
      message: "Enter directory path:",
      placeholder: ".",
      validate(value: string | undefined) {
        if (!value) return "Please enter a directory path.";
        const abs = resolve(value);
        if (!existsSync(abs) || !statSync(abs).isDirectory()) return `Not a directory: ${value}`;
        return undefined;
      },
    });

    if (clack.isCancel(dirPath) || dirPath === undefined) {
      display.info("Cancelled");
      process.exit(0);
    }

    return readDirInput(dirPath, template);
  }

  const customInput = await clack.text({
    message: "Enter input JSON:",
    placeholder: JSON.stringify(template.exampleInput),
    validate(value: string | undefined) {
      if (!value) return "Please enter JSON input.";
      try {
        JSON.parse(value);
        return undefined;
      } catch {
        return "Invalid JSON. Please enter valid JSON.";
      }
    },
  });

  if (clack.isCancel(customInput) || customInput === undefined) {
    display.info("Cancelled");
    process.exit(0);
  }

  return JSON.parse(customInput);
}

async function executeGenomePipeline(
  genome: string[],
  genesDir: string,
  input: unknown,
): Promise<PipelineExecutionResult> {
  let current: unknown = input;
  let hasFailed = false;
  let failedGene: string | undefined;
  let error: string | undefined;

  for (let i = 0; i < genome.length; i++) {
    const geneName = genome[i];
    const geneDir = join(genesDir, geneName);
    const step = `[${i + 1}/${genome.length}]`;

    display.info(`${step} Executing gene: ${geneName}`);

    if (hasFailed) {
      display.warn(`${step} Skipping ${geneName} — upstream gene failed`);
      continue;
    }

    const srcFile = findGeneSource(geneDir);
    if (!srcFile) {
      display.warn(`${step} Gene '${geneName}' has no executable source — passing through`);
      continue;
    }

    try {
      const absPath = resolve(geneDir, srcFile);
      const mod = await import(pathToFileURL(absPath).href);

      if (typeof mod.express !== "function") {
        display.warn(`${step} Gene '${geneName}' does not export express() — passing through`);
        continue;
      }

      current = await mod.express(current);
      display.success(`${step} ${geneName} completed`);
    } catch (err: any) {
      display.error(`${step} ${geneName} failed: ${err.message}`);
      hasFailed = true;
      failedGene = geneName;
      error = err.message;
    }
  }

  return { result: current, failed: hasFailed, failedGene, error };
}

function findGeneSource(geneDir: string): string | null {
  for (const candidate of ["index.ts", "index.js", "index.mjs"]) {
    if (existsSync(join(geneDir, candidate))) return candidate;
  }
  return null;
}
