import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { createAgentCore } from "./agent-create.js";
import { buildGeneExecutor, findAgent, printProtocolInsights } from "./agent-run.js";
import { tryLoadBinding } from "../utils/binding.js";
import { evaluateL0, isExternallySourced } from "../utils/l0-gate.js";
import { createGatewayFetch } from "../runtime/network-gateway.js";
import { diagnoseLocalGene, diagnoseRegistryGene, type GeneDiagnosis } from "../cloud/gene-availability.js";

/**
 * Where a template's genes come from. Decides what the template may promise;
 * tests/unit/hello-template-availability.test.ts and the daily Registry check
 * hold each value to it.
 *
 * - bundled: `init` puts them in every new workspace.
 * - cloud: published with runnable code; `rotifer install` gets them.
 * - unavailable: neither, so the template cannot run until they exist.
 */
export type TemplateAvailability = "bundled" | "cloud" | "unavailable";

export interface HelloTemplate {
  id: string;
  name: string;
  description: string;
  genes: string[];
  fallbackGenes: string[];
  composition: string;
  exampleInput: Record<string, unknown>;
  section: "quick" | "power" | "custom";
  availability: TemplateAvailability;
  badge?: string;
  fileMapping?: Record<string, string>;
  dirMapping?: { mapTo: string };
}

export const TEMPLATES: HelloTemplate[] = [
  {
    id: "quality-advisor",
    name: "Gene Quality Advisor",
    description: "Diagnose & optimize your gene library",
    genes: ["gene-health-scanner"],
    fallbackGenes: ["genesis-web-search", "genesis-web-search-lite"],
    composition: "Seq",
    exampleInput: { verbose: false },
    section: "quick",
    availability: "bundled",
    dirMapping: { mapTo: "genesDir" },
  },
  {
    id: "uiux-diagnosis",
    name: "UI/UX Quality Diagnosis",
    description: "Stop your UI from looking AI-generated",
    genes: ["uiux-analyzer", "uiux-reporter"],
    fallbackGenes: ["genesis-web-search"],
    availability: "unavailable",
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
    availability: "unavailable",
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
    // No fallback: neither code-format nor file-read scans anything, and
    // file-read accepted this template's `path` input, read the directory and
    // returned an EISDIR error that ended as "Execution complete" (#454).
    // Without security-scanner the template says so and stops.
    fallbackGenes: [],
    availability: "unavailable",
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
    availability: "unavailable",
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
    availability: "unavailable",
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
  .option("--json", "write only JSON to stdout: the output, or {ok:false,code,...} on failure; progress goes to stderr", false)
  .option("--list-templates", "list templates and whether each can run in this workspace, then exit")
  .addHelpText(
    "after",
    "\nA template whose genes are missing exits 1 and says, gene by gene, what is possible:\n" +
      "the install command, or that the gene is not available. hello asks Rotifer Cloud\n" +
      "(read-only, 5 s limit) but never downloads or installs anything itself.\n",
  )
  .action(reportingFailures(async (options: HelloOptions) => {
    // The program declares --json too, and takes the flag before this command
    // sees it, so the program-level hook's output mode is the one to read.
    options.json = options.json || display.isJsonMode();

    const root = options.json ? workspaceRootOrFailure() : requireProjectRoot();
    const config = loadConfig(root);
    const genesDir = join(root, config.genes_dir);

    if (options.listTemplates) {
      printTemplateList(genesDir);
      return;
    }

    if (options.json) {
      display.setOutputMode("json");
      // Everything meant for a person, a gene's own logging included, leaves
      // stdout free for the one JSON document a caller parses.
      console.log = console.error;
    }

    display.header("Rotifer Hello");
    display.info("Create and run an agent in seconds\n");

    let selected: HelloTemplate;

    if (options.template) {
      const found = TEMPLATES.find((t) => t.id === options.template);
      if (!found) {
        display.error(`Template '${options.template}' not found`);
        display.hint("Use --list-templates to see available options");
        if (options.json) {
          await exitWithJson({ ok: false, code: "template_not_found", template: options.template });
        }
        process.exit(1);
      }
      selected = found;
    } else if (options.json) {
      throw new HelloFailure("template_required", "--json needs --template <id>: there is no one to answer the picker");
    } else {
      selected = await promptTemplateSelection(genesDir);
    }

    const resolution = resolveAvailableGenes(selected, genesDir);
    const availableGenes = resolution.genome;
    const withoutCode = availableGenes.filter((g) => !hasRunnableCode(join(genesDir, g)));

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
      const genes = await Promise.all(resolution.missingPrimary.map((g) => diagnoseRegistryGene(g)));
      await reportUnavailableGenes(selected, genes, options);
    }

    if (withoutCode.length > 0) {
      display.error(`Template '${selected.id}' cannot run: ${withoutCode.length} of its genes have no runnable code`);
      const genes = withoutCode.map((g) => diagnoseLocalGene(g, readFidelity(join(genesDir, g))));
      await reportUnavailableGenes(selected, genes, options);
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
        throw new HelloFailure("agent_create_failed", `Failed to create agent: ${forOutput(err.message)}`);
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
      if (options.json) {
        await exitWithJson({
          ok: false,
          code: "execution_failed",
          template: selected.id,
          failed_gene: pipeline.failedGene ?? null,
          error: pipeline.error ?? "unknown error",
        });
      }
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
  }));

/** A reason `hello` stops that the person or program calling it can act on. */
class HelloFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HelloFailure";
  }
}

