import { Command } from "commander";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { c, icon, fidelityColor } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { arenaLeaderboard, type LeaderboardRow } from "../cloud/client.js";
import {
  diffLeaderboard,
  fitnessCell,
  rankCell,
  safetyCell,
} from "../utils/leaderboard-watch.js";
import { contentHash } from "../utils/content-hash.js";
import { applyFidelityDiscount, estimateBaseFitness } from "../utils/fidelity-discount.js";

interface RankEntry {
  rank: number;
  name: string;
  geneId: string;
  domain: string;
  fitness: number;
  safety: number;
  fidelity: string;
}

interface RankDiff {
  name: string;
  domain: string;
  type: "new" | "improved" | "dropped" | "eliminated" | "fitness_changed";
  oldRank?: number;
  newRank?: number;
  oldFitness?: number;
  newFitness?: number;
}

function loadRankings(root: string, genesDir: string, domainFilter?: string): RankEntry[] {
  if (!existsSync(genesDir)) return [];

  const entries: RankEntry[] = [];

  for (const name of readdirSync(genesDir)) {
    const phenotypePath = join(genesDir, name, "phenotype.json");
    if (!existsSync(phenotypePath)) continue;

    try {
      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
      if (domainFilter && phenotype.domain !== domainFilter) continue;

      const gId = contentHash(phenotype);

      const seed = parseInt(gId.slice(0, 8), 16);
      const { fitness: discountedFitness } = applyFidelityDiscount(estimateBaseFitness(gId), phenotype.fidelity);
      const fitness = discountedFitness;
      const safety = 0.7 + (seed % 300) / 1000;

      entries.push({
        rank: 0,
        name,
        geneId: gId,
        domain: phenotype.domain || "unknown",
        fitness,
        safety,
        fidelity: phenotype.fidelity || "Wrapped",
      });
    } catch {
      continue;
    }
  }

  entries.sort((a, b) => b.fitness - a.fitness);
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}

function computeDiffs(prev: RankEntry[], curr: RankEntry[]): RankDiff[] {
  const diffs: RankDiff[] = [];
  const prevMap = new Map(prev.map((e) => [e.name, e]));
  const currMap = new Map(curr.map((e) => [e.name, e]));

  for (const [name, entry] of currMap) {
    const old = prevMap.get(name);
    if (!old) {
      diffs.push({ name, domain: entry.domain, type: "new", newRank: entry.rank, newFitness: entry.fitness });
    } else if (entry.rank < old.rank) {
      diffs.push({ name, domain: entry.domain, type: "improved", oldRank: old.rank, newRank: entry.rank });
    } else if (entry.rank > old.rank) {
      diffs.push({ name, domain: entry.domain, type: "dropped", oldRank: old.rank, newRank: entry.rank });
    } else if (Math.abs(entry.fitness - old.fitness) > 0.0001) {
      diffs.push({ name, domain: entry.domain, type: "fitness_changed", oldFitness: old.fitness, newFitness: entry.fitness });
    }
  }

  for (const [name, entry] of prevMap) {
    if (!currMap.has(name)) {
      diffs.push({ name, domain: entry.domain, type: "eliminated", oldRank: entry.rank });
    }
  }

  return diffs;
}

function renderTable(entries: RankEntry[]): void {
  display.table(entries as unknown as Record<string, unknown>[], [
    { key: "rank", label: "#", width: 4, format: (v) => String(v) },
    { key: "name", label: "Name", width: 28 },
    { key: "domain", label: "Domain", width: 14 },
    { key: "fitness", label: "F(g)", width: 9, format: (v) => (v as number).toFixed(4) },
    { key: "safety", label: "V(g)", width: 9, format: (v) => (v as number).toFixed(4) },
    { key: "fidelity", label: "Fidelity", width: 10, format: (v) => fidelityColor(String(v)) },
  ]);
}

function renderDiffs(diffs: RankDiff[]): void {
  for (const d of diffs) {
    const name = d.name.padEnd(24);
    switch (d.type) {
      case "new":
        console.log(c.success(`  + NEW  ${name} rank #${d.newRank}  F(g)=${d.newFitness?.toFixed(4)}`));
        break;
      case "improved":
        console.log(c.success(`  ${icon.up} UP   ${name} #${d.oldRank} ${icon.arrow} #${d.newRank}`));
        break;
      case "dropped":
        console.log(c.error(`  ${icon.down} DOWN ${name} #${d.oldRank} ${icon.arrow} #${d.newRank}`));
        break;
      case "eliminated":
        console.log(c.error(`  ${icon.error} OUT  ${name} was #${d.oldRank}`));
        break;
      case "fitness_changed": {
        const arrow = (d.newFitness ?? 0) > (d.oldFitness ?? 0) ? c.success(icon.up) : c.error(icon.down);
        console.log(c.warn(`  ~ FIT  ${name} ${d.oldFitness?.toFixed(4)} ${arrow} ${d.newFitness?.toFixed(4)}`));
        break;
      }
    }
  }
}

