import { Command } from "commander";
import { writeFileSync, existsSync, readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createInterface } from "node:readline";
import { contentHash } from "../utils/content-hash.js";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import https from "node:https";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { parseSkillFrontmatter } from "./scan.js";
import { suggestDomains } from "../utils/domain-suggest.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { offerAutoPublish, resolveWrapFidelity } from "../publish/auto-publish.js";

const CLAWHUB_API = "https://clawhub.ai/api/skill";
const CLAWHUB_DOWNLOAD = "https://wry-manatee-359.convex.site/api/v1/download";

interface ClawHubSkillInfo {
  slug: string;
  displayName: string;
  summary: string;
  stats: { downloads: number; stars: number; versions: number; installsCurrent: number };
  owner: { handle: string; displayName: string };
  version: string;
}

function httpsGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // 307/308 preserve the request method, same as 301/302 for a GET — all
      // four just mean "follow Location". ClawHub's download endpoint moved
      // from 302 to 307 at some point without this ever being noticed: the
      // response body of an unfollowed redirect is an HTML/JSON page, and
      // piping that straight into `unzip -o` fails with a generic error that
      // gives no hint the real problem was a status code this function
      // didn't recognize (confirmed against the live endpoint, 2026-08-31).
      if (
        res.statusCode === 301 ||
        res.statusCode === 302 ||
        res.statusCode === 307 ||
        res.statusCode === 308
      ) {
        res.resume(); // drain/discard the redirect body so its socket can be released
        return httpsGet(res.headers.location!).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function fetchClawHubInfo(slug: string): Promise<ClawHubSkillInfo> {
  const buf = await httpsGet(`${CLAWHUB_API}?slug=${slug}`);
  const data = JSON.parse(buf.toString());
  if (!data.skill) throw new Error(`Skill '${slug}' not found on ClawHub`);
  return {
    slug: data.skill.slug,
    displayName: data.skill.displayName,
    summary: data.skill.summary,
    stats: data.skill.stats,
    owner: { handle: data.owner?.handle || "unknown", displayName: data.owner?.displayName || "" },
    version: data.latestVersion?.version || "0.0.0",
  };
}

async function downloadAndExtract(slug: string): Promise<string> {
  const zipBuf = await httpsGet(`${CLAWHUB_DOWNLOAD}?slug=${slug}`);
  const workDir = join(tmpdir(), `rotifer-clawhub-${slug}-${Date.now()}`);
  mkdirSync(workDir, { recursive: true });
  const zipPath = join(workDir, `${slug}.zip`);
  writeFileSync(zipPath, zipBuf);
  execFileSync("unzip", ["-o", zipPath, "-d", join(workDir, "extracted")], { stdio: "pipe" });
  const extracted = join(workDir, "extracted");
  const entries = readdirSync(extracted);
  if (entries.length === 1 && statSync(join(extracted, entries[0])).isDirectory()) {
    return join(extracted, entries[0]);
  }
  return extracted;
}

function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

function determineFidelity(skillDir: string): string {
  const hasJs = readdirSync(skillDir, { recursive: true } as any)
    .some((f: any) => String(f).endsWith(".js") || String(f).endsWith(".ts"));
  const hasPkg = existsSync(join(skillDir, "package.json"));
  if (hasJs || hasPkg) return "Hybrid";
  return "Wrapped";
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      count += countFiles(full);
    } else {
      count++;
    }
  }
  return count;
}

