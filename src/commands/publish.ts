import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { requireAuth } from "../cloud/auth.js";
import type { CloudCredentials } from "../cloud/types.js";
import {
  publishGene,
  arenaSubmit,
  getGeneReputation,
  getDeveloperReputation,
} from "../cloud/client.js";
import { refreshDomainCacheFromCloud } from "../utils/domain-suggest.js";

interface PublishOptions {
  description?: string;
  changelog?: string;
  skipArena?: boolean;
  all?: boolean;
}

interface PublishResult {
  name: string;
  status: "created" | "updated" | "skipped" | "failed";
  error?: string;
}

async function publishSingleGene(
  name: string,
  geneDir: string,
  creds: CloudCredentials,
  options: PublishOptions,
  quiet: boolean = false,
): Promise<PublishResult> {
  const phenotypePath = join(geneDir, "phenotype.json");

  if (!existsSync(phenotypePath)) {
    if (!quiet) {
      display.warn(`Skipping '${name}' — no phenotype.json`);
    }
    return { name, status: "skipped", error: "no phenotype.json" };
  }

  const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));

  if (phenotype.fidelity === "Hybrid") {
    const net = phenotype.network;
    if (!net || !Array.isArray(net.allowedDomains) || net.allowedDomains.length === 0) {
      return { name, status: "failed", error: "Hybrid gene missing allowedDomains" };
    }
    const forbidden = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/;
    for (const domain of net.allowedDomains) {
      if (forbidden.test(domain)) {
        return { name, status: "failed", error: `forbidden domain: ${domain}` };
      }
    }
  }

  const fidelity: string = phenotype.fidelity || "Wrapped";

  const irWasmPath = join(geneDir, "gene.ir.wasm");
  const wasmBytes = existsSync(irWasmPath)
    ? (readFileSync(irWasmPath) as Buffer)
    : null;

  if (fidelity === "Native" && !wasmBytes) {
    return {
      name,
      status: "failed",
      error: `Native gene requires compiled WASM (gene.ir.wasm). Run 'rotifer compile ${name}' first, or set fidelity to "Wrapped" / "Hybrid" in phenotype.json`,
    };
  }

  const version: string = phenotype.version || "0.1.0";
  const manifestPath = join(geneDir, ".cloud-manifest.json");
  const isFirstPublish = !existsSync(manifestPath);
  if (isFirstPublish && /^[1-9]/.test(version)) {
    if (!quiet) {
      display.warn(
        `First publish of '${name}' uses version ${version} (no prior version chain). Consider starting from 0.x.y.`
      );
    }
  }

  const domain = phenotype.domain || "unknown";
  if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(domain)) {
    return {
      name,
      status: "failed",
      error: `Invalid domain format '${domain}'. Use lowercase letters, numbers, and dots (e.g. 'media.video').`,
    };
  }

  const description =
    options.description ||
    phenotype.description ||
    `${name} gene (${domain})`;

  const changelog = options.changelog || null;

  let readme: string | null = null;
  const readmePath = join(geneDir, "README.md");
  if (existsSync(readmePath)) {
    readme = readFileSync(readmePath, "utf-8");
  }

  try {
    const result = await publishGene({
      name,
      domain,
      version: phenotype.version || "0.1.0",
      fidelity: phenotype.fidelity || "Wrapped",
      description,
      phenotype,
      wasmBytes,
      readme,
      changelog,
    });

    writeFileSync(
      join(geneDir, ".cloud-manifest.json"),
      JSON.stringify(
        {
          cloud_id: result.id,
          owner: result.owner,
          version: result.version,
          published_at: new Date().toISOString(),
        },
        null,
        2
      ) + "\n"
    );

    const status = result.isUpdate ? "updated" : "created";

    if (!options.skipArena) {
      try {
        const defaultFitness = {
          value: 0.5,
          safety_score: 1.0,
          success_rate: 1.0,
          latency_score: 0.8,
          resource_efficiency: 0.8,
        };
        await arenaSubmit(result.id, defaultFitness);
        await getGeneReputation(result.id);
      } catch (arenaErr: any) {
        if (!quiet) {
          display.warn(
            `Arena submission failed for '${name}': ${arenaErr?.message ?? "unknown error"}. Gene published but not ranked. Run 'rotifer arena submit --cloud ${name}' to retry.`
          );
        }
      }
    }

    return { name, status };
  } catch (err: any) {
    return { name, status: "failed", error: err.message };
  }
}

