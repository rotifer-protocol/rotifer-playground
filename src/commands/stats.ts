import { Command } from "commander";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { getGeneStats } from "../cloud/client.js";

export const statsCommand = new Command("stats")
  .description("View download statistics for a gene")
  .argument("<gene-id>", "cloud gene ID")
  .action(async (geneId: string) => {
    display.header("Gene Download Statistics");

    try {
      const stats = await getGeneStats(geneId);

      console.log();
      const barWidth = 30;

      const max = Math.max(stats.total, 1);
      const periods = [
        { label: "Last  7 days", value: stats.last_7d },
        { label: "Last 30 days", value: stats.last_30d },
        { label: "Last 90 days", value: stats.last_90d },
        { label: "All time    ", value: stats.total },
      ];

      for (const p of periods) {
        const ratio = p.value / max;
        const filled = Math.round(ratio * barWidth);
        const bar = chalk.cyan("█".repeat(filled)) + chalk.dim("░".repeat(barWidth - filled));
        console.log(`  ${p.label}  ${bar}  ${chalk.bold(String(p.value))}`);
      }

      console.log();
      display.keyValue("Gene ID", display.geneId(geneId));
    } catch (err: any) {
      display.error(err.message || "Failed to fetch stats");
      process.exit(1);
    }
  });
