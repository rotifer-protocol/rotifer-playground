import { Command } from "commander";
import * as display from "../utils/display.js";
import { fidelityColor, scoreColor, c } from "../utils/palette.js";
import { getGene } from "../cloud/client.js";

export const compareCommand = new Command("compare")
  .description("Compare 2-5 genes by reputation and downloads")
  .argument("[gene-refs...]", "2-5 gene UUIDs, names, or content hashes")
  .action(async (geneRefs: string[]) => {
    if (!geneRefs || geneRefs.length < 2) {
      display.error("Provide between 2 and 5 gene refs for comparison (at least 2, at most 5).");
      display.hint("Usage: rotifer compare <gene-ref> <gene-ref> [gene-ref...]");
      process.exit(1);
      return;
    }
    if (geneRefs.length > 5) {
      display.error("Provide between 2 and 5 gene refs for comparison.");
      display.hint("Narrow your selection to 5 or fewer genes.");
      process.exit(1);
      return;
    }

    try {
      const genes = await Promise.all(geneRefs.map((id) => getGene(id)));

      display.renderResult(
        { genes: genes.map((g, i) => ({
            _idx: i + 1,
            name: g.name, domain: g.domain, fidelity: g.fidelity,
            reputation_score: g.reputation_score, downloads: g.downloads,
          })) },
        (data) => {
          display.header("Gene Comparison");
          console.log();
          display.table(data.genes as unknown as Record<string, unknown>[], [
            { key: "_idx", label: "#", width: 4, align: "right" },
            { key: "name", label: "Name", width: 20 },
            { key: "domain", label: "Domain", width: 14 },
            { key: "fidelity", label: "Fidelity", width: 12,
              format: (v) => fidelityColor(String(v)) },
            { key: "reputation_score", label: "R(g)", width: 12,
              format: (v) => scoreColor(v as number | null) },
            { key: "downloads", label: "Downloads", width: 10,
              format: (v) => String(v ?? 0) },
          ]);

          const sorted = [...data.genes].sort(
            (a, b) => ((b.reputation_score as number) || 0) - ((a.reputation_score as number) || 0)
          );
          const best = sorted[0];

          console.log();
          if (best.reputation_score != null) {
            display.hint(
              `Highest R(g): ${c.bold(best.name as string)} (${(best.reputation_score as number).toFixed(4)})`
            );
          }
          display.hint("Use Arena rankings for authoritative F(g)-based comparison within a domain.");
        }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Comparison failed";
      display.error(msg);
      display.hint("Check the gene refs and try again, or run 'rotifer search <query>' to find cloud genes.");
      process.exit(1);
    }
  });
