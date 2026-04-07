import { Command } from "commander";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as display from "../utils/display.js";
import { scoreColor, c, fidelityColor } from "../utils/palette.js";
import { getGene } from "../cloud/client.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { contentHash } from "../utils/content-hash.js";

interface LocalGeneInfo {
  name: string;
  domain: string;
  version: string;
  fidelity: string;
  description: string;
  contentHash: string;
  hasWasm: boolean;
  wasmSize: number;
  phenotypeKeys: string[];
  path: string;
}

function findLocalGene(geneName: string): LocalGeneInfo | null {
  let root: string;
  try {
    root = getProjectRoot();
  } catch {
    return null;
  }

  const config = loadConfig(root);
  const geneDir = join(root, config.genes_dir, geneName);

  if (!existsSync(join(geneDir, "phenotype.json"))) return null;

  let phenotype: Record<string, unknown> = {};
  try {
    phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
  } catch {
    return null;
  }

  const wasmPath = join(geneDir, "gene.ir.wasm");
  const hasWasm = existsSync(wasmPath);

  return {
    name: geneName,
    domain: (phenotype.domain as string) || "unknown",
    version: (phenotype.version as string) || "0.0.0",
    fidelity: (phenotype.fidelity as string) || "Unknown",
    description: (phenotype.description as string) || "",
    contentHash: contentHash(phenotype),
    hasWasm,
    wasmSize: hasWasm ? statSync(wasmPath).size : 0,
    phenotypeKeys: Object.keys(phenotype),
    path: resolve(geneDir),
  };
}

function findLocalGeneByHash(hash: string): LocalGeneInfo | null {
  let root: string;
  try {
    root = getProjectRoot();
  } catch {
    return null;
  }

  const config = loadConfig(root);
  const genesDir = join(root, config.genes_dir);
  if (!existsSync(genesDir)) return null;

  for (const name of readdirSync(genesDir)) {
    const local = findLocalGene(name);
    if (local && local.contentHash === hash) return local;
  }
  return null;
}

export const infoCommand = new Command("info")
  .description("View gene details (local or Cloud)")
  .argument("<gene-ref>", "gene UUID, name, or content hash")
  .option("--cloud", "force Cloud lookup even if local gene exists")
  .action(async (geneRef: string, options: { cloud?: boolean }) => {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(geneRef);
    const isHash = /^[0-9a-f]{64}$/i.test(geneRef);

    if (!options.cloud && !isUuid) {
      const local = isHash ? findLocalGeneByHash(geneRef) : findLocalGene(geneRef);
      if (local) {
        display.renderResult(local, (data) => {
          display.header("Gene Details" + c.muted(" (local)"));

          console.log();
          display.kv("Name", data.name);
          display.kv("Domain", data.domain);
          display.kv("Version", data.version);
          display.kv("Fidelity", fidelityColor(data.fidelity));
          display.kv("Description", data.description || c.muted("(none)"));
          console.log();

          display.kv("WASM", data.hasWasm
            ? `${(data.wasmSize / 1024).toFixed(1)}KB`
            : c.muted("not compiled"));
          display.kv("Content Hash", c.warn(data.contentHash));
          display.kv("Path", c.muted(data.path));

          if (data.phenotypeKeys.length > 0) {
            console.log();
            display.hint("Phenotype keys: " + data.phenotypeKeys.join(", "));
          }

          console.log();
          display.hint("Next: rotifer info --cloud " + data.name);
          display.hint("      rotifer publish " + data.name);
        });
        return;
      }
    }

    const s = display.spinner("Fetching gene details...");
    try {
      const gene = await getGene(geneRef);
      s.stop();

      display.renderResult(gene, (data) => {
        display.header("Gene Details" + c.muted(" (cloud)"));

        console.log();
        display.kv("Name", data.name);
        display.kv("Creator", data.owner);
        display.kv("Domain", data.domain);
        display.kv("Version", data.version);
        display.kv("Fidelity", fidelityColor(data.fidelity));
        display.kv("Description", data.description || c.muted("(none)"));
        console.log();

        display.kv("Downloads", String(data.downloads));
        display.kv("Reputation",
          data.reputation_score != null
            ? scoreColor(data.reputation_score)
            : c.muted("N/A"));
        display.kv("Created", data.created_at);
        display.kv("Updated", data.updated_at);
        console.log();

        display.kv("WASM", data.wasm_url
          ? `${(data.wasm_size / 1024).toFixed(1)}KB`
          : c.muted("none"));
        display.kv("Content Hash", data.content_hash
          ? c.warn(data.content_hash)
          : c.muted("N/A"));
        display.kv("ID", c.warn(data.id));

        if (data.phenotype && Object.keys(data.phenotype).length > 0) {
          console.log();
          display.hint("Phenotype keys: " + Object.keys(data.phenotype).join(", "));
        }

        console.log();
        display.hint("Next: rotifer install " + data.name);
        display.hint("      rotifer reputation " + data.id);
      });
    } catch (err: unknown) {
      s.stop();
      const msg = err instanceof Error ? err.message : "Failed to fetch gene details";
      display.error(msg);
      display.hint("Check the gene name/ID, or run 'rotifer search' to find genes.");
      process.exit(1);
    }
  });