/**
 * Text that came from somewhere else (a gene's error, a Node error) can name
 * paths on this machine. A JSON failure is handed to programs and logs, so it
 * carries the reason without them.
 */
function withoutLocalPaths(text: string): string {
  let out = text;
  for (const known of [process.cwd(), homedir()]) {
    if (known.length > 1) out = out.split(known).join("<path>");
  }
  return out.replace(/(?:file:\/\/)?(?<![\w.:/])(?:[A-Za-z]:\\|\/)[^\s'"`:,)]+[\\/][^\s'"`:,)]*/g, "<path>");
}

function forOutput(text: string): string {
  return display.isJsonMode() ? withoutLocalPaths(text) : text;
}

function workspaceRootOrFailure(): string {
  try {
    return getProjectRoot();
  } catch {
    throw new HelloFailure("not_in_workspace", "Not in a Rotifer Agent workspace. Run 'rotifer init' first.");
  }
}

/**
 * Every way out of `hello` under --json is a document on stdout, including an
 * error nobody planned for; without --json a planned failure prints as it
 * always did.
 */
function reportingFailures(
  action: (options: HelloOptions) => Promise<void>,
): (options: HelloOptions) => Promise<void> {
  return async (options) => {
    try {
      await action(options);
    } catch (err) {
      const isJson = options.json || display.isJsonMode();
      if (err instanceof HelloFailure) {
        display.error(err.message);
        if (isJson) await exitWithJson({ ok: false, code: err.code, error: err.message });
        process.exit(1);
      }
      if (!isJson) throw err;
      const error = withoutLocalPaths(err instanceof Error ? err.message : String(err));
      display.error(error);
      await exitWithJson({ ok: false, code: "internal_error", error });
    }
  };
}

/** Writes a failure document and exits 1, after stdout has taken all of it. */
function exitWithJson(report: Record<string, unknown>): Promise<never> {
  return new Promise(() => {
    process.stdout.write(JSON.stringify(report) + "\n", () => process.exit(1));
  });
}

/**
 * Says gene by gene what can be done about a template that cannot run, then
 * exits 1. Never installs: `hello` does not fetch and run remote code on its
 * own, and an unattended caller gets the same answer with nothing to confirm.
 */
async function reportUnavailableGenes(
  template: HelloTemplate,
  genes: GeneDiagnosis[],
  options: HelloOptions,
): Promise<never> {
  for (const gene of genes) {
    display.hint(`  ${gene.name}: ${gene.detail}`);
  }

  const hasUnchecked = genes.some((g) => g.status === "unknown");
  const isBlocked = genes.some((g) => g.status === "not_published" || g.status === "metadata_only");

  let nextStep: string;
  if (template.availability === "bundled") {
    nextStep = "These genes come with 'rotifer init': create a new workspace with it to get them.";
  } else if (isBlocked) {
    nextStep = "This template cannot run yet. See what can: rotifer hello --list-templates";
  } else if (hasUnchecked) {
    nextStep = "Check your network connection, or retry when Rotifer Cloud is reachable.";
  } else {
    nextStep = `Run the commands above, then: rotifer hello --template ${template.id}`;
  }
  display.hint(nextStep);

  if (options.json) {
    await exitWithJson({ ok: false, code: "genes_unavailable", template: template.id, genes, next_step: nextStep });
  }
  process.exit(1);
}

async function resolveInput(
  template: HelloTemplate,
  options: HelloOptions,
  genesDir: string,
): Promise<Record<string, unknown>> {
  if (options.input) {
    try {
      return JSON.parse(options.input);
    } catch {
      throw new HelloFailure("invalid_input", "Invalid --input JSON: " + options.input);
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
    throw new HelloFailure("input_not_found", `File not found: ${filePath}`);
  }

  let content: string;
  try {
    content = readFileSync(absPath, "utf-8");
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code ?? "read failed";
    throw new HelloFailure("input_unreadable", `Cannot read file: ${filePath} (${reason})`);
  }
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
    throw new HelloFailure("input_not_found", `Directory not found: ${dirPath}`);
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
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
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

  // 这里只想拿 display()，但 import 依然会执行该模块的顶层代码，所以同样过门控。
  const phenotypePath = join(geneDir, "phenotype.json");
  const phenotype = existsSync(phenotypePath)
    ? JSON.parse(readFileSync(phenotypePath, "utf-8"))
    : {};
  const displayL0 = evaluateL0(tryLoadBinding(), phenotype);
  if (displayL0.kind === "violation") return false;
  if (displayL0.kind === "unavailable" && isExternallySourced(geneDir)) return false;

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

function isReadyHere(template: HelloTemplate, genesDir: string): boolean {
  return template.genes.every((g) => {
    const geneDir = join(genesDir, g);
    return existsSync(join(geneDir, "phenotype.json")) && hasRunnableCode(geneDir);
  });
}

function needsGenesReason(template: HelloTemplate): string {
  switch (template.availability) {
    case "bundled":
      return "comes with rotifer init";
    case "cloud":
      return "install from Rotifer Cloud";
    case "unavailable":
      return "not available yet";
  }
}

function printTemplateList(genesDir: string): void {
  display.header("Available Templates");
  console.log();

  const ready = TEMPLATES.filter((t) => isReadyHere(t, genesDir));
  const quickStart = ready.filter((t) => t.section === "quick");
  const power = ready.filter((t) => t.section === "power");
  const needsGenes = TEMPLATES.filter((t) => !ready.includes(t));
  const row = (t: HelloTemplate, suffix: string) =>
    console.log(`  ${c.brand(t.id.padEnd(24))} ${t.description}${suffix}`);

  if (quickStart.length > 0) {
    display.info(c.accent.bold("Quick Start") + c.muted(" (ready to run here)"));
    for (const t of quickStart) row(t, "");
    console.log();
  }

  if (power.length > 0) {
    display.info(c.accent.bold("Power Templates") + c.muted(" (may need API key or domain knowledge)"));
    for (const t of power) row(t, t.badge ? c.warn(` [${t.badge}]`) : "");
    console.log();
  }

  if (needsGenes.length > 0) {
    display.info(c.accent.bold("Needs genes first") + c.muted(" (run one to see exactly what it needs)"));
    for (const t of needsGenes) row(t, c.warn(` [${needsGenesReason(t)}]`));
    console.log();
  }

  display.hint("Usage: rotifer hello --template <id>");
  display.hint("       rotifer hello --template <id> --file <path>");
  display.hint("       cat file.md | rotifer hello --template <id>");
}

async function promptTemplateSelection(genesDir: string): Promise<HelloTemplate> {
  const clack = await import("@clack/prompts");

  const readiness = (t: HelloTemplate) => (isReadyHere(t, genesDir) ? "" : " [needs genes]");

  const quickOptions = TEMPLATES.filter((t) => t.section === "quick").map((t) => ({
    value: t.id,
    label: t.name,
    hint: `${t.description}${readiness(t)}`,
  }));

  const powerOptions = TEMPLATES.filter((t) => t.section === "power").map((t) => ({
    value: t.id,
    label: t.name,
    hint: `${t.description}${t.badge ? ` [${t.badge}]` : ""}${readiness(t)}`,
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

export async function executeGenomePipeline(
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
    const irWasmPath = join(geneDir, "gene.ir.wasm");
    const phenotypePath = join(geneDir, "phenotype.json");
    const phenotype = existsSync(phenotypePath)
      ? JSON.parse(readFileSync(phenotypePath, "utf-8"))
      : {};

    // Nothing to run is a failure. This used to carry the input forward and
    // end in "Execution complete", over output equal to the input.
    if (!srcFile && !existsSync(irWasmPath)) {
      hasFailed = true;
      failedGene = geneName;
      error = `Gene '${geneName}' has no runnable code (declares ${phenotype.fidelity ?? "no fidelity"})`;
      display.error(`${step} ${error}`);
      break;
    }

    // 门控放在 import 之前：import 会执行模块顶层代码，等到 express() 就晚了。
    const binding = tryLoadBinding();
    const l0 = evaluateL0(binding, phenotype);
    const blocked =
      l0.kind === "violation"
        ? l0.detail
        : l0.kind === "unavailable" && isExternallySourced(geneDir)
          ? `could not run (${l0.detail}) on an installed gene`
          : null;
    if (l0.kind === "unavailable" && !blocked) {
      display.warn(`${step} L0 gate could not run (${l0.detail}) — running this local gene unchecked.`);
    }
    if (blocked) {
      display.error(`${step} L0 gate blocked '${geneName}': ${forOutput(blocked)}`);
      hasFailed = true;
      failedGene = geneName;
      error = `L0 gate blocked: ${forOutput(blocked)}`;
      break;
    }

    // An installed Native gene is WASM with no source. It runs the way
    // `agent run` runs it: the same executor, the phenotype's own declarations.
    if (!srcFile) {
      if (!binding) {
        hasFailed = true;
        failedGene = geneName;
        error = `Gene '${geneName}' is compiled WASM, and the native sandbox that runs it did not load on this machine`;
        display.error(`${step} ${error}`);
        break;
      }
      const execute = await buildGeneExecutor(geneName, geneDir, irWasmPath, true, phenotype, binding, binding, false);
      const outcome = await execute(current);
      if (outcome.success) {
        current = outcome.output;
        display.success(`${step} ${geneName} completed`);
      } else {
        hasFailed = true;
        failedGene = geneName;
        error = forOutput(outcome.error ?? "unknown error");
        display.error(`${step} ${geneName} failed: ${error}`);
      }
      continue;
    }

    try {
      const absPath = resolve(geneDir, srcFile);
      const mod = await import(pathToFileURL(absPath).href);

      if (typeof mod.express !== "function") {
        hasFailed = true;
        failedGene = geneName;
        error = `Gene '${geneName}' does not export express()`;
        display.error(`${step} ${error}`);
        break;
      }

      // A Hybrid gene reaches the network only through the gateway on its
      // second argument, as `run`, `test` and `agent run` give it (#444).
      if (phenotype.fidelity === "Hybrid" && phenotype.network) {
        const { gatewayFetch } = createGatewayFetch(phenotype.network);
        current = await mod.express(current, { gatewayFetch });
      } else {
        current = await mod.express(current);
      }
      display.success(`${step} ${geneName} completed`);
    } catch (err: any) {
      error = forOutput(err.message);
      display.error(`${step} ${geneName} failed: ${error}`);
      hasFailed = true;
      failedGene = geneName;
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

function hasRunnableCode(geneDir: string): boolean {
  return findGeneSource(geneDir) !== null || existsSync(join(geneDir, "gene.ir.wasm"));
}

function readFidelity(geneDir: string): string | null {
  try {
    const phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
    return typeof phenotype?.fidelity === "string" ? phenotype.fidelity : null;
  } catch {
    return null;
  }
}