export const arenaWatchCommand = new Command("watch")
  .description("Watch Arena rankings in real-time (live updates)")
  .argument("<domain>", "domain to watch (or 'all' for all domains)")
  .option("--interval <ms>", "refresh interval in milliseconds", "5000")
  .option("--cloud", "watch cloud Arena rankings", false)
  .action(async (domain: string, options: { interval: string; cloud: boolean }) => {
    const intervalMs = parseInt(options.interval, 10);
    const domainFilter = domain === "all" ? undefined : domain;

    if (options.cloud) {
      await watchCloudArena(domainFilter, intervalMs);
      return;
    }

    const root = requireProjectRoot();
    const config = loadConfig(root);
    const genesDir = join(root, config.genes_dir);

    display.header("Arena Watch" + (domainFilter ? ` — ${domainFilter}` : ""));
    display.info(`Refreshing every ${intervalMs}ms — press Ctrl+C to stop`);
    console.log();

    let prev = loadRankings(root, genesDir, domainFilter);
    let pollCount = 0;
    let totalChanges = 0;
    const startTime = Date.now();

    renderTable(prev);
    console.log();

    const timer = setInterval(() => {
      pollCount++;
      const curr = loadRankings(root, genesDir, domainFilter);
      const diffs = computeDiffs(prev, curr);

      if (diffs.length > 0) {
        totalChanges += diffs.length;
        const ts = new Date().toLocaleTimeString();
        console.log(c.muted(`  ── ${ts} ──  ${diffs.length} change(s) detected`));
        renderDiffs(diffs);
        console.log();
      }

      prev = curr;
    }, intervalMs);

    const shutdown = () => {
      clearInterval(timer);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log();
      display.header("Watch Summary");
      display.kv("Duration", `${elapsed}s`);
      display.kv("Polls", String(pollCount));
      display.kv("Total changes", String(totalChanges));
      display.kv("Final gene count", String(prev.length));
      if (prev.length > 0) {
        const domains = new Set(prev.map((e) => e.domain));
        display.kv("Domains", Array.from(domains).join(", "));
        const avgFitness = prev.reduce((sum, e) => sum + e.fitness, 0) / prev.length;
        display.kv("Avg fitness", avgFitness.toFixed(4));
      }
      console.log();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

async function watchCloudArena(domainFilter?: string, intervalMs: number = 5000): Promise<void> {
  display.header("Cloud Arena Watch" + (domainFilter ? ` — ${domainFilter}` : ""));
  display.info(`Polling every ${intervalMs}ms — press Ctrl+C to stop`);
  console.log();

  let prevEntries: LeaderboardRow[] = [];
  let pollCount = 0;
  let totalChanges = 0;
  const startTime = Date.now();

  try {
    // The tiered leaderboard, not a raw select over arena_entries: only the
    // RPC consults invalidated_at and folds versions, so only it can say what
    // the board actually shows (ADR-319 D4). The raw path served invalidated
    // scores here long after the board dropped them.
    prevEntries = await arenaLeaderboard({ domain: domainFilter });
    renderCloudTable(prevEntries);
    console.log();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch cloud rankings";
    display.error(msg);
    display.hint("Check your network connection and try again.");
    process.exit(1);
  }

  const timer = setInterval(async () => {
    pollCount++;
    try {
      const currEntries = await arenaLeaderboard({ domain: domainFilter });

      const lines: string[] = [];
      for (const change of diffLeaderboard(prevEntries, currEntries)) {
        switch (change.kind) {
          case "new":
            lines.push(
              c.success(
                `  + NEW  ${change.row.gene_name.padEnd(24)} ${change.row.tier}` +
                  (change.row.tier_rank != null ? ` #${change.row.tier_rank}` : "")
              )
            );
            break;
          case "tier":
            lines.push(
              c.warn(`  ~ TIER ${change.key.padEnd(24)} ${change.from} ${icon.arrow} ${change.to}`)
            );
            break;
          case "up":
            lines.push(
              c.success(`  ${icon.up} UP   ${change.key.padEnd(24)} #${change.from} ${icon.arrow} #${change.to}`)
            );
            break;
          case "down":
            lines.push(
              c.error(`  ${icon.down} DOWN ${change.key.padEnd(24)} #${change.from} ${icon.arrow} #${change.to}`)
            );
            break;
        }
      }

      if (lines.length > 0) {
        totalChanges += lines.length;
        const ts = new Date().toLocaleTimeString();
        console.log(c.muted(`  ── ${ts} ──  ${lines.length} change(s)`));
        lines.forEach((ln) => console.log(ln));
        console.log();
      }

      prevEntries = currEntries;
    } catch {
      // network error — skip this poll
    }
  }, intervalMs);

  const shutdown = () => {
    clearInterval(timer);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log();
    display.header("Cloud Watch Summary");
    display.kv("Duration", `${elapsed}s`);
    display.kv("Polls", String(pollCount));
    display.kv("Total changes", String(totalChanges));
    display.kv("Final gene count", String(prevEntries.length));
    console.log();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function renderCloudTable(entries: LeaderboardRow[]): void {
  // Cells are precomputed because the score rule needs the whole row: a
  // not_evaluated row shows no number even when the ledger stores one.
  const records = entries.map((r) => ({
    rank: rankCell(r),
    tier: r.tier,
    gene_name: r.gene_name,
    owner: r.owner_username,
    domain: r.domain,
    fitness: fitnessCell(r),
    safety: safetyCell(r),
    fidelity: r.fidelity,
  }));
  display.table(records as unknown as Record<string, unknown>[], [
    { key: "rank", label: "#", width: 4, format: (v) => String(v) },
    { key: "tier", label: "Tier", width: 17 },
    { key: "gene_name", label: "Name", width: 22 },
    { key: "owner", label: "Creator", width: 14 },
    { key: "domain", label: "Domain", width: 14 },
    { key: "fitness", label: "F(g)", width: 9, format: (v) => String(v) },
    { key: "safety", label: "V(g)", width: 9, format: (v) => String(v) },
    { key: "fidelity", label: "Fidelity", width: 10, format: (v) => fidelityColor(String(v)) },
  ]);
}
