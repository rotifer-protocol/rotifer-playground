import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { c, icon } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { requireAuth } from "../cloud/auth.js";
import type { CloudCredentials } from "../cloud/types.js";
import {
  publishGene,
  getDeveloperReputation,
} from "../cloud/client.js";
import { refreshDomainCacheFromCloud } from "../utils/domain-suggest.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { contentHash } from "../utils/content-hash.js";
import { runPrePublishChecks, type CheckItem } from "../publish/pre-publish-check.js";
import {
  detectSourceLanguage,
  isValidSourceLanguage,
  type SourceLanguage,
} from "../utils/detect-source-language.js";
import { decideBadgeAction, uploadSafetyBadge } from "../cloud/badge.js";
import type { ScanResult } from "../scanner/types.js";

const VG_SCANNER_VERSION = "0.8.0";

interface PublishOptions {
  description?: string;
  changelog?: string;
  skipArena?: boolean;
  skipSecurity?: boolean;
  skipVg?: boolean;
  all?: boolean;
  lang?: string;
}

interface PublishResult {
  name: string;
  status: "created" | "updated" | "skipped" | "failed";
  error?: string;
}

function formatCheckIcon(status: CheckItem["status"]): string {
  if (status === "pass") return c.success(icon.success);
  if (status === "warn") return c.warn(icon.warn);
  return c.error(icon.error);
}

