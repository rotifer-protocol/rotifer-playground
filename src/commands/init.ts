import { Command } from "commander";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as display from "../utils/display.js";
import { type RotiferConfig, saveConfig } from "../utils/config.js";

const GENESIS_GENES = [
  "genesis-web-search",
  "genesis-web-search-lite",
  "genesis-file-read",
  "genesis-code-format",
  "genesis-l0-constraint",
];

export const initCommand = new Command("init")
  .description("Initialize a new Rotifer gene project")
  .argument("[name]", "project name", "my-rotifer-project")
  .option("--domain <domain>", "default gene domain", "general")
  .option("--fidelity <level>", "example gene fidelity: Wrapped | Hybrid | Native", "Wrapped")
  .option("--no-genesis", "skip genesis genes installation")
  .action(async (name: string, options: { domain: string; fidelity: string; genesis: boolean }) => {
    const projectDir = resolve(process.cwd(), name);

    if (existsSync(projectDir)) {
      display.error("Directory already exists: " + name);
      process.exit(1);
    }

    display.header("Rotifer Protocol - Project Initialization");

    mkdirSync(join(projectDir, "genes"), { recursive: true });
    mkdirSync(join(projectDir, "tests"), { recursive: true });
    mkdirSync(join(projectDir, ".rotifer", "agents"), { recursive: true });

    const config: RotiferConfig = {
      name,
      version: "0.1.0",
      author: "local-dev",
      genes_dir: "genes",
      default_domain: options.domain,
    };
    saveConfig(config, projectDir);

    // Example gene: hello-world
    const exampleGeneDir = join(projectDir, "genes", "hello-world");
    mkdirSync(exampleGeneDir, { recursive: true });

    const examplePhenotype: Record<string, unknown> = {
      domain: options.domain,
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      outputSchema: {
        type: "object",
        properties: { greeting: { type: "string" } },
      },
      version: "0.1.0",
      fidelity: options.fidelity,
      transparency: "Open",
    };

    if (options.fidelity === "Hybrid") {
      examplePhenotype.network = {
        allowedDomains: ["api.example.com"],
        maxTimeoutMs: 30000,
        maxResponseBytes: 1048576,
        maxRequestsPerMin: 10,
      };
    }

    writeFileSync(
      join(exampleGeneDir, "phenotype.json"),
      JSON.stringify(examplePhenotype, null, 2) + "\n"
    );

    writeFileSync(
      join(exampleGeneDir, "index.ts"),
      [
        'export async function express(input: { name: string }): Promise<{ greeting: string }> {',
        '  return { greeting: "Hello, " + input.name + "! Welcome to Rotifer Protocol." };',
        "}",
        "",
      ].join("\n")
    );

    writeFileSync(
      join(projectDir, ".gitignore"),
      ".rotifer/\nnode_modules/\ndist/\n*.wasm\n"
    );

    display.success("Project scaffolding created");

    // Install genesis genes
    if (options.genesis) {
      display.info("Installing Genesis genes...");
      const genesisSourceDir = resolveGenesisDir();
      let installedCount = 0;

      for (const geneName of GENESIS_GENES) {
        const srcDir = join(genesisSourceDir, geneName);
        const destDir = join(projectDir, "genes", geneName);

        if (existsSync(srcDir)) {
          copyDirRecursive(srcDir, destDir);
          installedCount++;
        }
      }
      display.success(`${installedCount} Genesis genes installed`);
    }

    console.log();

    // Show Arena rankings — the "Wow" moment
    showArenaRankings(projectDir);

    console.log();
    display.success("Project ready: " + name);
    console.log();
    display.info("Next steps:");
    console.log("  cd " + name);
    console.log("  rotifer scan genes/");
    console.log("  rotifer wrap hello-world --domain " + options.domain);
    console.log("  rotifer arena submit hello-world");
    console.log();
  });

function resolveGenesisDir(): string {
  const candidates = [
    join(__dirname, "..", "..", "genes"),
    join(process.cwd(), "genes"),
    join(__dirname, "..", "genes"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir) && existsSync(join(dir, "genesis-web-search"))) {
      return dir;
    }
  }
  return candidates[0];
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

interface ArenaRow {
  rank: number;
  name: string;
  domain: string;
  fitness: string;
  fidelity: string;
}

function showArenaRankings(projectDir: string): void {
  const genesDir = join(projectDir, "genes");
  if (!existsSync(genesDir)) return;

  const rows: ArenaRow[] = [];

  for (const name of readdirSync(genesDir)) {
    const phenotypePath = join(genesDir, name, "phenotype.json");
    if (!existsSync(phenotypePath)) continue;

    try {
      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
      const phenoStr = JSON.stringify(phenotype);
      const hash = createHash("sha256").update(phenoStr).digest("hex");

      // Deterministic fitness score from content hash — stable across runs
      const seed = parseInt(hash.slice(0, 8), 16);
      const isNative = phenotype.fidelity === "Native";
      const baseFitness = isNative ? 0.70 : 0.45;
      const variance = (seed % 250) / 1000;
      const fitness = Math.min(baseFitness + variance, 0.99);

      rows.push({
        rank: 0,
        name,
        domain: phenotype.domain || "general",
        fitness: fitness.toFixed(2),
        fidelity: phenotype.fidelity || "Wrapped",
      });
    } catch {
      // skip malformed phenotypes
    }
  }

  // Sort by fitness descending, assign ranks
  rows.sort((a, b) => parseFloat(b.fitness) - parseFloat(a.fitness));
  rows.forEach((r, i) => (r.rank = i + 1));

  if (rows.length === 0) return;

  display.header("Arena Rankings");

  const col = { rank: 4, name: 28, domain: 14, fitness: 8, fidelity: 10 };
  const headerLine =
    "  " +
    pad("#", col.rank) +
    pad("Name", col.name) +
    pad("Domain", col.domain) +
    pad("F(g)", col.fitness) +
    "Fidelity";
  console.log(headerLine);
  console.log("  " + "─".repeat(headerLine.length));

  for (const r of rows) {
    const marker = r.fidelity === "Native" ? " " : " ";
    console.log(
      "  " +
        pad(String(r.rank), col.rank) +
        pad(r.name, col.name) +
        pad(r.domain, col.domain) +
        pad(r.fitness, col.fitness) +
        r.fidelity + marker
    );
  }
  console.log();

  const domains = new Set(rows.map((r) => r.domain));
  display.info(
    `${rows.length} genes across ${domains.size} domain(s) — Arena is alive!`
  );
}

function pad(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}
