import { Command } from "commander";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as display from "../utils/display.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { getGene, downloadGeneWasm, trackDownload } from "../cloud/client.js";
import { refreshDomainCacheFromCloud } from "../utils/domain-suggest.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { snapshotGene } from "../utils/gene-snapshots.js";

export const installCommand = new Command("install")
  .description("Install a gene from Rotifer Cloud")
  .argument("<gene-ref>", "gene UUID, name, or content hash")
  .option("--force", "overwrite if gene already exists locally", false)
  .action(async (geneRef: string, options: { force: boolean }) => {
    display.header("Install from Cloud");

    const root = requireProjectRoot();
    const config = loadConfig(root);

    const s = display.spinner("Fetching gene metadata...");
    try {
      const gene = await getGene(geneRef);
      s.stop();
      validateGeneName(gene.name);

      const genesDir = join(root, config.genes_dir);
      const geneDir = join(genesDir, gene.name);

      if (existsSync(geneDir) && !options.force) {
        display.rustStyleError({
          code: "E0051",
          message: `Gene '${gene.name}' already exists locally`,
          file: geneDir,
          suggestion: "Use --force to overwrite, or rename the existing gene",
        });
        process.exit(1);
      }

      // Move the old copy aside before writing over it — this is what makes
      // --force reversible. If it fails, nothing is installed: an overwrite the
      // user believes is undoable and is not would be worse than no install.
      let didSnapshot = false;
      if (existsSync(geneDir) && options.force) {
        snapshotGene(genesDir, gene.name, gene.id ?? null);
        didSnapshot = true;
      }

      mkdirSync(geneDir, { recursive: true });

      writeFileSync(
        join(geneDir, "phenotype.json"),
        JSON.stringify(gene.phenotype, null, 2) + "\n"
      );

      display.success("Phenotype saved");

      if (gene.wasm_url) {
        const ws = display.spinner("Downloading WASM binary...");
        const wasmBytes = await downloadGeneWasm(gene.wasm_url);
        ws.stop();

        if (gene.wasm_size && wasmBytes.length !== gene.wasm_size) {
          display.error(
            `WASM size mismatch: expected ${gene.wasm_size} bytes, got ${wasmBytes.length}. ` +
            `Download may be corrupted or tampered with.`,
          );
          process.exit(1);
        }

        if (gene.wasm_hash) {
          const downloadHash = createHash("sha256")
            .update(wasmBytes)
            .digest("hex");
          if (downloadHash !== gene.wasm_hash) {
            display.error(
              `WASM integrity check failed: hash mismatch.\n` +
              `  Expected: ${gene.wasm_hash}\n` +
              `  Got:      ${downloadHash}\n` +
              `Download may be corrupted or tampered with.`,
            );
            process.exit(1);
          }
          display.success("WASM integrity verified (SHA-256)");
        }

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
      if (didSnapshot) {
        // The user asked to overwrite something. Telling them the old copy is
        // recoverable is the whole point of having taken the snapshot.
        display.hint(`Replaced an existing gene — undo with: rotifer rollback ${gene.name}`);
      }
      display.hint("Test it: rotifer test " + gene.name);
      display.hint(
        "Submit to local Arena: rotifer arena submit " + gene.name
      );

      trackDownload(gene.id, "cli").catch(() => {});
      refreshDomainCacheFromCloud().catch(() => {});
    } catch (err: any) {
      s.stop();
      display.error(err.message || "Install failed");
      display.hint("Check the gene name/ID and try again, or run 'rotifer search' to find genes.");
      process.exit(1);
    }
  });
