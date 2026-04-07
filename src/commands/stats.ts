import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { getGeneStats } from "../cloud/client.js";

export const statsCommand = new Command("stats")
  .description("View download statistics for a gene")
  .argument("<gene-ref>", "gene UUID, name, or content hash")
  .action(async (geneRef: string) => {
    try {
      const stats = await getGeneStats(geneRef);

      display.renderResult(
        { geneRef, ...stats },
        (data) => {
          display.header("Cloud Download Statistics");
          console.log();
          display.barChart([
            { label: "Last  7 days", value: data.last_7d },
            { label: "Last 30 days", value: data.last_30d },
            { label: "Last 90 days", value: data.last_90d },
            { label: "All time    ", value: data.total },
          ]);
          console.log();
          display.kv("Gene Ref", c.warn(geneRef));
          display.hint("Next: rotifer info " + geneRef);
        }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to fetch stats";
      display.error(msg);
      display.hint("Check the gene name/ID and try again, or run 'rotifer search' to find genes.");
      process.exit(1);
    }
  });
