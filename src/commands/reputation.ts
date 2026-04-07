import { Command } from "commander";
import * as display from "../utils/display.js";
import { scoreColor, c } from "../utils/palette.js";
import { getGeneReputation, getDeveloperReputation, getReputationLeaderboard } from "../cloud/client.js";
import { loadCredentials } from "../cloud/auth.js";

export const reputationCommand = new Command("reputation")
  .description("View gene and creator reputation scores")
  .argument("[gene-ref]", "gene UUID, name, or content hash")
  .option("--mine", "show your creator reputation", false)
  .option("--leaderboard", "show creator leaderboard", false)
  .option("--top <n>", "number of entries in leaderboard", "10")
  .action(
    async (
      geneRef: string | undefined,
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

      if (geneRef) {
        await showGeneReputation(geneRef);
        return;
      }

      display.error("Specify a gene reference, --mine, or --leaderboard");
      display.hint("Usage: rotifer reputation <gene-ref>");
      display.hint("       rotifer reputation --mine");
      display.hint("       rotifer reputation --leaderboard");
      process.exit(1);
    }
  );

async function showGeneReputation(geneRef: string): Promise<void> {
  const s = display.spinner("Fetching gene reputation...");
  try {
    const rep = await getGeneReputation(geneRef);
    s.stop();

    display.renderResult(rep, (data) => {
      display.header("Gene Reputation");

      console.log();
      display.kv("Gene", data.gene_name);
      display.kv("Overall Score", scoreColor(data.score));
      console.log();

      display.barChart([
        { label: "Arena Score", value: Math.round(data.arena_score * 100) },
        { label: "Usage Score", value: Math.round(data.usage_score * 100) },
        { label: "Stability  ", value: Math.round(data.stability_score * 100) },
      ]);
      console.log();

      display.kv("Epoch", String(data.epoch));
      display.kv("Computed", data.computed_at);
      display.hint("Weights vary by ecosystem phase: W0 0.70/0.05/0.25, W1 0.60/0.20/0.20, W2 0.50/0.30/0.20");
    });
  } catch (err: unknown) {
    s.stop();
    const msg = err instanceof Error ? err.message : "Failed to fetch reputation";
    display.error(msg);
    display.hint("Check your network connection, or run 'rotifer search' to find genes.");
    process.exit(1);
  }
}

async function showMyReputation(): Promise<void> {
  const creds = loadCredentials();
  if (!creds) {
    display.error("Not logged in. Run 'rotifer login' first.");
    process.exit(1);
    return;
  }

  const s = display.spinner("Fetching creator reputation...");
  try {
    const rep = await getDeveloperReputation(creds.user.id);
    s.stop();

    display.renderResult(
      { username: creds.user.username, ...rep },
      (data) => {
        display.header("My Creator Reputation");

        console.log();
        display.kv("Creator", `@${data.username}`);
        display.kv("Overall Score", scoreColor(data.score));
        console.log();
        display.kv("Genes Published", String(data.genes_published));
        display.kv("Total Downloads", String(data.total_downloads));
        display.kv("Arena Wins", String(data.arena_wins));
        display.kv("Community Bonus", `+${data.community_bonus.toFixed(3)}`);
        console.log();
        display.hint("Score = (Σ positive gene reputations × ln(1+n)/n) + community bonus");
      }
    );
  } catch (err: unknown) {
    s.stop();
    const msg = err instanceof Error ? err.message : "Failed to fetch reputation";
    display.error(msg);
    display.hint("Check your network connection and try again.");
    process.exit(1);
  }
}

async function showLeaderboard(limit: number): Promise<void> {
  const s = display.spinner("Fetching leaderboard...");
  try {
    const entries = await getReputationLeaderboard(limit);
    s.stop();

    if (entries.length === 0) {
      display.renderResult({ entries: [] }, () => {
        display.header("Reputation Leaderboard");
        display.warn("No creators with reputation scores yet");
      });
      return;
    }

    display.renderResult(
      { entries: entries.map((e, i) => ({ rank: i + 1, ...e })) },
      (data) => {
        display.header("Reputation Leaderboard", { separator: false });
        display.table(data.entries as unknown as Record<string, unknown>[], [
          { key: "rank", label: "#", width: 4, format: (v) => String(v) },
          { key: "username", label: "Creator", width: 20,
            format: (v) => `@${v}` },
          { key: "score", label: "Score", width: 12,
            format: (v) => scoreColor(v as number) },
          { key: "genes_published", label: "Genes", width: 8,
            format: (v) => String(v) },
          { key: "total_downloads", label: "Downloads", width: 10,
            format: (v) => String(v) },
          { key: "arena_wins", label: "Wins", width: 6,
            format: (v) => String(v) },
        ]);
        console.log();
        display.hint(`Showing top ${data.entries.length} creators`);
      }
    );
  } catch (err: unknown) {
    s.stop();
    const msg = err instanceof Error ? err.message : "Failed to fetch leaderboard";
    display.error(msg);
    display.hint("Check your network connection and try again.");
    process.exit(1);
  }
}
