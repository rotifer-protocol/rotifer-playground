import { Command } from "commander";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { listGenes } from "../cloud/client.js";

function formatRep(score: number | null | undefined): string {
  if (score == null) return chalk.dim("—");
  if (score >= 0.7) return chalk.green(score.toFixed(2));
  if (score >= 0.3) return chalk.yellow(score.toFixed(2));
  return chalk.dim(score.toFixed(2));
}

export const searchCommand = new Command("search")
  .description("Search genes on Rotifer Cloud")
  .argument("[query]", "search keywords")
  .option("-d, --domain <domain>", "filter by domain")
  .option("--fidelity <type>", "filter by fidelity (Native/Wrapped)")
  .option("--sort <order>", "sort order: newest, popular, fitness", "newest")
  .option("--page <n>", "page number", "1")
  .action(
    async (
      query: string | undefined,
      options: {
        domain?: string;
        fidelity?: string;
        sort?: string;
        page?: string;
      }
    ) => {
      display.header("Cloud Gene Search");

      try {
        const result = await listGenes({
          query,
          domain: options.domain,
          fidelity: options.fidelity,
          sort: options.sort,
          page: parseInt(options.page || "1", 10),
        });

        if (result.genes.length === 0) {
          display.warn("No genes found");
          if (query) display.info(`Try a different search: rotifer search`);
          return;
        }

        console.log();
        const col = {
          name: 22,
          owner: 14,
          domain: 14,
          version: 9,
          fidelity: 10,
          rep: 8,
          dl: 8,
        };
        console.log(
          "  " +
            padRight("Name", col.name) +
            padRight("Owner", col.owner) +
            padRight("Domain", col.domain) +
            padRight("Ver", col.version) +
            padRight("Fidelity", col.fidelity) +
            padRight("R(g)", col.rep) +
            "DL"
        );
        console.log("  " + "\u2500".repeat(85));

        for (const g of result.genes) {
          const fidelityColor =
            g.fidelity === "Native" ? chalk.green : chalk.dim;
          console.log(
            "  " +
              padRight(g.name, col.name) +
              padRight(g.owner, col.owner) +
              padRight(g.domain, col.domain) +
              padRight(g.version, col.version) +
              padRight(fidelityColor(g.fidelity), col.fidelity + 10) +
              padRight(formatRep((g as any).reputation_score), col.rep + 10) +
              String(g.downloads)
          );
        }

        console.log();
        display.info(
          `Page ${result.page} — ${result.genes.length} of ${result.total} total`
        );
        display.info("Install a gene: rotifer install <gene-id>");
      } catch (err: any) {
        display.error(err.message || "Search failed");
        process.exit(1);
      }
    }
  );

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
