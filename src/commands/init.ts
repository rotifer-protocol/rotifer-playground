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
import * as display from "../utils/display.js";
import { fidelityColor } from "../utils/palette.js";
import { type RotiferConfig, saveConfig } from "../utils/config.js";

const GENESIS_GENES = [
  "genesis-web-search",
  "genesis-web-search-lite",
  "genesis-file-read",
  "genesis-code-format",
  "genesis-l0-constraint",
];

export const initCommand = new Command("init")
  .description("Initialize a new Rotifer Agent workspace")
  .argument("[workspace-name]", "Agent workspace directory name", "my-agent")
  .option("--domain <domain>", "default gene domain", "general")
  .option("--fidelity <level>", "example gene fidelity: Wrapped | Hybrid | Native", "Wrapped")
  .option("--no-genesis", "skip genesis genes installation")
  .action(async (geneName: string, options: { domain: string; fidelity: string; genesis: boolean }) => {
    if (/\.\.[\\/]|[\\/]\.\.|^\.\.$/.test(geneName)) {
      display.error("Agent workspace name must not contain path traversal sequences: " + geneName);
      process.exit(1);
    }

    if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(options.domain)) {
      display.error(
        `Invalid domain format: "${options.domain}". Use lowercase letters, digits, and dots only (e.g., "nlp", "code.analysis").`
      );
      process.exit(1);
    }

    const projectDir = resolve(process.cwd(), geneName);

    if (existsSync(projectDir)) {
      display.error("Directory already exists: " + geneName);
      display.hint("Choose a different name, or delete the existing directory first.");
      process.exit(1);
    }

    display.header("Rotifer Protocol - Agent Workspace Initialization");

    mkdirSync(join(projectDir, "genes"), { recursive: true });
    mkdirSync(join(projectDir, "tests"), { recursive: true });
    mkdirSync(join(projectDir, ".rotifer", "agents"), { recursive: true });

    const config: RotiferConfig = {
      name: geneName,
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
        '// Native (Javy/QuickJS) WASM Genes need a synchronous express() — see issue #57.',
        '// For async I/O, use a Hybrid Gene or run via Node (--no-sandbox).',
        'export function express(input: { name: string }): { greeting: string } {',
        '  return { greeting: "Hello, " + input.name + "! Welcome to Rotifer Protocol." };',
        "}",
        "",
      ].join("\n")
    );

    writeFileSync(
      join(projectDir, ".gitignore"),
      ".rotifer/\nnode_modules/\ndist/\n*.wasm\n"
    );

    display.success("Agent workspace scaffolding created");

    // Install genesis genes
    if (options.genesis) {
      display.info("Installing Genesis genes...");
      const genesisSourceDir = resolveGenesisDir();
      let installedCount = 0;

      for (const genesisGene of GENESIS_GENES) {
        const srcDir = join(genesisSourceDir, genesisGene);
        const destDir = join(projectDir, "genes", genesisGene);

        if (existsSync(srcDir)) {
          copyDirRecursive(srcDir, destDir);
          installedCount++;
        }
      }
      display.success(`${installedCount} Genesis genes installed`);
    }

    console.log();

    showStarterGenes(projectDir);

    const cliPkg = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"),
    );

    display.welcomeBanner({
      version: cliPkg.version,
      message: `Agent workspace "${geneName}" is ready!`,
      hints: [
        ["cd " + geneName, "Enter Agent workspace"],
        ["rotifer hello --template quality-advisor", "Run the recommended preset Agent"],
        ["rotifer wrap hello-world", "Create your first gene"],
        ["rotifer test hello-world", "Test in sandbox"],
        ["rotifer publish", "Share to Rotifer Cloud"],
      ],
    });
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

interface StarterGeneRow {
  name: string;
  domain: string;
  fidelity: string;
}

function showStarterGenes(projectDir: string): void {
  const genesDir = join(projectDir, "genes");
  if (!existsSync(genesDir)) return;

  const rows: StarterGeneRow[] = [];

  for (const name of readdirSync(genesDir)) {
    const phenotypePath = join(genesDir, name, "phenotype.json");
    if (!existsSync(phenotypePath)) continue;

    try {
      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
      rows.push({
        name,
        domain: phenotype.domain || "general",
        fidelity: phenotype.fidelity || "Wrapped",
      });
    } catch {
      // skip malformed phenotypes
    }
  }

  rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));

  if (rows.length === 0) return;

  display.header("Starter Genes");

  display.table(rows as unknown as Record<string, unknown>[], [
    { key: "name", label: "Name", width: 28 },
    { key: "domain", label: "Domain", width: 14 },
    { key: "fidelity", label: "Fidelity", width: 10,
      format: (v) => fidelityColor(String(v)) },
  ]);

  const domains = new Set(rows.map((r) => r.domain));
  display.hint(
    `${rows.length} starter gene(s) across ${domains.size} domain(s)`
  );
}

