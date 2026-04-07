import { Command } from "commander";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { fidelityColor, scoreColor2, c } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { arenaRankings } from "../cloud/client.js";
import { contentHash } from "../utils/content-hash.js";

interface ArenaEntry {
  rank: number;
  name: string;
  geneId: string;
  domain: string;
  fitness: number | null;
  safety: number | null;
  fidelity: string;
  method: string | null;
}

interface ArenaCacheFile {
  fitness: number;
  safety: number;
  content_hash: string;
  method: string;
}

function readArenaCache(geneDir: string, currentHash: string): ArenaCacheFile | null {
  const cachePath = join(geneDir, ".arena-cache.json");
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8")) as ArenaCacheFile;
    if (raw.content_hash !== currentHash) return null;
    return raw;
  } catch { return null; }
}

export const arenaListCommand = new Command("list")
  .description("List Arena rankings")
  .option("-d, --domain <domain>", "filter by domain")
  .option("--cloud", "show cloud Arena rankings", false)
  .option("--top <n>", "show only top N entries")
  .action(async (options: { domain?: string; cloud: boolean; top?: string }) => {
    const topN = options.top ? parseInt(options.top, 10) : undefined;

    if (options.cloud) {
      await showCloudRankings(options.domain, topN);
      return;
    }

    const root = requireProjectRoot();
    const config = loadConfig(root);

    const genesDir = join(root, config.genes_dir);
    if (!existsSync(genesDir)) {
      display.renderResult({ entries: [] }, () => {
        display.header("Local Arena Rankings");
        display.warn("No genes directory found");
      });
      return;
    }

    const entries: ArenaEntry[] = [];

    for (const name of readdirSync(genesDir)) {
      const phenotypePath = join(genesDir, name, "phenotype.json");
      if (!existsSync(phenotypePath)) continue;

      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));

      if (options.domain && phenotype.domain !== options.domain) continue;

      const gId = contentHash(phenotype);
      const cached = readArenaCache(join(genesDir, name), gId);

      entries.push({
        rank: 0,
        name,
        geneId: gId,
        domain: phenotype.domain || "unknown",
        fitness: cached?.fitness ?? null,
        safety: cached?.safety ?? null,
        fidelity: phenotype.fidelity || "Wrapped",
        method: cached?.method ?? null,
      });
    }

    entries.sort((a, b) => {
      if (a.fitness != null && b.fitness != null) return b.fitness - a.fitness;
      if (a.fitness != null) return -1;
      if (b.fitness != null) return 1;
      return a.name.localeCompare(b.name);
    });
    entries.forEach((e, i) => (e.rank = i + 1));
    const totalCount = entries.length;
    const displayEntries = topN ? entries.slice(0, topN) : entries;

    if (displayEntries.length === 0) {
      display.renderResult({ entries: [] }, () => {
        display.box(
          [
            "No genes in Arena" + (options.domain ? ` for domain '${options.domain}'` : ""),
            "",
            c.muted("Get started:"),
            `  ${c.accent("rotifer arena submit <gene-name>")}  ${c.muted("submit a gene")}`,
          ],
          { title: "Local Arena Rankings" },
        );
      });
      return;
    }

    const evaluated = entries.filter((e) => e.fitness != null).length;
    display.renderResult({ entries: displayEntries, total: totalCount }, (data) => {
      display.header("Local Arena Rankings", { separator: false });
      display.table(data.entries as unknown as Record<string, unknown>[], [
        { key: "rank", label: "#", width: 4, format: (v) => String(v) },
        { key: "name", label: "Name", width: 28 },
        { key: "domain", label: "Domain", width: 14 },
        { key: "fitness", label: "F(g)", width: 9,
          format: (v) => v != null ? (v as number).toFixed(4) : c.muted("—") },
        { key: "safety", label: "V(g)", width: 9,
          format: (v) => v != null ? (v as number).toFixed(4) : c.muted("—") },
        { key: "fidelity", label: "Fidelity", width: 10, format: (v) => fidelityColor(String(v)) },
      ]);
      console.log();
      const domains = new Set(data.entries.map((e) => e.domain));
      const showing = topN && topN < data.total
        ? `Showing top ${data.entries.length} of ${data.total}`
        : `${data.entries.length} gene(s)`;
      display.hint(`${showing} across ${domains.size} domain(s) — ${evaluated} evaluated`);
      if (evaluated < totalCount) {
        display.hint("Evaluate: rotifer arena submit <gene-name>");
      }
    });
  });

async function showCloudRankings(domain?: string, topN?: number): Promise<void> {
  const s = display.spinner("Fetching cloud Arena rankings...");
  try {
    const result = await arenaRankings({ domain });
    s.stop();

    if (result.rankings.length === 0) {
      display.renderResult({ rankings: [] }, () => {
        display.box(
          [
            "No genes in cloud Arena" + (domain ? ` for domain '${domain}'` : ""),
            "",
            c.muted("Get started:"),
            `  ${c.accent("rotifer publish <gene-name>")}        ${c.muted("publish first")}`,
            `  ${c.accent("rotifer arena submit --cloud <gene-name>")} ${c.muted("then submit")}`,
          ],
          { title: "Cloud Arena Rankings" },
        );
      });
      return;
    }

    const totalRankings = result.rankings.length;
    const displayRankings = topN ? result.rankings.slice(0, topN) : result.rankings;

    display.renderResult(
      { rankings: displayRankings, total: totalRankings },
      (data) => {
        display.header("Cloud Arena Rankings", { separator: false });
        display.table(data.rankings as unknown as Record<string, unknown>[], [
          { key: "rank", label: "#", width: 4, format: (v) => String(v) },
          { key: "gene_name", label: "Name", width: 20 },
          { key: "owner", label: "Creator", width: 14 },
          { key: "domain", label: "Domain", width: 14 },
          { key: "fitness", label: "F(g)", width: 9, format: (v) => (v as number).toFixed(4) },
          { key: "safety", label: "V(g)", width: 9, format: (v) => (v as number).toFixed(4) },
          { key: "success_rate", label: "SR", width: 7, format: (v) => v != null ? (v as number).toFixed(2) : "—" },
          { key: "latency_score", label: "Lat", width: 7, format: (v) => v != null ? (v as number).toFixed(2) : "—" },
          { key: "resource_efficiency", label: "RE", width: 7, format: (v) => v != null ? (v as number).toFixed(2) : "—" },
          { key: "reputation_score", label: "R(g)", width: 10,
            format: (v) => scoreColor2(v as number | null) },
          { key: "fidelity", label: "Fidelity", width: 10, format: (v) => fidelityColor(String(v)) },
        ]);
        console.log();
        const showing = topN && topN < data.total
          ? `Showing top ${data.rankings.length} of ${data.total}`
          : `${data.rankings.length} gene(s)`;
        display.hint(`${showing} in cloud Arena`);
      }
    );
  } catch (err: unknown) {
    s.stop();
    const msg = err instanceof Error ? err.message : "Failed to fetch cloud rankings";
    display.error(msg);
    display.hint("Check your network connection, or run 'rotifer arena submit' to add local genes.");
    process.exit(1);
  }
}
