import { Command } from "commander";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { listSnapshots, restoreGene, uninstallGene } from "../utils/gene-snapshots.js";

function genesDirOf(): string {
  const root = requireProjectRoot();
  return join(root, loadConfig(root).genes_dir);
}

function showAvailable(genesDir: string): void {
  const available = listSnapshots(genesDir);
  if (available.length === 0) {
    display.info("Nothing to roll back — no gene in this project has been overwritten or removed.");
    return;
  }
  display.info("Genes that can be rolled back:");
  for (const s of available) {
    const version = s.replacedVersion ? ` (was v${s.replacedVersion})` : "";
    const when = s.replacedAt ? ` — replaced ${s.replacedAt}` : "";
    console.log(`  ${s.name}${version}${when}`);
  }
  console.log("");
  display.info("Restore one with: rotifer rollback <gene-name>");
}

export const rollbackCommand = new Command("rollback")
  .description("Restore the copy of a gene that an overwrite or uninstall replaced")
  .argument("[gene-name]", "gene to restore; omit to list what can be rolled back")
  .action((geneName?: string) => {
    display.header("Rollback");
    const genesDir = genesDirOf();

    if (!geneName) {
      showAvailable(genesDir);
      return;
    }

    try {
      const result = restoreGene(genesDir, geneName);
      const version = result.replacedVersion ? ` (v${result.replacedVersion})` : "";
      display.success(`Restored ${result.name}${version} to ${result.restoredTo}`);
      // Saying this out loud matters: someone who expects an undo stack would
      // otherwise discover the hard way that there is only one step.
      display.info("The snapshot has been used up. Rollback undoes one step, not a history.");
    } catch (err) {
      display.rustStyleError({
        code: "E0052",
        message: err instanceof Error ? err.message : String(err),
        file: genesDir,
        suggestion: "Run 'rotifer rollback' with no arguments to see what can be restored",
      });
      process.exit(1);
    }
  });

export const uninstallCommand = new Command("uninstall")
  .description("Remove a locally installed gene, keeping a snapshot so it can be restored")
  .argument("<gene-name>", "gene to remove")
  .action((geneName: string) => {
    display.header("Uninstall");
    const genesDir = genesDirOf();

    try {
      const meta = uninstallGene(genesDir, geneName);
      const version = meta.replacedVersion ? ` (v${meta.replacedVersion})` : "";
      display.success(`Removed ${meta.name}${version}`);
      display.info(`Restore it with: rotifer rollback ${meta.name}`);
    } catch (err) {
      display.rustStyleError({
        code: "E0053",
        message: err instanceof Error ? err.message : String(err),
        file: join(genesDir, geneName),
        suggestion: "Run 'rotifer list' to see which genes are installed",
      });
      process.exit(1);
    }
  });
