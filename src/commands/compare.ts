import { Command } from "commander";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { getGene } from "../cloud/client.js";

export const compareCommand = new Command("compare")
  .description("Compare 2-5 genes by fitness and reputation")
  .argument("<ids...>", "2-5 gene IDs to compare")
  .action(async (ids: string[]) => {
    if (ids.length < 2) {
      display.error("At least 2 gene IDs required for comparison");
      process.exit(1);
      return;
    }
    if (ids.length > 5) {
      display.error("Maximum 5 genes can be compared at once");
      process.exit(1);
      return;
    }

    display.header("Gene Comparison");

    try {
      const genes = await Promise.all(ids.map((id) => getGene(id)));

      console.log();
      const col = { name: 20, domain: 14, fidelity: 10, rep: 10, dl: 8 };
      console.log(
        "  " +
          padRight("Name", col.name) +
          padRight("Domain", col.domain) +
          padRight("Fidelity", col.fidelity) +
          padRight("R(g)", col.rep) +
          "Downloads"
      );
      console.log("  " + "\u2500".repeat(62));

      for (const g of genes) {
        const repStr =
          g.reputation_score != null ? formatScore(g.reputation_score) : chalk.dim("N/A");
        const fidelityColor =
          g.fidelity === "Native" ? chalk.green : g.fidelity === "Hybrid" ? chalk.blue : chalk.dim;

        console.log(
          "  " +
            padRight(g.name, col.name) +
            padRight(g.domain, col.domain) +
            padRight(fidelityColor(g.fidelity), col.fidelity + 10) +
            padRight(repStr, col.rep + 10) +
            String(g.downloads)
        );
      }

      const sorted = [...genes].sort(
        (a, b) => (b.reputation_score || 0) - (a.reputation_score || 0)
      );
      const best = sorted[0];

      console.log();
      if (best.reputation_score != null) {
        display.info(
          `Highest reputation: ${chalk.bold(best.name)} (${best.reputation_score.toFixed(4)})`
        );
      }
      display.info("Use Arena rankings for authoritative F(g)-based comparison within a domain.");
    } catch (err: any) {
      display.error(err.message || "Comparison failed");
      process.exit(1);
    }
  });

function formatScore(score: number): string {
  if (score >= 0.7) return chalk.green(score.toFixed(4));
  if (score >= 0.3) return chalk.yellow(score.toFixed(4));
  return chalk.dim(score.toFixed(4));
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
