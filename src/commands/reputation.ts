import { Command } from "commander";
import * as display from "../utils/display.js";
import { scoreColor } from "../utils/palette.js";
import {
  getGene,
  getGeneReputation,
  getDeveloperReputation,
  getProfileByUsername,
  getReputationLeaderboard,
} from "../cloud/client.js";
import { loadCredentials } from "../cloud/auth.js";
import { parseUserRef } from "../cloud/gene-ref.js";

export const reputationCommand = new Command("reputation")
  .description("View gene and creator reputation scores")
  .argument("[ref]", "gene ref (UUID, name, content hash, @owner/name) or @username")
  .option("--mine", "show your creator reputation", false)
  .option("--leaderboard", "show creator leaderboard", false)
  .option("--top <n>", "number of entries in leaderboard", "10")
  .action(
    async (
      ref: string | undefined,
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

      if (ref) {
        const userRef = parseUserRef(ref);
        if (userRef) {
          await showUserReputation(userRef.username);
          return;
        }
        await showGeneReputation(ref);
        return;
      }

      display.error("Specify a gene reference, @username, --mine, or --leaderboard");
      display.hint("Usage: rotifer reputation <gene-ref>          # by UUID, name, or @owner/name");
      display.hint("       rotifer reputation @username            # creator reputation");
      display.hint("       rotifer reputation --mine");
      display.hint("       rotifer reputation --leaderboard");
      process.exit(1);
    }
  );

async function showGeneReputation(geneRef: string): Promise<void> {
  const s = display.spinner("Fetching gene reputation...");
  try {
    // Resolve any user-facing ref (UUID / contentHash / @owner/name / plain
    // name) into the gene UUID first; getGeneReputation expects a UUID and
    // PostgreSQL throws a UUID-parse error otherwise (Issue #50 Bug 3).
    const gene = await getGene(geneRef);
    const rep = await getGeneReputation(gene.id);
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
  await renderCreatorReputation(creds.user.username, creds.user.id, {
    header: "My Creator Reputation",
  });
}

async function showUserReputation(username: string): Promise<void> {
  const s = display.spinner(`Looking up @${username}...`);
  let profile;
  try {
    profile = await getProfileByUsername(username);
  } catch (err: unknown) {
    s.stop();
    const msg = err instanceof Error ? err.message : "Failed to look up user";
    display.error(msg);
    display.hint("Check your network connection and try again.");
    process.exit(1);
    return;
  }
  s.stop();

  if (!profile) {
    display.error(`Creator @${username} not found in Rotifer Cloud.`);
    display.hint("Check the @username spelling, or run 'rotifer reputation --leaderboard' to discover creators.");
    process.exit(1);
    return;
  }

  await renderCreatorReputation(profile.username, profile.id, {
    header: `Creator Reputation: @${profile.username}`,
  });
}

async function renderCreatorReputation(
  username: string,
  userId: string,
  opts: { header: string },
): Promise<void> {
  const s = display.spinner("Fetching creator reputation...");
  try {
    const rep = await getDeveloperReputation(userId);
    s.stop();

    display.renderResult(
      { username, ...rep },
      (data) => {
        display.header(opts.header);

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