function parseClawHubFrontmatter(content: string): Record<string, string | string[] | Record<string, unknown>> {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};
  const front = match[1];
  const result: Record<string, string | string[] | Record<string, unknown>> = {};
  const nameMatch = front.match(/name:\s*["']?([^"'\n]+)["']?/);
  if (nameMatch) result.name = nameMatch[1].trim();
  const descMatch = front.match(/description:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (descMatch) result.description = descMatch[1].trim();
  const tagsMatch = front.match(/tags:\s*\[([^\]]*)\]/);
  if (tagsMatch) result.tags = tagsMatch[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
  const permsMatch = front.match(/permissions:\s*\[([^\]]*)\]/);
  if (permsMatch) result.permissions = permsMatch[1].split(",").map(t => t.trim().replace(/['"]/g, "")).filter(Boolean);
  return result;
}

async function resolveDomain(
  geneName: string,
  explicitDomain: string | undefined,
  defaultDomain: string,
  description?: string
): Promise<string> {
  if (explicitDomain) {
    if (!/^[a-z0-9]+(\.[a-z0-9]+)*$/.test(explicitDomain)) {
      throw new Error(`Invalid domain format: "${explicitDomain}". Use lowercase letters, digits, and dots only (e.g., "nlp", "code.analysis").`);
    }
    return explicitDomain;
  }

  const suggestions = suggestDomains(geneName, description);
  if (suggestions.length === 0) return defaultDomain;

  if (!process.stdin.isTTY) {
    const best = suggestions[0].domain;
    return best;
  }

  console.log();
  display.hint("Suggested domains based on gene name:");
  suggestions.forEach((s, i) => {
    const count = s.gene_count > 0 ? ` (${s.gene_count} genes)` : "";
    console.log(`  ${i + 1}. ${s.domain}${count}`);
  });
  console.log(`  ${suggestions.length + 1}. [enter a new domain]`);
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Select [1-${suggestions.length + 1}] or type domain: `, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });

  const idx = parseInt(answer, 10);
  if (idx >= 1 && idx <= suggestions.length) {
    return suggestions[idx - 1].domain;
  }
  if (answer && /^[a-z0-9]+(\.[a-z0-9]+)*$/.test(answer)) {
    return answer;
  }
  return suggestions[0].domain;
}

export const wrapCommand = new Command("wrap")
  .description("Wrap a function or SKILL.md as a gene")
  .argument("<gene-name>", "function/gene directory name, or gene name when using --from-skill/--from-clawhub")
  .option("-d, --domain <domain>", "gene functional domain")
  .option("--fidelity <level>", "fidelity level", "Wrapped")
  .option("--from-skill <path>", "create gene from a SKILL.md file (path to SKILL.md or its directory)")
  .option("--from-clawhub <slug>", "create gene from a ClawHub skill (downloads and converts automatically)")
  .action(async (geneName: string, options: { domain?: string; fidelity: string; fromSkill?: string; fromClawhub?: string }) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);

    let domain: string;
    try {
      domain = await resolveDomain(geneName, options.domain, config.default_domain || "general");
    } catch (e) {
      display.rustStyleError({
        code: "E0004",
        message: e instanceof Error ? e.message : "Invalid domain",
        suggestion: "Pass a valid --domain, or check the configured default_domain.",
        docsUrl: "https://rotifer.dev/docs/genes",
      });
      process.exit(1);
    }

    display.header("Gene Wrapper");
    try {
      validateGeneName(geneName);
    } catch (e) {
      display.rustStyleError({
        code: "E0004",
        message: e instanceof Error ? e.message : "Invalid gene name",
        suggestion: "Use a short name without path separators or '..' (letters, digits, '-', '_').",
        docsUrl: "https://rotifer.dev/docs/genes",
      });
      process.exit(1);
    }

    const geneDir = join(root, config.genes_dir, geneName);

    if (options.fromClawhub) {
      const slug = options.fromClawhub;
      display.info(`Fetching ClawHub skill metadata: ${slug}`);
      let info: ClawHubSkillInfo;
      try {
        info = await fetchClawHubInfo(slug);
      } catch (e) {
        display.rustStyleError({
          code: "E0010",
          message: `ClawHub skill '${slug}' not found or API error`,
          file: `${CLAWHUB_API}?slug=${slug}`,
          suggestion: "Check the slug at https://clawhub.ai/skills/<slug>",
          docsUrl: "https://rotifer.dev/docs/migration",
        });
        process.exit(1);
      }

      display.info(`Found: ${info.displayName} by @${info.owner.handle} (v${info.version}, ${info.stats.downloads.toLocaleString()} downloads)`);
      display.info("Downloading skill package...");

      let skillDir: string;
      try {
        skillDir = await downloadAndExtract(slug);
      } catch (e) {
        display.rustStyleError({
          code: "E0011",
          message: `Failed to download skill '${slug}'`,
          file: `${CLAWHUB_DOWNLOAD}?slug=${slug}`,
          suggestion: "The skill may have been delisted. Check its status on ClawHub.",
          docsUrl: "https://rotifer.dev/docs/migration",
        });
        process.exit(1);
      }

      const skillFile = join(skillDir, "SKILL.md");
      const metaFile = join(skillDir, "_meta.json");

      if (!existsSync(skillFile)) {
        display.rustStyleError({
          code: "E0012",
          message: "Downloaded package does not contain SKILL.md",
          file: skillDir,
          suggestion: "This skill may use a non-standard format",
          docsUrl: "https://rotifer.dev/docs/migration",
        });
        process.exit(1);
      }

      const skillContent = readFileSync(skillFile, "utf-8");
      const clawFrontmatter = parseClawHubFrontmatter(skillContent);
      const metaJson = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, "utf-8")) : {};

      const description = info.summary || (clawFrontmatter.description as string) || `${info.displayName} skill`;
      const resolvedDomain = await resolveDomain(geneName, options.domain, config.default_domain || "general", description);

      const fidelityLevel = determineFidelity(skillDir);
      const permissions = (clawFrontmatter.permissions as string[]) || [];

      const phenotype: Record<string, unknown> = {
        domain: resolvedDomain,
        description,
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: [] as string[] },
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
        dependencies: [] as string[],
        version: info.version || metaJson.version || "0.1.0",
        author: config.author,
        createdAt: new Date().toISOString(),
        fidelity: fidelityLevel,
        transparency: "Open",
        source: "clawhub",
        clawhub: {
          slug: info.slug,
          originalAuthor: info.owner.handle,
          originalName: info.displayName,
          downloads: info.stats.downloads,
          stars: info.stats.stars,
          versions: info.stats.versions,
          migratedAt: new Date().toISOString(),
        },
      };

      if (permissions.includes("network") || fidelityLevel === "Hybrid") {
        phenotype.fidelity = "Hybrid";
        phenotype.network = {
          allowedDomains: [],
          maxTimeoutMs: 30000,
          maxResponseBytes: 1048576,
          maxRequestsPerMin: 10,
        };
      }

      if (!existsSync(geneDir)) {
        mkdirSync(geneDir, { recursive: true });
      }

      const geneId = contentHash(phenotype);
      const phenotypeStr = JSON.stringify(phenotype, null, 2);
      writeFileSync(join(geneDir, "phenotype.json"), phenotypeStr + "\n");

      copyDirRecursive(skillDir, geneDir);

      if (existsSync(join(geneDir, "_meta.json"))) {
        const clawMeta = JSON.parse(readFileSync(join(geneDir, "_meta.json"), "utf-8"));
        writeFileSync(join(geneDir, ".clawhub-origin.json"), JSON.stringify(clawMeta, null, 2) + "\n");
      }

      writeFileSync(
        join(geneDir, ".gene-manifest.json"),
        JSON.stringify(
          {
            geneId, name: geneName, domain: resolvedDomain,
            fidelity: phenotype.fidelity as string,
            wrappedAt: new Date().toISOString(),
            fromClawhub: slug,
            clawhubVersion: info.version,
          },
          null,
          2
        ) + "\n"
      );

      const fileCount = countFiles(geneDir);
      display.success(`ClawHub skill '${info.displayName}' → Gene '${geneName}'`);
      display.keyValue("Gene ID", c.warn(geneId));
      display.keyValue("Domain", resolvedDomain);
      display.keyValue("Fidelity", phenotype.fidelity as string);
      display.keyValue("Files", `${fileCount} migrated`);
      display.keyValue("ClawHub", `@${info.owner.handle} · ${info.stats.downloads.toLocaleString()} downloads · ★${info.stats.stars}`);
      console.log();
      display.hint("Next steps:");
      display.hint("  rotifer compile " + geneName + "       # validate phenotype");
      display.hint("  rotifer vg " + geneName + "            # security scan");
      display.hint("  rotifer arena submit " + geneName + "  # compete in Arena");
      await offerAutoPublish({ geneName, geneDir, fidelity: resolveWrapFidelity(phenotype, options.fidelity) });
      return;
    }

    if (options.fromSkill) {
      const skillPath = resolve(root, options.fromSkill);
      const skillFile = skillPath.endsWith("SKILL.md") ? skillPath : join(skillPath, "SKILL.md");
      if (!existsSync(skillFile)) {
        display.rustStyleError({
          code: "E0002",
          message: `SKILL.md not found`,
          file: skillFile,
          suggestion: "Provide path to a SKILL.md file or a directory containing SKILL.md",
          docsUrl: "https://rotifer.dev/docs/genes",
        });
        process.exit(1);
      }
      const content = readFileSync(skillFile, "utf-8");
      const parsed = parseSkillFrontmatter(content);
      if (!parsed) {
        display.rustStyleError({
          code: "E0003",
          message: "Invalid SKILL.md: missing YAML frontmatter with 'name'",
          file: skillFile,
          suggestion: "Ensure the file starts with --- and has name: <id>",
          docsUrl: "https://rotifer.dev/docs/genes",
        });
        process.exit(1);
      }
      if (!existsSync(geneDir)) {
        mkdirSync(geneDir, { recursive: true });
      }
      const phenotype: Record<string, unknown> = {
        domain,
        description: parsed.description || `${parsed.name} skill wrapped as gene`,
        inputSchema: { type: "object", properties: { prompt: { type: "string" } }, required: [] as string[] },
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
        dependencies: [] as string[],
        version: "0.1.0",
        author: config.author,
        createdAt: new Date().toISOString(),
        fidelity: options.fidelity,
        transparency: "Open",
        source: "skill" as const,
      };
      if (options.fidelity === "Hybrid") {
        phenotype.network = {
          allowedDomains: [],
          maxTimeoutMs: 30000,
          maxResponseBytes: 1048576,
          maxRequestsPerMin: 10,
        };
      }
      const geneId = contentHash(phenotype);
      const phenotypeStr = JSON.stringify(phenotype, null, 2);
      writeFileSync(join(geneDir, "phenotype.json"), phenotypeStr + "\n");
      copyFileSync(skillFile, join(geneDir, "SKILL.md"));
      writeFileSync(
        join(geneDir, ".gene-manifest.json"),
        JSON.stringify(
          { geneId, name: geneName, domain, fidelity: options.fidelity, wrappedAt: new Date().toISOString(), fromSkill: relative(root, skillFile) },
          null,
          2
        ) + "\n"
      );
      display.success(`Skill '${parsed.name}' wrapped as gene '${geneName}'`);
      display.keyValue("Gene ID", c.warn(geneId));
      display.keyValue("Domain", domain);
      display.keyValue("Fidelity", options.fidelity);
      console.log();
      display.hint("Next steps:");
      display.hint("  rotifer compile " + geneName + "       # validate phenotype");
      display.hint("  rotifer vg " + geneName + "            # security scan");
      display.hint("  rotifer arena submit " + geneName + "  # compete in Arena");
      await offerAutoPublish({ geneName, geneDir, fidelity: resolveWrapFidelity(phenotype, options.fidelity) });
      return;
    }

    if (!existsSync(geneDir)) {
      display.rustStyleError({
        code: "E0001",
        message: `Gene directory '${geneName}' not found`,
        file: geneDir,
        suggestion: `Create the directory first: mkdir -p ${geneDir}`,
        docsUrl: "https://rotifer.dev/docs/genes",
      });
      process.exit(1);
    }

    const phenotypePath = join(geneDir, "phenotype.json");
    let phenotype: Record<string, unknown>;

    if (existsSync(phenotypePath)) {
      phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
      phenotype.domain = domain;
    } else {
      phenotype = {
        domain,
        inputSchema: { type: "object", properties: {}, required: [] },
        outputSchema: { type: "object" },
        dependencies: [],
        version: "0.1.0",
        author: config.author,
        createdAt: new Date().toISOString(),
        fidelity: options.fidelity,
        transparency: "Open",
      };
      if (options.fidelity === "Hybrid") {
        phenotype.network = {
          allowedDomains: [],
          maxTimeoutMs: 30000,
          maxResponseBytes: 1048576,
          maxRequestsPerMin: 10,
        };
      }
    }

    const version: string = (phenotype.version as string) || "0.1.0";
    if (!/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/.test(version)) {
      display.error(
        `Invalid version format '${version}'. Use semver (e.g., '1.0.0', '0.1.0-beta.1').`
      );
      process.exit(1);
    }

    const geneId = contentHash(phenotype);
    const phenotypeStr = JSON.stringify(phenotype, null, 2);

    writeFileSync(phenotypePath, phenotypeStr + "\n");
    writeFileSync(
      join(geneDir, ".gene-manifest.json"),
      JSON.stringify({ geneId, name: geneName, domain, fidelity: options.fidelity, wrappedAt: new Date().toISOString() }, null, 2) + "\n"
    );

    display.success(`Gene '${geneName}' wrapped successfully`);
    display.keyValue("Gene ID", c.warn(geneId));
    display.keyValue("Domain", domain);
    display.keyValue("Fidelity", options.fidelity);

    console.log();
    display.hint("Next steps:");
    display.hint("  rotifer compile " + geneName + "          # Wrapped fidelity");
    display.hint("  rotifer compile " + geneName + " --wasm <file>  # Native fidelity (with WASM)");
    display.hint("  rotifer vg " + geneName + "               # security scan");
    display.hint("  rotifer arena submit " + geneName + "     # compete in Arena");
    // Not options.fidelity: when phenotype.json already existed on disk (a
    // re-wrap — e.g. just to change --domain), its fidelity was left as-is
    // above and can differ from the CLI flag's default. Offering to publish
    // based on the flag let a Native gene missing gene.ir.wasm show the
    // prompt, get a "yes", and only then fail inside publishSingleGene —
    // found by an independent cursor-agent pyramid test run, 2026-08-31.
    await offerAutoPublish({ geneName, geneDir, fidelity: resolveWrapFidelity(phenotype, options.fidelity) });
  });
