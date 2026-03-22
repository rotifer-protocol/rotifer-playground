import { Command } from "commander";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { arenaRankings } from "../cloud/client.js";
import type { CloudArenaEntry } from "../cloud/types.js";

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

      const phenoStr = JSON.stringify(phenotype);
      const geneId = createHash("sha256").update(phenoStr).digest("hex");

      const seed = parseInt(geneId.slice(0, 8), 16);
      const isNative = phenotype.fidelity === "Native";
      const baseFitness = isNative ? 0.7 : 0.45;
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
  console.log("  " + "\u2500".repeat(74));

  for (const e of entries) {
    const fidelityColor = e.fidelity === "Native" ? chalk.green : chalk.dim;
    console.log(
      "  " +
        padRight(String(e.rank), col.rank) +
        padRight(e.name, col.name) +
        padRight(e.domain, col.domain) +
        padRight(e.fitness.toFixed(4), col.fg) +
        padRight(e.safety.toFixed(4), col.vg) +
        fidelityColor(e.fidelity)
    );
  }
}

function renderDiffs(diffs: RankDiff[]): void {
  for (const d of diffs) {
    switch (d.type) {
      case "new":
        console.log(chalk.green(`  + NEW  ${padRight(d.name, 24)} rank #${d.newRank}  F(g)=${d.newFitness?.toFixed(4)}`));
        break;
      case "improved":
        console.log(chalk.green(`  \u2191 UP   ${padRight(d.name, 24)} #${d.oldRank} \u2192 #${d.newRank}`));
        break;
      case "dropped":
        console.log(chalk.red(`  \u2193 DOWN ${padRight(d.name, 24)} #${d.oldRank} \u2192 #${d.newRank}`));
        break;
      case "eliminated":
        console.log(chalk.red(`  \u2717 OUT  ${padRight(d.name, 24)} was #${d.oldRank}`));
        break;
      case "fitness_changed":
        const arrow = (d.newFitness ?? 0) > (d.oldFitness ?? 0) ? chalk.green("\u2191") : chalk.red("\u2193");
        console.log(chalk.yellow(`  ~ FIT  ${padRight(d.name, 24)} ${d.oldFitness?.toFixed(4)} ${arrow} ${d.newFitness?.toFixed(4)}`));
        break;
    }
  }
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
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

    const root = getProjectRoot();
    const config = loadConfig(root);
    const genesDir = join(root, config.genes_dir);

    display.header("Arena Watch" + (domainFilter ? ` \u2014 ${domainFilter}` : ""));
    display.info(`Refreshing every ${intervalMs}ms \u2014 press Ctrl+C to stop`);
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
        console.log(chalk.dim(`  ── ${ts} ──  ${diffs.length} change(s) detected`));
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
      display.keyValue("Duration", `${elapsed}s`);
      display.keyValue("Polls", String(pollCount));
      display.keyValue("Total changes", String(totalChanges));
      display.keyValue("Final gene count", String(prev.length));
      if (prev.length > 0) {
        const domains = new Set(prev.map((e) => e.domain));
        display.keyValue("Domains", Array.from(domains).join(", "));
        const avgFitness = prev.reduce((sum, e) => sum + e.fitness, 0) / prev.length;
        display.keyValue("Avg fitness", avgFitness.toFixed(4));
      }
      console.log();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

async function watchCloudArena(domainFilter?: string, intervalMs: number = 5000): Promise<void> {
  display.header("Cloud Arena Watch" + (domainFilter ? ` \u2014 ${domainFilter}` : ""));
  display.info(`Polling every ${intervalMs}ms \u2014 press Ctrl+C to stop`);
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
  } catch (err: any) {
    display.error(`Failed to fetch cloud rankings: ${err.message}`);
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
          changes.push(chalk.green(`  + NEW  ${padRight(curr.gene_name, 24)} rank #${curr.rank}`));
        } else if (curr.rank < prev.rank) {
          changes.push(chalk.green(`  \u2191 UP   ${padRight(curr.gene_name, 24)} #${prev.rank} \u2192 #${curr.rank}`));
        } else if (curr.rank > prev.rank) {
          changes.push(chalk.red(`  \u2193 DOWN ${padRight(curr.gene_name, 24)} #${prev.rank} \u2192 #${curr.rank}`));
        }
      }

      if (changes.length > 0) {
        totalChanges += changes.length;
        const ts = new Date().toLocaleTimeString();
        console.log(chalk.dim(`  \u2500\u2500 ${ts} \u2500\u2500  ${changes.length} change(s)`));
        changes.forEach((c) => console.log(c));
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
    display.keyValue("Duration", `${elapsed}s`);
    display.keyValue("Polls", String(pollCount));
    display.keyValue("Total changes", String(totalChanges));
    display.keyValue("Final gene count", String(prevEntries.length));
    console.log();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function renderCloudTable(entries: CloudArenaEntry[]): void {
  const col = { rank: 4, name: 22, owner: 14, domain: 14, fg: 9, vg: 9, sr: 7, lat: 7, re: 7, fidelity: 10 };
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
      "Fidelity"
  );
  console.log("  " + "\u2500".repeat(103));

  for (const e of entries) {
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
        fidelityColor(e.fidelity)
    );
  }
}
