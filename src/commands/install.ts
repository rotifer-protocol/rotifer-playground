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
import type { CloudGene } from "../cloud/types.js";
import { refreshDomainCacheFromCloud } from "../utils/domain-suggest.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { snapshotGene } from "../utils/gene-snapshots.js";
import { checkNativeArtifact } from "../utils/artifact-consistency.js";

/** The gene is already installed and `force` was not set. */
export class GeneExistsError extends Error {
  constructor(readonly geneName: string, readonly geneDir: string) {
    super(`Gene '${geneName}' already exists locally`);
    this.name = "GeneExistsError";
  }
}

/** The downloaded WASM does not match the size or hash the Registry recorded. */
export class WasmIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WasmIntegrityError";
  }
}

export interface InstallFromCloudOptions {
  /** Absolute path of the workspace's genes directory. */
  genesDir: string;
  force?: boolean;
  /** Print progress the way `rotifer install` does. */
  isVerbose?: boolean;
  /** Called once the gene's metadata has been fetched. */
  onFetched?: (gene: CloudGene) => void;
}

export interface InstalledGene {
  gene: CloudGene;
  geneDir: string;
  didSnapshot: boolean;
}

/**
 * Install one gene from the Registry: phenotype.json, the WASM (size and
 * SHA-256 checked against the Registry row), and `.cloud-manifest.json`.
 * Counts the download, as every install does. Throws on any failure; nothing
 * is printed unless `isVerbose`.
 */
export async function installGeneFromCloud(
  geneRef: string,
  options: InstallFromCloudOptions,
): Promise<InstalledGene> {
  const isVerbose = options.isVerbose ?? false;
  const gene = await getGene(geneRef);
  options.onFetched?.(gene);
  validateGeneName(gene.name);

  const geneDir = join(options.genesDir, gene.name);

  if (existsSync(geneDir) && !options.force) {
    throw new GeneExistsError(gene.name, geneDir);
  }

  // Move the old copy aside before writing over it — this is what makes
  // --force reversible. If it fails, nothing is installed: an overwrite the
  // user believes is undoable and is not would be worse than no install.
  let didSnapshot = false;
  if (existsSync(geneDir) && options.force) {
    snapshotGene(options.genesDir, gene.name, gene.id ?? null);
    didSnapshot = true;
  }

  mkdirSync(geneDir, { recursive: true });

  writeFileSync(
    join(geneDir, "phenotype.json"),
    JSON.stringify(gene.phenotype, null, 2) + "\n"
  );

  if (isVerbose) display.success("Phenotype saved");

  if (gene.wasm_url) {
    const ws = isVerbose ? display.spinner("Downloading WASM binary...") : null;
    const wasmBytes = await downloadGeneWasm(gene.wasm_url);
    ws?.stop();

    if (gene.wasm_size && wasmBytes.length !== gene.wasm_size) {
      throw new WasmIntegrityError(
        `WASM size mismatch: expected ${gene.wasm_size} bytes, got ${wasmBytes.length}. ` +
        `Download may be corrupted or tampered with.`,
      );
    }

    if (gene.wasm_hash) {
      const downloadHash = createHash("sha256")
        .update(wasmBytes)
        .digest("hex");
      if (downloadHash !== gene.wasm_hash) {
        throw new WasmIntegrityError(
          `WASM integrity check failed: hash mismatch.\n` +
          `  Expected: ${gene.wasm_hash}\n` +
          `  Got:      ${downloadHash}\n` +
          `Download may be corrupted or tampered with.`,
        );
      }
      if (isVerbose) display.success("WASM integrity verified (SHA-256)");
    }

    writeFileSync(join(geneDir, "gene.ir.wasm"), wasmBytes);
    if (isVerbose) {
      display.success(
        `WASM downloaded (${(wasmBytes.length / 1024).toFixed(1)}KB)`
      );
    }
  } else if (isVerbose) {
    // There was no else branch here, so a Gene declaring Native with no
    // artifact installed in silence and then reported "Fidelity: Native".
    // Running it fails, and nothing had told the user why — leaving them to
    // debug a setup that was never the problem.
    const verdict = checkNativeArtifact({
      geneName: gene.name,
      fidelity: gene.phenotype?.fidelity as string | undefined,
      hasArtifact: false,
      hasSource: false,
    });
    if (verdict.status === "native-without-artifact") {
      display.warn(verdict.message);
      for (const line of verdict.hint) display.hint(line);
    }
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

  trackDownload(gene.id, "cli").catch(() => {});

  return { gene, geneDir, didSnapshot };
}

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
      const { gene, geneDir, didSnapshot } = await installGeneFromCloud(geneRef, {
        genesDir: join(root, config.genes_dir),
        force: options.force,
        isVerbose: true,
        onFetched: () => s.stop(),
      });

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

      refreshDomainCacheFromCloud().catch(() => {});
    } catch (err: any) {
      s.stop();
      if (err instanceof GeneExistsError) {
        display.rustStyleError({
          code: "E0051",
          message: err.message,
          file: err.geneDir,
          suggestion: "Use --force to overwrite, or rename the existing gene",
        });
        process.exit(1);
      }
      if (err instanceof WasmIntegrityError) {
        display.error(err.message);
        process.exit(1);
      }
      display.error(err.message || "Install failed");
      display.hint("Check the gene name/ID and try again, or run 'rotifer search' to find genes.");
      process.exit(1);
    }
  });
