import { Command } from "commander";
import * as display from "../utils/display.js";
import { c, icon } from "../utils/palette.js";
import { listGeneVersions } from "../cloud/client.js";
import { validateGeneName } from "../utils/validate-gene-name.js";

export const versionsCommand = new Command("versions")
  .description("View version history chain for a gene")
  .argument("<owner>", "gene owner username")
  .argument("<gene-name>", "gene name")
  .action(async (owner: string, geneName: string) => {
    validateGeneName(geneName);

    const s = display.spinner("Fetching version history...");
    try {
      const versions = await listGeneVersions(owner, geneName);
      s.stop();

      display.renderResult(
        { owner, geneName, versions },
        (data) => {
          display.header(`Cloud Version History: ${data.owner}/${data.geneName}`);

          if (data.versions.length === 0) {
            console.log();
            display.box(
              [
                `No published versions found for ${data.owner}/${data.geneName}.`,
                "",
                c.muted("Try next:"),
                `  ${c.accent(`rotifer search ${data.geneName}`)}   ${c.muted("look for similarly named cloud genes")}`,
                `  ${c.accent(`rotifer info --cloud ${data.geneName}`)} ${c.muted("check whether this gene exists in Cloud")}`,
              ],
              { title: "Cloud Version History" },
            );
            return;
          }

          console.log();
          for (let i = 0; i < data.versions.length; i++) {
            const v = data.versions[i];
            const isLatest = i === data.versions.length - 1;
            const prefix = isLatest ? c.success(icon.arrow) : c.muted("│");
            const versionLabel = isLatest
              ? c.success.bold(v.version)
              : v.version;

            console.log(`  ${prefix} ${versionLabel}  ${c.muted(v.created_at)}`);

            if (v.changelog) {
              console.log(`  ${c.muted("│")}   ${v.changelog}`);
            }

            if (v.previous_version_id) {
              console.log(`  ${c.muted("│")}   ${c.muted("← " + v.previous_version_id)}`);
            }

            if (i < data.versions.length - 1) {
              console.log(`  ${c.muted("│")}`);
            }
          }

          console.log();
          display.hint(`${data.versions.length} version(s) found in Rotifer Cloud`);
          display.hint(`Latest: ${data.versions[data.versions.length - 1].version}`);
        }
      );
    } catch (err: unknown) {
      s.stop();
      const msg = err instanceof Error ? err.message : "Failed to fetch version history";
      display.error(msg);
      display.hint("Check the gene name/ID and try again.");
      process.exit(1);
    }
  });
