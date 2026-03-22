import { Command } from "commander";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { listGeneVersions } from "../cloud/client.js";

export const versionsCommand = new Command("versions")
  .description("View version history chain for a gene")
  .argument("<owner>", "gene owner username")
  .argument("<name>", "gene name")
  .action(async (owner: string, name: string) => {
    display.header(`Version History: ${owner}/${name}`);

    try {
      const versions = await listGeneVersions(owner, name);

      if (versions.length === 0) {
        display.warn(`No published versions found for ${owner}/${name}`);
        return;
      }

      console.log();
      for (let i = 0; i < versions.length; i++) {
        const v = versions[i];
        const isLatest = i === versions.length - 1;
        const prefix = isLatest ? chalk.green("→") : chalk.dim("│");
        const versionLabel = isLatest
          ? chalk.green.bold(v.version)
          : chalk.white(v.version);

        console.log(`  ${prefix} ${versionLabel}  ${chalk.dim(v.created_at)}`);

        if (v.changelog) {
          console.log(`  ${chalk.dim("│")}   ${v.changelog}`);
        }

        if (v.previous_version_id) {
          console.log(`  ${chalk.dim("│")}   ${chalk.dim("← " + v.previous_version_id.slice(0, 8))}`);
        }

        if (i < versions.length - 1) {
          console.log(`  ${chalk.dim("│")}`);
        }
      }

      console.log();
      display.info(`${versions.length} version(s) found`);
      display.info(`Latest: ${versions[versions.length - 1].version}`);
    } catch (err: any) {
      display.error(err.message || "Failed to fetch version history");
      process.exit(1);
    }
  });
