import { Command } from "commander";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { arenaRankings } from "../cloud/client.js";

function formatRep(score: number | null | undefined): string {
  if (score == null) return chalk.dim("—");
  if (score >= 0.7) return chalk.green(score.toFixed(2));
  if (score >= 0.3) return chalk.yellow(score.toFixed(2));
  return chalk.dim(score.toFixed(2));
}

interface ArenaEntry {
  rank: number;
  name: string;
  geneId: string;
  domain: string;
  fitness: number;
  safety: number;
  fidelity: string;
  owner?: string;
}

export const arenaListCommand = new Command("list")
  .description("List Arena rankings")
  .option("-d, --domain <domain>", "filter by domain")
  .option("--cloud", "show cloud Arena rankings", false)
  .action(async (options: { domain?: string; cloud: boolean }) => {
    if (options.cloud) {
      await showCloudRankings(options.domain);
      return;
    }

    const root = getProjectRoot();
    const config = loadConfig(root);

    display.header("Local Arena Rankings");

    const genesDir = join(root, config.genes_dir);
    if (!existsSync(genesDir)) {
      display.warn("No genes directory found");
      return;
    }

    const entries: ArenaEntry[] = [];

    for (const name of readdirSync(genesDir)) {
      const phenotypePath = join(genesDir, name, "phenotype.json");
      if (!existsSync(phenotypePath)) continue;

      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));

      if (options.domain && phenotype.domain !== options.domain) continue;

      const phenoStr = JSON.stringify(phenotype);
      const geneId = createHash("sha256").update(phenoStr).digest("hex");

      // Deterministic fitness from content hash
      const seed = parseInt(geneId.slice(0, 8), 16);
      const isNative = phenotype.fidelity === "Native";
      const baseFitness = isNative ? 0.70 : 0.45;
      const variance = (seed % 250) / 1000;
      const fitness = Math.min(baseFitness + variance, 0.99);
      const safety = 0.7 + (seed % 300) / 1000;

      entries.push({
        rank: 0,
        name,
        geneId,
        domain: phenotype.domain || "unknown",
        fitness,
        safety,
        fidelity: phenotype.fidelity || "Wrapped",
      });
    }

    entries.sort((a, b) => b.fitness - a.fitness);
    entries.forEach((e, i) => (e.rank = i + 1));

    if (entries.length === 0) {
      display.warn(
        "No genes in Arena" +
          (options.domain ? ` for domain '${options.domain}'` : "")
      );
      display.info("Submit a gene: rotifer arena submit <gene-name>");
      return;
    }

    console.log();
    const col = { rank: 4, name: 28, domain: 14, fg: 9, vg: 9, fidelity: 10 };
    console.log(
      "  " +
        padRight("#", col.rank) +
        padRight("Name", col.name) +
        padRight("Domain", col.domain) +
        padRight("F(g)", col.fg) +
        padRight("V(g)", col.vg) +
        "Fidelity"
    );
    console.log("  " + "─".repeat(74));

    for (const e of entries) {
      console.log(
        "  " +
          padRight(String(e.rank), col.rank) +
          padRight(e.name, col.name) +
          padRight(e.domain, col.domain) +
          padRight(e.fitness.toFixed(4), col.fg) +
          padRight(e.safety.toFixed(4), col.vg) +
          e.fidelity
      );
    }
    console.log();

    const domains = new Set(entries.map((e) => e.domain));
    display.info(
      `${entries.length} gene(s) across ${domains.size} domain(s) in Arena`
    );
  });

async function showCloudRankings(domain?: string): Promise<void> {
  display.header("Cloud Arena Rankings");

  try {
    const result = await arenaRankings({ domain });

    if (result.rankings.length === 0) {
      display.warn(
        "No genes in cloud Arena" +
          (domain ? ` for domain '${domain}'` : "")
      );
      display.info("Publish and submit: rotifer publish <gene> && rotifer arena submit --cloud <gene>");
      return;
    }

    console.log();
    const col = { rank: 4, name: 20, owner: 14, domain: 14, fg: 9, vg: 9, sr: 7, lat: 7, re: 7, rep: 8, fidelity: 10 };
    console.log(
      "  " +
        padRight("#", col.rank) +
        padRight("Name", col.name) +
        padRight("Owner", col.owner) +
        padRight("Domain", col.domain) +
        padRight("F(g)", col.fg) +
        padRight("V(g)", col.vg) +
        padRight("SR", col.sr) +
        padRight("Lat", col.lat) +
        padRight("RE", col.re) +
        padRight("R(g)", col.rep) +
        "Fidelity"
    );
    console.log("  " + "\u2500".repeat(109));

    for (const e of result.rankings) {
      const fidelityColor = e.fidelity === "Native" ? chalk.green : chalk.dim;
      console.log(
        "  " +
          padRight(String(e.rank), col.rank) +
          padRight(e.gene_name, col.name) +
          padRight(e.owner, col.owner) +
          padRight(e.domain, col.domain) +
          padRight(e.fitness.toFixed(4), col.fg) +
          padRight(e.safety.toFixed(4), col.vg) +
          padRight(e.success_rate?.toFixed(2) ?? "—", col.sr) +
          padRight(e.latency_score?.toFixed(2) ?? "—", col.lat) +
          padRight(e.resource_efficiency?.toFixed(2) ?? "—", col.re) +
          padRight(formatRep(e.reputation_score), col.rep + 10) +
          fidelityColor(e.fidelity)
      );
    }
    console.log();
    display.info(`${result.rankings.length} gene(s) in cloud Arena`);
  } catch (err: any) {
    display.error(err.message || "Failed to fetch cloud rankings");
    process.exit(1);
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
