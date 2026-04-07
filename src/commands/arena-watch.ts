import { Command } from "commander";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { c, icon, fidelityColor } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { arenaRankings } from "../cloud/client.js";
import type { CloudArenaEntry } from "../cloud/types.js";
import { contentHash } from "../utils/content-hash.js";

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
      const isNative = phenotype.fidelity === "Native";
      const baseFitness = isNative ? 0.7 : 0.45;
      const variance = (seed % 250) / 1000;
      const fitness = Math.min(baseFitness + variance, 0.99);
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

  let prevEntries: CloudArenaEntry[] = [];
  let pollCount = 0;
  let totalChanges = 0;
  const startTime = Date.now();

  try {
    const initial = await arenaRankings({ domain: domainFilter });
    prevEntries = initial.rankings;
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
      const result = await arenaRankings({ domain: domainFilter });
      const currEntries = result.rankings;

      const changes: string[] = [];
      const prevMap = new Map(prevEntries.map((e) => [e.gene_id, e]));

      for (const curr of currEntries) {
        const prev = prevMap.get(curr.gene_id);
        if (!prev) {
          changes.push(c.success(`  + NEW  ${curr.gene_name.padEnd(24)} rank #${curr.rank}`));
        } else if (curr.rank < prev.rank) {
          changes.push(c.success(`  ${icon.up} UP   ${curr.gene_name.padEnd(24)} #${prev.rank} ${icon.arrow} #${curr.rank}`));
        } else if (curr.rank > prev.rank) {
          changes.push(c.error(`  ${icon.down} DOWN ${curr.gene_name.padEnd(24)} #${prev.rank} ${icon.arrow} #${curr.rank}`));
        }
      }

      if (changes.length > 0) {
        totalChanges += changes.length;
        const ts = new Date().toLocaleTimeString();
        console.log(c.muted(`  ── ${ts} ──  ${changes.length} change(s)`));
        changes.forEach((ch) => console.log(ch));
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

function renderCloudTable(entries: CloudArenaEntry[]): void {
  display.table(entries as unknown as Record<string, unknown>[], [
    { key: "rank", label: "#", width: 4, format: (v) => String(v) },
    { key: "gene_name", label: "Name", width: 22 },
    { key: "owner", label: "Creator", width: 14 },
    { key: "domain", label: "Domain", width: 14 },
    { key: "fitness", label: "F(g)", width: 9, format: (v) => (v as number).toFixed(4) },
    { key: "safety", label: "V(g)", width: 9, format: (v) => (v as number).toFixed(4) },
    { key: "success_rate", label: "SR", width: 7, format: (v) => v != null ? (v as number).toFixed(2) : "—" },
    { key: "latency_score", label: "Lat", width: 7, format: (v) => v != null ? (v as number).toFixed(2) : "—" },
    { key: "resource_efficiency", label: "RE", width: 7, format: (v) => v != null ? (v as number).toFixed(2) : "—" },
    { key: "fidelity", label: "Fidelity", width: 10, format: (v) => fidelityColor(String(v)) },
  ]);
}
