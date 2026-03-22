import { Command } from "commander";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { getGene } from "../cloud/client.js";

export const infoCommand = new Command("info")
  .description("View detailed information about a gene on Rotifer Cloud")
  .argument("<gene-id>", "cloud gene ID")
  .action(async (geneId: string) => {
    display.header("Gene Detail");

    try {
      const gene = await getGene(geneId);

      console.log();
      display.keyValue("Name", gene.name);
      display.keyValue("Owner", gene.owner);
      display.keyValue("Domain", gene.domain);
      display.keyValue("Version", gene.version);
      display.keyValue("Fidelity", gene.fidelity);
      display.keyValue("Description", gene.description || "(none)");
      console.log();

      display.keyValue("Downloads", String(gene.downloads));
      display.keyValue(
        "Reputation",
        gene.reputation_score != null
          ? formatScore(gene.reputation_score)
          : chalk.dim("N/A")
      );
      display.keyValue("Created", gene.created_at);
      display.keyValue("Updated", gene.updated_at);
      console.log();

      display.keyValue("WASM", gene.wasm_url ? `${(gene.wasm_size / 1024).toFixed(1)}KB` : chalk.dim("none"));
      display.keyValue("ID", display.geneId(gene.id));

      if (gene.phenotype && Object.keys(gene.phenotype).length > 0) {
        console.log();
        display.info("Phenotype keys: " + Object.keys(gene.phenotype).join(", "));
      }

      console.log();
      display.info("Install:    rotifer install " + gene.id);
      display.info("Reputation: rotifer reputation " + gene.id);
    } catch (err: any) {
      display.error(err.message || "Failed to fetch gene details");
      process.exit(1);
    }
  });

function formatScore(score: number): string {
  if (score >= 0.7) return chalk.green(score.toFixed(4));
  if (score >= 0.3) return chalk.yellow(score.toFixed(4));
  return chalk.dim(score.toFixed(4));
}
