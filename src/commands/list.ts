import { Command } from "commander";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";

interface LocalGene {
  name: string;
  domain: string;
  version: string;
  fidelity: string;
  hasWasm: boolean;
  hasCloud: boolean;
  tier: "exec" | "schema" | "stub" | "";
}

function detectTier(geneDir: string, fidelity: string): LocalGene["tier"] {
  if (fidelity === "Native" || fidelity === "Hybrid") return "";

  const entryFile = ["index.ts", "index.js", "index.mjs"].find((f) => existsSync(join(geneDir, f)));
  if (entryFile) {
    try {
      const src = readFileSync(join(geneDir, entryFile), "utf-8");
      if (/export\s+(async\s+)?function\s+express\b/.test(src)) return "exec";
    } catch { /* best-effort */ }
  }

  try {
    const pheno = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
    const props = pheno.inputSchema?.properties;
    if (props && Object.keys(props).length >= 2) return "schema";
  } catch { /* stub */ }

  return "stub";
}

function formatFidelity(row: LocalGene): string {
  const { fidelity, tier } = row;
  if (fidelity === "Native") return c.success(fidelity);
  if (fidelity === "Hybrid") return c.brand(fidelity);
  if (tier === "exec") return c.muted("Wrapped") + c.success("+");
  if (tier === "stub") return c.dim("Wrapped" + "-");
  return c.muted("Wrapped");
}

function collectGenes(genesDir: string, options: { domain?: string; fidelity?: string }): LocalGene[] {
  let entries: string[];
  try {
    entries = readdirSync(genesDir).filter((name) => {
      const p = join(genesDir, name);
      return statSync(p).isDirectory() && existsSync(join(p, "phenotype.json"));
    });
  } catch {
    return [];
  }

  let genes: LocalGene[] = entries.map((name) => {
    const geneDir = join(genesDir, name);
    let phenotype: Record<string, unknown> = {};
    let cloud: Record<string, unknown> | null = null;

    try {
      phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
    } catch { /* empty */ }

    try {
      cloud = JSON.parse(readFileSync(join(geneDir, ".cloud-manifest.json"), "utf-8"));
    } catch { /* empty */ }

    const fidelity = (phenotype.fidelity as string) || "Unknown";
    return {
      name,
      domain: (phenotype.domain as string) || "unknown",
      version: (phenotype.version as string) || (cloud?.version as string) || "—",
      fidelity,
      hasWasm: existsSync(join(geneDir, "gene.ir.wasm")),
      hasCloud: cloud != null,
      tier: detectTier(geneDir, fidelity),
    };
  });

  if (options.domain) {
    genes = genes.filter((g) => g.domain === options.domain || g.domain.startsWith(options.domain + "."));
  }
  if (options.fidelity) {
    genes = genes.filter((g) => g.fidelity === options.fidelity);
  }

  genes.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
  return genes;
}

function formatStatus(row: LocalGene): string {
  const parts = [
    row.hasWasm ? c.success("WASM") : "",
    row.hasCloud ? c.accent("Cloud") : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : c.muted("local");
}

export const listCommand = new Command("list")
  .description("List local genes in the current Agent workspace")
  .option("-d, --domain <domain>", "filter by domain")
  .option("--fidelity <type>", "filter by fidelity")
  .option("--top <n>", "show only top N entries")
  .action(
    (options: { domain?: string; fidelity?: string; top?: string }) => {
      let root: string;
      try {
        root = getProjectRoot();
      } catch {
        display.error("Not in a Rotifer Agent workspace. Run 'rotifer init' first.");
        process.exit(1);
        return;
      }

      const config = loadConfig(root);
      const genesDir = join(root, config.genes_dir);

      if (!existsSync(genesDir)) {
        display.renderResult({ genes: [], genesDir }, () => {
          display.box(
            [
              "No genes directory found",
              "",
              c.muted("Get started:"),
              `  ${c.accent("rotifer init")}               ${c.muted("initialize Agent workspace")}`,
              `  ${c.accent("rotifer wrap <gene-name>")}    ${c.muted("create your first gene")}`,
            ],
            { title: "Local Gene Inventory" },
          );
        });
        return;
      }

      const genes = collectGenes(genesDir, options);
      const topN = options.top ? parseInt(options.top, 10) : undefined;

      if (genes.length === 0) {
        display.renderResult({ genes: [], genesDir }, () => {
          display.box(
            [
              "No genes found",
              "",
              c.muted("Create one:"),
              `  ${c.accent("rotifer wrap <gene-name> --domain <domain>")}`,
            ],
            { title: "Local Gene Inventory" },
          );
        });
        return;
      }

      const totalCount = genes.length;
      const displayGenes = topN ? genes.slice(0, topN) : genes;

      display.renderResult({ genes: displayGenes.map((g, i) => ({ ...g, _idx: i + 1 })), total: totalCount, genesDir }, (data) => {
        display.header("Local Gene Inventory", { separator: false });
        display.table(data.genes as unknown as Record<string, unknown>[], [
          { key: "_idx", label: "#", width: 4, align: "right" },
          { key: "name", label: "Name", width: 22 },
          { key: "domain", label: "Domain", width: 16 },
          { key: "version", label: "Version", width: 10 },
          { key: "fidelity", label: "Fidelity", width: 12,
            format: (_v, row) => formatFidelity(row as unknown as LocalGene) },
          { key: "_idx", label: "Status",
            format: (_v, row) => formatStatus(row as unknown as LocalGene) },
        ]);
        console.log();
        console.log(`  ${c.muted("Fidelity legend:")}`);
        console.log(
          `    ${c.success("Native")}${c.muted(" = compiled WASM")}  `
          + `${c.brand("Hybrid")}${c.muted(" = executable + network")}`
        );
        console.log(
          `    ${c.muted("Wrapped")}${c.success("+")}${c.muted(" = executable")}  `
          + `${c.muted("Wrapped = schema-only")}  `
          + `${c.dim("Wrapped-")}${c.muted(" = stub")}`
        );
        const showing = topN && topN < data.total
          ? `Showing ${data.genes.length} of ${data.total}`
          : `${data.total}`;
        display.hint(`${showing} gene(s) in ${data.genesDir}`);
      });
    }
  );
