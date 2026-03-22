import { Command } from "commander";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";

export const listCommand = new Command("list")
  .description("List local genes in the current project")
  .option("-d, --domain <domain>", "filter by domain")
  .option("--fidelity <type>", "filter by fidelity")
  .action(
    (options: { domain?: string; fidelity?: string }) => {
      display.header("Local Gene Inventory");

      let root: string;
      try {
        root = getProjectRoot();
      } catch {
        display.error("Not in a Rotifer project. Run 'rotifer init' first.");
        process.exit(1);
        return;
      }

      const config = loadConfig(root);
      const genesDir = join(root, config.genes_dir);

      if (!existsSync(genesDir)) {
        display.warn("No genes directory found");
        display.info("Create your first gene: rotifer wrap <name>");
        return;
      }

      let entries: string[];
      try {
        entries = readdirSync(genesDir).filter((name) => {
          const p = join(genesDir, name);
          return statSync(p).isDirectory() && existsSync(join(p, "phenotype.json"));
        });
      } catch {
        display.warn("Could not read genes directory");
        return;
      }

      interface LocalGene {
        name: string;
        domain: string;
        version: string;
        fidelity: string;
        hasWasm: boolean;
        hasCloud: boolean;
      }

      let genes: LocalGene[] = entries.map((name) => {
        const geneDir = join(genesDir, name);
        let phenotype: any = {};
        let cloud: any = null;

        try {
          phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
        } catch { /* empty */ }

        try {
          cloud = JSON.parse(readFileSync(join(geneDir, ".cloud-manifest.json"), "utf-8"));
        } catch { /* empty */ }

        return {
          name,
          domain: phenotype.domain || "unknown",
          version: phenotype.version || cloud?.version || "—",
          fidelity: phenotype.fidelity || "Unknown",
          hasWasm: existsSync(join(geneDir, "gene.ir.wasm")),
          hasCloud: cloud != null,
        };
      });

      if (options.domain) {
        genes = genes.filter((g) => g.domain === options.domain || g.domain.startsWith(options.domain + "."));
      }
      if (options.fidelity) {
        genes = genes.filter((g) => g.fidelity === options.fidelity);
      }

      genes.sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));

      if (genes.length === 0) {
        display.warn("No genes found");
        display.info("Create one: rotifer wrap <name>");
        return;
      }

      console.log();
      const col = { name: 22, domain: 16, version: 10, fidelity: 10, status: 10 };
      console.log(
        "  " +
          padRight("Name", col.name) +
          padRight("Domain", col.domain) +
          padRight("Version", col.version) +
          padRight("Fidelity", col.fidelity) +
          "Status"
      );
      console.log("  " + "\u2500".repeat(68));

      for (const g of genes) {
        const fidelityColor = g.fidelity === "Native" ? chalk.green : g.fidelity === "Hybrid" ? chalk.blue : chalk.dim;
        const status = [
          g.hasWasm ? chalk.green("WASM") : "",
          g.hasCloud ? chalk.cyan("Cloud") : "",
        ]
          .filter(Boolean)
          .join(" ") || chalk.dim("local");

        console.log(
          "  " +
            padRight(g.name, col.name) +
            padRight(g.domain, col.domain) +
            padRight(g.version, col.version) +
            padRight(fidelityColor(g.fidelity), col.fidelity + 10) +
            status
        );
      }

      console.log();
      display.info(`${genes.length} gene(s) in ${genesDir}`);
    }
  );

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
