import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { getGene, downloadGeneWasm, trackDownload } from "../cloud/client.js";
import { refreshDomainCacheFromCloud } from "../utils/domain-suggest.js";

export const installCommand = new Command("install")
  .description("Install a gene from Rotifer Cloud")
  .argument("<gene-id>", "cloud gene ID to install")
  .option("--force", "overwrite if gene already exists locally", false)
  .action(async (geneId: string, options: { force: boolean }) => {
    display.header("Install from Cloud");

    const root = getProjectRoot();
    const config = loadConfig(root);

    try {
      display.info("Fetching gene metadata...");
      const gene = await getGene(geneId);

      const geneDir = join(root, config.genes_dir, gene.name);

      if (existsSync(geneDir) && !options.force) {
        display.rustStyleError({
          code: "E0051",
          message: `Gene '${gene.name}' already exists locally`,
          file: geneDir,
          suggestion: "Use --force to overwrite, or rename the existing gene",
        });
        process.exit(1);
      }

      mkdirSync(geneDir, { recursive: true });

      writeFileSync(
        join(geneDir, "phenotype.json"),
        JSON.stringify(gene.phenotype, null, 2) + "\n"
      );

      display.success("Phenotype saved");

      if (gene.wasm_url) {
        display.info("Downloading WASM binary...");
        const wasmBytes = await downloadGeneWasm(gene.wasm_url);
        writeFileSync(join(geneDir, "gene.ir.wasm"), wasmBytes);
        display.success(
          `WASM downloaded (${(wasmBytes.length / 1024).toFixed(1)}KB)`
        );
      }

      writeFileSync(
        join(geneDir, ".cloud-manifest.json"),
        JSON.stringify(
          {
            cloud_id: gene.id,
            owner: gene.owner,
            version: gene.version,
            installed_at: new Date().toISOString(),
          },
          null,
          2
        ) + "\n"
      );

      console.log();
      display.success(`Gene '${gene.name}' installed!`);
      display.keyValue("From", `${gene.owner}/${gene.name}@${gene.version}`);
      display.keyValue("Domain", gene.domain);
      display.keyValue("Fidelity", gene.fidelity);
      display.keyValue("Location", geneDir);
      console.log();
      display.info("Test it: rotifer test " + gene.name);
      display.info(
        "Submit to local Arena: rotifer arena submit " + gene.name
      );

      trackDownload(geneId).catch(() => {});
      refreshDomainCacheFromCloud().catch(() => {});
    } catch (err: any) {
      display.error(err.message || "Install failed");
      process.exit(1);
    }
  });
