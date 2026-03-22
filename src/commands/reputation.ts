import { Command } from "commander";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { getGeneReputation, getDeveloperReputation, getReputationLeaderboard } from "../cloud/client.js";
import { loadCredentials } from "../cloud/auth.js";

export const reputationCommand = new Command("reputation")
  .description("View gene and developer reputation scores")
  .argument("[gene-id]", "gene ID to view reputation for")
  .option("--mine", "show your developer reputation", false)
  .option("--leaderboard", "show developer leaderboard", false)
  .option("--top <n>", "number of entries in leaderboard", "10")
  .action(
    async (
      geneId: string | undefined,
      options: { mine: boolean; leaderboard: boolean; top: string }
    ) => {
      if (options.leaderboard) {
        await showLeaderboard(parseInt(options.top, 10));
        return;
      }

      if (options.mine) {
        await showMyReputation();
        return;
      }

      if (geneId) {
        await showGeneReputation(geneId);
        return;
      }

      display.error("Specify a gene ID, --mine, or --leaderboard");
      display.info("Usage: rotifer reputation <gene-id>");
      display.info("       rotifer reputation --mine");
      display.info("       rotifer reputation --leaderboard");
      process.exit(1);
    }
  );

async function showGeneReputation(geneId: string): Promise<void> {
  display.header("Gene Reputation");

  try {
    const rep = await getGeneReputation(geneId);

    console.log();
    display.keyValue("Gene", rep.gene_name);
    display.keyValue("Overall Score", formatScore(rep.score));
    console.log();

    const barWidth = 30;
    console.log("  " + chalk.dim("Arena Score   ") + renderBar(rep.arena_score, barWidth) + " " + rep.arena_score.toFixed(4));
    console.log("  " + chalk.dim("Usage Score   ") + renderBar(rep.usage_score, barWidth) + " " + rep.usage_score.toFixed(4));
    console.log("  " + chalk.dim("Stability     ") + renderBar(rep.stability_score, barWidth) + " " + rep.stability_score.toFixed(4));
    console.log();

    display.keyValue("Epoch", String(rep.epoch));
    display.keyValue("Computed", rep.computed_at);
    display.info("Weights: Arena(0.5) + Usage(0.3) + Stability(0.2)");
  } catch (err: any) {
    display.error(err.message || "Failed to fetch reputation");
    process.exit(1);
  }
}

async function showMyReputation(): Promise<void> {
  display.header("My Developer Reputation");

  const creds = loadCredentials();
  if (!creds) {
    display.error("Not logged in. Run 'rotifer login' first.");
    process.exit(1);
  }

  try {
    const rep = await getDeveloperReputation(creds.user.id);

    console.log();
    display.keyValue("Developer", `@${creds.user.username}`);
    display.keyValue("Overall Score", formatScore(rep.score));
    console.log();
    display.keyValue("Genes Published", String(rep.genes_published));
    display.keyValue("Total Downloads", String(rep.total_downloads));
    display.keyValue("Arena Wins", String(rep.arena_wins));
    display.keyValue("Community Bonus", `+${rep.community_bonus.toFixed(3)}`);
    console.log();
    display.info("Score = avg(gene reputations) + community bonus");
  } catch (err: any) {
    display.error(err.message || "Failed to fetch reputation");
    process.exit(1);
  }
}

async function showLeaderboard(limit: number): Promise<void> {
  display.header("Reputation Leaderboard");

  try {
    const entries = await getReputationLeaderboard(limit);

    if (entries.length === 0) {
      display.warn("No developers with reputation scores yet");
      return;
    }

    console.log();
    const col = { rank: 4, name: 20, score: 10, genes: 8, dl: 10, wins: 6 };
    console.log(
      "  " +
        padRight("#", col.rank) +
        padRight("Developer", col.name) +
        padRight("Score", col.score) +
        padRight("Genes", col.genes) +
        padRight("Downloads", col.dl) +
        "Wins"
    );
    console.log("  " + "\u2500".repeat(58));

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const rankStr = String(i + 1);
      const scoreColor = e.score >= 0.7 ? chalk.green : e.score >= 0.3 ? chalk.yellow : chalk.dim;
      console.log(
        "  " +
          padRight(rankStr, col.rank) +
          padRight(`@${e.username}`, col.name) +
          padRight(scoreColor(e.score.toFixed(4)), col.score + 10) +
          padRight(String(e.genes_published), col.genes) +
          padRight(String(e.total_downloads), col.dl) +
          String(e.arena_wins)
      );
    }
    console.log();
    display.info(`Showing top ${entries.length} developers`);
  } catch (err: any) {
    display.error(err.message || "Failed to fetch leaderboard");
    process.exit(1);
  }
}

function formatScore(score: number): string {
  if (score >= 0.8) return chalk.green(score.toFixed(4));
  if (score >= 0.5) return chalk.yellow(score.toFixed(4));
  return chalk.dim(score.toFixed(4));
}

function renderBar(value: number, width: number): string {
  const filled = Math.round(value * width);
  const empty = width - filled;
  return chalk.green("█".repeat(filled)) + chalk.dim("░".repeat(empty));
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