async function publishSingleGene(
  geneName: string,
  geneDir: string,
  creds: CloudCredentials,
  options: PublishOptions,
  isQuiet: boolean = false,
): Promise<PublishResult> {
  const phenotypePath = join(geneDir, "phenotype.json");

  if (!existsSync(phenotypePath)) {
    if (!isQuiet) {
      display.warn(`Skipping '${geneName}' — no phenotype.json`);
    }
    return { name: geneName, status: "skipped", error: "no phenotype.json" };
  }

  let scanResult: ScanResult | null = null;
  if (!options.skipSecurity) {
    const checkResult = runPrePublishChecks(geneDir, geneName);
    scanResult = checkResult.scanResult;

    if (!isQuiet) {
      for (const check of checkResult.checks) {
        console.log(`  ${formatCheckIcon(check.status)} ${check.name}: ${check.message}`);
      }
    }

    if (!checkResult.passed) {
      const reasons = checkResult.blocking.map((b) => `${b.name}: ${b.message}`).join("; ");
      if (!isQuiet) {
        display.error(`Security check failed for '${geneName}'. Use --skip-security to bypass.`);
      }
      return { name: geneName, status: "failed", error: `pre-publish security check failed — ${reasons}` };
    }
  }

  const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));

  if (phenotype.fidelity === "Hybrid") {
    const net = phenotype.network;
    if (!net || !Array.isArray(net.allowedDomains) || net.allowedDomains.length === 0) {
      return { name: geneName, status: "failed", error: "Hybrid gene missing allowedDomains" };
    }
    const forbidden = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?)$/;
    for (const domain of net.allowedDomains) {
      if (forbidden.test(domain)) {
        return { name: geneName, status: "failed", error: `forbidden domain: ${domain}` };
      }
    }
  }

  const fidelity: string = phenotype.fidelity || "Wrapped";

  if (!phenotype.synthesisMethod) {
    phenotype.synthesisMethod = "MANUAL";
  }

  const irWasmPath = join(geneDir, "gene.ir.wasm");
  const wasmBytes = existsSync(irWasmPath)
    ? (readFileSync(irWasmPath) as Buffer)
    : null;

  if (fidelity === "Native" && !wasmBytes) {
    return {
      name: geneName,
      status: "failed",
      error: `Native gene requires compiled WASM (gene.ir.wasm). Run 'rotifer compile ${geneName}' first, or set fidelity to "Wrapped" / "Hybrid" in phenotype.json`,
    };
  }

  const version: string = phenotype.version || "0.1.0";
  if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)) {
    return {
      name: geneName,
      status: "failed",
      error: `Invalid version format '${version}'. Use semver (e.g., '1.0.0', '0.1.0-beta.1').`,
    };
  }
  const manifestPath = join(geneDir, ".cloud-manifest.json");
  const isFirstPublish = !existsSync(manifestPath);
  if (isFirstPublish && /^[1-9]/.test(version)) {
    if (!isQuiet) {
      display.warn(
        `First publish of '${geneName}' uses version ${version} (no prior version chain). Consider starting from 0.x.y.`
      );
    }
  }

  const domain = phenotype.domain || "unknown";
  if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(domain)) {
    return {
      name: geneName,
      status: "failed",
      error: `Invalid domain format '${domain}'. Use lowercase letters, numbers, and dots (e.g. 'media.video').`,
    };
  }

  const explicitLang = options.lang?.toLowerCase();
  if (explicitLang && !isValidSourceLanguage(explicitLang)) {
    return {
      name: geneName,
      status: "failed",
      error: `Invalid --lang value '${options.lang}'. Allowed: typescript|rust|assemblyscript|go|c|external|unknown`,
    };
  }
  const detectedLang = detectSourceLanguage(geneDir);
  const sourceLanguage: SourceLanguage =
    (explicitLang as SourceLanguage | undefined) ??
    (typeof phenotype.sourceLanguage === "string" &&
    isValidSourceLanguage(phenotype.sourceLanguage)
      ? (phenotype.sourceLanguage as SourceLanguage)
      : detectedLang);
  phenotype.sourceLanguage = sourceLanguage;

  if (!isQuiet) {
    const origin = explicitLang
      ? "explicit --lang"
      : phenotype.sourceLanguage === detectedLang
        ? "auto-detected"
        : "from phenotype.json";
    display.info(`Source language: ${sourceLanguage} (${origin})`);
  }

  const description =
    options.description ||
    phenotype.description ||
    `${geneName} gene (${domain})`;

  const nonAscii = (description.match(/[^\x20-\x7E]/g) || []).length;
  if (!isQuiet && nonAscii > description.length * 0.5) {
    display.warn(
      `Description for '${geneName}' is mostly non-English. ` +
      `English descriptions improve global discoverability. ` +
      `Consider adding an English description in phenotype.json.`
    );
  }

  const changelog = options.changelog || null;

  let readme: string | null = null;
  const readmePath = join(geneDir, "README.md");
  if (existsSync(readmePath)) {
    readme = readFileSync(readmePath, "utf-8");
  }

  try {
    const result = await publishGene({
      name: geneName,
      domain,
      version: phenotype.version || "0.1.0",
      fidelity: phenotype.fidelity || "Wrapped",
      description,
      phenotype,
      wasmBytes,
      contentHash: contentHash(phenotype),
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

    await tryUploadVgBadge(result.id, scanResult, options, isQuiet);

    if (!options.skipArena && !isQuiet) {
      display.info(
        `Auto Arena submission skipped for '${geneName}' — verified runtime metrics are required. ` +
        `Run 'rotifer arena submit ${geneName} --cloud' after evaluation.`
      );
    }

    return { name: geneName, status };
  } catch (err: any) {
    return { name: geneName, status: "failed", error: err.message };
  }
}

/**
 * Upload V(g) safety badge after successful publish (v0.9 §3.8 Phase 1).
 *
 * Behavior matrix (see `decideBadgeAction` in src/cloud/badge.ts).
 * Failures are non-blocking: badge is observability, not protocol.
 */
async function tryUploadVgBadge(
  geneUuid: string,
  scanResult: ScanResult | null,
  options: PublishOptions,
  isQuiet: boolean,
): Promise<void> {
  const token = process.env.ROTIFER_BADGE_TOKEN;
  if (!token) {
    if (!isQuiet) {
      display.hint("Skipping V(g) badge upload (ROTIFER_BADGE_TOKEN not set)");
    }
    return;
  }

  const action = decideBadgeAction({
    skipVg: options.skipVg,
    skipSecurity: options.skipSecurity,
    hasScanResult: scanResult !== null,
  });

  if (action.kind === "skip") {
    if (!isQuiet) {
      display.hint(`Skipping V(g) badge upload (${action.reason})`);
    }
    return;
  }

  const payload = action.mode === "skipped" ? null : scanResult;
  const r = await uploadSafetyBadge(geneUuid, payload, VG_SCANNER_VERSION, action.mode, token);
  if (!isQuiet) {
    if (r.ok) {
      const detail = action.mode === "skipped" ? "skipped" : `grade ${payload?.grade ?? "?"}`;
      display.success(`V(g) badge uploaded (${detail})`);
    } else {
      const detail = r.status ? `${r.status} ${r.error ?? ""}` : (r.error ?? "");
      display.warn(`V(g) badge upload failed (non-blocking): ${detail}`);
    }
  }
}

export const publishCommand = new Command("publish")
  .description("Publish gene(s) to Rotifer Cloud")
  .argument("[gene-name]", "gene name to publish (omit when using --all)")
  .option("--description <text>", "gene description")
  .option("--changelog <text>", "changelog entry for this version (max 500 chars)")
  .option("--skip-arena", "skip automatic Arena submission and reputation computation")
  .option("--skip-security", "skip pre-publish security checks (dangerous API / IR / secrets scan)")
  .option("--skip-vg", "skip V(g) safety scan and upload 'skipped' badge placeholder (badge displays 'skipped')")
  .option("--all", "publish all valid genes in the genes directory")
  .option(
    "--lang <lang>",
    "explicitly declare source language (typescript|rust|assemblyscript|go|c|external)",
  )
  .action(async (geneName: string | undefined, options: PublishOptions) => {
    if (!geneName && !options.all) {
      display.error("Provide a gene name or use --all to publish all genes.");
      display.hint("Example: rotifer publish my-gene  or  rotifer publish --all");
      process.exit(1);
    }

    const root = requireProjectRoot();
    const config = loadConfig(root);

    if (!options.all && geneName) {
      validateGeneName(geneName);
      const geneDir = join(root, config.genes_dir, geneName);
      const phenotypePath = join(geneDir, "phenotype.json");

      if (!existsSync(phenotypePath)) {
        display.rustStyleError({
          code: "E0050",
          message: `Gene '${geneName}' not found`,
          file: phenotypePath,
          suggestion: "Run 'rotifer wrap " + geneName + " --domain <domain>' first",
        });
        process.exit(1);
      }

      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));

      if (phenotype.fidelity === "Native") {
        const wasmPath = join(geneDir, "gene.ir.wasm");
        if (!existsSync(wasmPath)) {
          display.rustStyleError({
            code: "E0060",
            message: `Native gene '${geneName}' has no compiled WASM binary`,
            file: wasmPath,
            suggestion:
              "Run 'rotifer compile " +
              geneName +
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
            message: `Hybrid gene '${geneName}' missing allowedDomains in network config`,
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
              message: `Hybrid gene '${geneName}' has forbidden domain: ${domain}`,
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

      display.hint(`Found ${dirs.length} directories in ${config.genes_dir}/`);
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
            `Creator reputation refresh failed: ${repErr?.message ?? "unknown error"}`
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
      if (failed > 0) {
        display.warn(
          `${created + updated} published, ${skipped} skipped, ${failed} failed`
        );
      } else {
        display.success(
          `${created + updated} published, ${skipped} skipped, ${failed} failed`
        );
      }

      if (created + updated > 0) {
        refreshDomainCacheFromCloud().catch(() => {});
      }

      if (failed > 0) {
        process.exit(1);
      }
    } else {
      display.header("Publish to Cloud");
      display.info(`Publishing as ${creds.user.username}`);

      const geneDir = join(root, config.genes_dir, geneName!);
      const phenotypePath = join(geneDir, "phenotype.json");

      if (!existsSync(phenotypePath)) {
        display.rustStyleError({
          code: "E0050",
          message: `Gene '${geneName}' not found`,
          file: phenotypePath,
          suggestion: "Run 'rotifer wrap " + geneName + " --domain <domain>' first",
        });
        process.exit(1);
      }

      if (!options.skipSecurity) {
        console.log();
        display.header("Pre-publish Security Check");
      }

      const result = await publishSingleGene(geneName!, geneDir, creds, options);

      if (result.status === "failed") {
        display.error(result.error || "Publish failed");
        display.hint("Check your network connection and login status with 'rotifer whoami'.");
        process.exit(1);
      }

      if (result.status === "skipped") {
        display.warn(`Gene '${geneName}' skipped: ${result.error}`);
        process.exit(0);
      }

      console.log();
      const verb = result.status === "updated" ? "updated" : "created";
      display.success(`Gene '${geneName}' ${verb} on cloud!`);

      const manifestPath = join(geneDir, ".cloud-manifest.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        display.keyValue("ID", manifest.cloud_id);
        display.keyValue("Creator", manifest.owner);
        display.keyValue("Version", manifest.version);
        display.keyValue("Status", result.status === "updated" ? "Updated existing" : "Newly created");
        if (options.changelog) {
          display.keyValue("Changelog", options.changelog);
        }
      }

      if (!options.skipArena) {
        try {
          const devRep = await getDeveloperReputation(creds.user.id);
          display.keyValue("Creator Reputation", devRep.score.toFixed(4));
          display.keyValue("Genes Published", String(devRep.genes_published));
        } catch (repErr: any) {
          display.warn(
            `Creator reputation refresh failed: ${repErr?.message ?? "unknown error"}`
          );
        }
      } else {
        display.hint(
          "Skipped Arena (--skip-arena). Run manually: rotifer arena submit --cloud " + geneName
        );
      }

      refreshDomainCacheFromCloud().catch(() => {});
    }
  });
