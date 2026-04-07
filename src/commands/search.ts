import { Command } from "commander";
import * as display from "../utils/display.js";
import { fidelityColor, scoreColor2, c } from "../utils/palette.js";
import { listGenes } from "../cloud/client.js";

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

function buildSearchCommand(
  query: string | undefined,
  options: {
    domain?: string;
    fidelity?: string;
    sort?: string;
  },
  page?: number,
): string {
  const parts = ["rotifer search"];
  if (query) parts.push(quoteArg(query));
  if (options.domain) parts.push(`--domain ${quoteArg(options.domain)}`);
  if (options.fidelity) parts.push(`--fidelity ${quoteArg(options.fidelity)}`);
  if (options.sort && options.sort !== "newest") parts.push(`--sort ${quoteArg(options.sort)}`);
  if (page && page > 1) parts.push(`--page ${page}`);
  return parts.join(" ");
}

export const searchCommand = new Command("search")
  .description("Search genes on Rotifer Cloud")
  .argument("[query]", "search keywords")
  .option("-d, --domain <domain>", "filter by domain")
  .option("--fidelity <type>", "filter by fidelity (Native/Wrapped)")
  .option("--sort <order>", "sort order: newest, relevance, popular, downloads, reputation", "newest")
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
      const s = display.spinner("Searching Rotifer Cloud...");
      try {
        const result = await listGenes({
          query,
          domain: options.domain,
          fidelity: options.fidelity,
          sort: options.sort,
          page: parseInt(options.page || "1", 10),
        });
        s.stop();

        if (result.genes.length === 0) {
          display.renderResult(result, () => {
            if (result.total_exact && result.total > 0 && result.page > 1) {
              const lastPage = Math.max(1, Math.ceil(result.total / result.per_page));
              display.box(
                [
                  `Page ${result.page} is out of range for this search.`,
                  `Matching cloud genes: ${result.total}`,
                  `Last page: ${lastPage}`,
                  "",
                  c.muted("Try next:"),
                  `  ${c.accent(buildSearchCommand(query, options, lastPage))}`,
                ],
                { title: "Cloud Gene Search" },
              );
              return;
            }

            const summaryLines = [
              "No cloud genes matched this search.",
              query ? `Search query: ${c.bold(query)}` : null,
              options.domain ? `Domain filter: ${c.bold(options.domain)}` : null,
              options.fidelity ? `Fidelity filter: ${c.bold(options.fidelity)}` : null,
            ].filter(Boolean) as string[];

            display.box(
              [
                ...summaryLines,
                "",
                c.muted("Try next:"),
                `  ${c.accent("rotifer search")}                       ${c.muted("browse all cloud genes")}`,
                `  ${c.accent("rotifer search --domain <domain>")}     ${c.muted("filter by domain")}`,
                `  ${c.accent("rotifer list")}                         ${c.muted("inspect local genes")}`,
              ],
              { title: "Cloud Gene Search" },
            );
          });
          return;
        }

        display.renderResult(
          { genes: result.genes, total: result.total, page: result.page },
          (data) => {
            const pageSize = result.per_page || 20;
            const pageOffset = ((data.page as number) - 1) * pageSize;
            const numbered = (data.genes as unknown as Record<string, unknown>[]).map(
              (g, i) => ({ "#": pageOffset + i + 1, ...g }),
            );
            display.header("Cloud Gene Search", { separator: false });
            display.table(numbered, [
              { key: "#", label: "#", width: 4 },
              { key: "name", label: "Name", width: 30 },
              { key: "owner", label: "Creator", width: 16 },
              { key: "domain", label: "Domain", width: 20 },
              { key: "version", label: "Ver", width: 6 },
              { key: "fidelity", label: "Fidelity", width: 10,
                format: (v) => fidelityColor(String(v)) },
              { key: "reputation_score", label: "R(g)", width: 6,
                format: (v) => scoreColor2(v as number | null) },
              { key: "downloads", label: "DL", width: 4,
                format: (v) => String(v ?? 0) },
            ]);
            console.log();
            if (result.total_exact) {
              display.hint(`Page ${data.page} · ${data.genes.length} of ${data.total} cloud genes`);
            } else {
              display.hint(`Page ${data.page} · showing ${data.genes.length} cloud genes`);
            }
            display.hint("Next: rotifer info <gene-ref>");
            display.hint("      rotifer install <gene-ref>");
          }
        );
      } catch (err: unknown) {
        s.stop();
        const msg = err instanceof Error ? err.message : "Search failed";
        display.error(msg);
        display.hint("Try 'rotifer list' for local genes, or retry when Rotifer Cloud is reachable.");
        process.exit(1);
      }
    }
  );
