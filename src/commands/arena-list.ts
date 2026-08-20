import { Command } from "commander";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { fidelityColor, c } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { arenaLeaderboard, type LeaderboardRow } from "../cloud/client.js";
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

/** How each tier reads, and what a reader should take from it. */
const TIER_LABEL: Record<string, string> = {
  verified: "Verified",
  under_evaluation: "Under evaluation",
  not_evaluated: "Not evaluated",
};

/** Plain-language reason a gene is not ranked, and what its author can do. */
function explainReason(row: LeaderboardRow): string {
  if (row.invalidation_reason) {
    switch (row.invalidation_reason) {
      case "async-express-artifact":
        return "published artifact returns {} — recompile with a synchronous express() and publish a new version";
      case "no-published-artifact":
        return "declares Native but published no WASM — compile and publish it, or declare the fidelity it really is";
      case "test-data":
        return "submitted under the 'test' domain";
      default:
        return row.invalidation_reason;
    }
  }
  if (row.evaluation_method === "estimated") {
    // Two different things arrive as `estimated`, and telling an author the
    // wrong one wastes their time. A run count means the Gene executed and the
    // fitness formula is what is incomplete (ADR-318 D2/D4) — resubmitting
    // changes nothing. No run count means nothing ever executed.
    if ((row.evaluation_n ?? 0) > 0) {
      return `ran in the sandbox ${row.evaluation_n}× — but F(g) still uses placeholder inputs and a capped denominator, so it does not rank yet (ADR-318 D2)`;
    }
    return "score was estimated, never measured — run: rotifer arena submit --cloud";
  }
  if (row.evaluation_method === "declared") return "score was supplied by the client, not measured";
  if (row.evaluation_method === "unknown-legacy") return "predates provenance tracking — resubmit to record how it was measured";
  return "measured, but not yet called by enough distinct callers";
}

async function showCloudRankings(domain?: string, topN?: number): Promise<void> {
  const s = display.spinner("Fetching cloud Arena rankings...");
  let rows: LeaderboardRow[];
  try {
    rows = await arenaLeaderboard({ domain });
    s.stop();
  } catch (err: unknown) {
    s.stop();
    display.error(err instanceof Error ? err.message : "Failed to fetch cloud rankings");
    display.hint("Check your network connection, or run 'rotifer arena submit' to add local genes.");
    process.exit(1);
    return;
  }

  if (rows.length === 0) {
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

  display.renderResult({ rankings: rows, total: rows.length }, (data) => {
    for (const tier of ["verified", "under_evaluation", "not_evaluated"] as const) {
      const inTier = data.rankings.filter((r) => r.tier === tier);
      if (inTier.length === 0) continue;
      const shown = tier === "not_evaluated" ? inTier : (topN ? inTier.slice(0, topN) : inTier);

      console.log();
      display.header(`${TIER_LABEL[tier]} (${inTier.length})`, { separator: false });

      if (tier === "not_evaluated") {
        // No score column at all. Printing a stored 0.5 next to the words "not
        // evaluated" is how a hash-derived number got read as a measurement in
        // the first place.
        for (const r of shown) {
          console.log(`  ${r.gene_name}@${r.gene_version}  ${c.muted(r.owner_username)}`);
          console.log(`      ${c.muted(explainReason(r))}`);
        }
        continue;
      }

      display.table(shown as unknown as Record<string, unknown>[], [
        { key: "tier_rank", label: "#", width: 4, format: (v) => String(v ?? "—") },
        { key: "gene_name", label: "Name", width: 20 },
        { key: "owner_username", label: "Creator", width: 14 },
        { key: "domain", label: "Domain", width: 14 },
        { key: "fitness_value", label: "F(g)", width: 9,
          format: (v) => v != null ? (v as number).toFixed(4) : c.muted("—") },
        { key: "base_fitness", label: "base", width: 8,
          format: (v) => v != null ? (v as number).toFixed(4) : c.muted("—") },
        { key: "safety_score", label: "V(g)", width: 9,
          format: (v) => v != null ? (v as number).toFixed(4) : c.muted("—") },
        { key: "evaluation_n", label: "n", width: 4, format: (v) => String(v ?? "—") },
        { key: "unique_callers", label: "callers", width: 8, format: (v) => String(v) },
        { key: "fidelity", label: "Fidelity", width: 10, format: (v) => fidelityColor(String(v)) },
      ]);

      if (tier === "under_evaluation") {
        display.hint("Measured, but not yet called by enough distinct callers to rank as verified.");
      }
    }

    console.log();
    display.hint(`${data.total} gene(s) in cloud Arena — one row per gene, newest version that still stands.`);
    display.hint("Criteria behind 'not evaluated': rotifer arena audit");
  });
}