export const publishCommand = new Command("publish")
  .description("Publish gene(s) to Rotifer Cloud")
  .argument("[name]", "gene name to publish (omit when using --all)")
  .option("--description <text>", "gene description")
  .option("--changelog <text>", "changelog entry for this version (max 500 chars)")
  .option("--skip-arena", "skip automatic Arena submission and reputation computation")
  .option("--all", "publish all valid genes in the genes directory")
  .action(async (name: string | undefined, options: PublishOptions) => {
    if (!name && !options.all) {
      display.error("Provide a gene name or use --all to publish all genes.");
      process.exit(1);
    }

    const root = getProjectRoot();
    const config = loadConfig(root);

    if (!options.all && name) {
      const geneDir = join(root, config.genes_dir, name);
      const phenotypePath = join(geneDir, "phenotype.json");

      if (!existsSync(phenotypePath)) {
        display.rustStyleError({
          code: "E0050",
          message: `Gene '${name}' not found`,
          file: phenotypePath,
          suggestion: "Run 'rotifer wrap " + name + " --domain <domain>' first",
        });
        process.exit(1);
      }

      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));

      if (phenotype.fidelity === "Native") {
        const wasmPath = join(geneDir, "gene.ir.wasm");
        if (!existsSync(wasmPath)) {
          display.rustStyleError({
            code: "E0060",
            message: `Native gene '${name}' has no compiled WASM binary`,
            file: wasmPath,
            suggestion:
              "Run 'rotifer compile " +
              name +
              "' to generate gene.ir.wasm, or change fidelity to \"Wrapped\" in phenotype.json",
          });
          process.exit(1);
        }
      }

      if (phenotype.fidelity === "Hybrid") {
        const net = phenotype.network;
        if (!net || !Array.isArray(net.allowedDomains) || net.allowedDomains.length === 0) {
          display.rustStyleError({
            code: "E0055",
            message: `Hybrid gene '${name}' missing allowedDomains in network config`,
            file: phenotypePath,
            suggestion: "Add network.allowedDomains to phenotype.json",
          });
          process.exit(1);
        }
        const forbidden = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/;
        for (const domain of net.allowedDomains) {
          if (forbidden.test(domain)) {
            display.rustStyleError({
              code: "E0056",
              message: `Hybrid gene '${name}' has forbidden domain: ${domain}`,
              file: phenotypePath,
              suggestion: "Remove private/local addresses from allowedDomains",
            });
            process.exit(1);
          }
        }
      }
    }

    let creds;
    try {
      creds = await requireAuth();
    } catch {
      display.error("Not logged in. Run 'rotifer login' first.");
      process.exit(1);
    }

    if (options.all) {
      display.header("Publish All Genes");
      display.info(`Publishing as ${creds.user.username}`);

      const genesRoot = join(root, config.genes_dir);
      const dirs = readdirSync(genesRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();

      display.info(`Found ${dirs.length} directories in ${config.genes_dir}/`);
      console.log();

      const results: PublishResult[] = [];
      for (let i = 0; i < dirs.length; i++) {
        const geneName = dirs[i];
        const geneDir = join(genesRoot, geneName);
        const progress = `[${i + 1}/${dirs.length}]`;

        process.stdout.write(`${progress} ${geneName}... `);

        const result = await publishSingleGene(geneName, geneDir, creds, options, true);
        results.push(result);

        const statusIcon =
          result.status === "created" ? "✅ created" :
          result.status === "updated" ? "✅ updated" :
          result.status === "skipped" ? "⏭ skipped" :
          `❌ ${result.error}`;
        console.log(statusIcon);
      }

      if (!options.skipArena) {
        try {
          await getDeveloperReputation(creds.user.id);
        } catch (repErr: any) {
          display.warn(
            `Developer reputation refresh failed: ${repErr?.message ?? "unknown error"}`
          );
        }
      }

      console.log();
      display.header("Summary");
      const created = results.filter((r) => r.status === "created").length;
      const updated = results.filter((r) => r.status === "updated").length;
      const skipped = results.filter((r) => r.status === "skipped").length;
      const failed = results.filter((r) => r.status === "failed").length;

      display.keyValue("Created", String(created));
      display.keyValue("Updated", String(updated));
      display.keyValue("Skipped", String(skipped));
      if (failed > 0) {
        display.keyValue("Failed", String(failed));
        console.log();
        display.warn("Failed genes:");
        for (const r of results.filter((r) => r.status === "failed")) {
          display.error(`  ${r.name}: ${r.error}`);
        }
      }
      display.success(
        `${created + updated} published, ${skipped} skipped, ${failed} failed`
      );

      if (created + updated > 0) {
        refreshDomainCacheFromCloud().catch(() => {});
      }
    } else {
      display.header("Publish to Cloud");
      display.info(`Publishing as ${creds.user.username}`);

      const geneDir = join(root, config.genes_dir, name!);
      const phenotypePath = join(geneDir, "phenotype.json");

      if (!existsSync(phenotypePath)) {
        display.rustStyleError({
          code: "E0050",
          message: `Gene '${name}' not found`,
          file: phenotypePath,
          suggestion: "Run 'rotifer wrap " + name + " --domain <domain>' first",
        });
        process.exit(1);
      }

      const result = await publishSingleGene(name!, geneDir, creds, options);

      if (result.status === "failed") {
        display.error(result.error || "Publish failed");
        process.exit(1);
      }

      if (result.status === "skipped") {
        display.warn(`Gene '${name}' skipped: ${result.error}`);
        process.exit(0);
      }

      console.log();
      const verb = result.status === "updated" ? "updated" : "created";
      display.success(`Gene '${name}' ${verb} on cloud!`);

      const manifestPath = join(geneDir, ".cloud-manifest.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        display.keyValue("ID", manifest.cloud_id);
        display.keyValue("Owner", manifest.owner);
        display.keyValue("Version", manifest.version);
        display.keyValue("Status", result.status === "updated" ? "Updated existing" : "Newly created");
        if (options.changelog) {
          display.keyValue("Changelog", options.changelog.slice(0, 80) + (options.changelog.length > 80 ? "..." : ""));
        }
      }

      if (!options.skipArena) {
        try {
          const devRep = await getDeveloperReputation(creds.user.id);
          display.keyValue("Developer Reputation", devRep.score.toFixed(4));
          display.keyValue("Genes Published", String(devRep.genes_published));
        } catch (repErr: any) {
          display.warn(
            `Developer reputation refresh failed: ${repErr?.message ?? "unknown error"}`
          );
        }
      } else {
        display.info(
          "Skipped Arena (--skip-arena). Run manually: rotifer arena submit --cloud " + name
        );
      }

      refreshDomainCacheFromCloud().catch(() => {});
    }
  });
