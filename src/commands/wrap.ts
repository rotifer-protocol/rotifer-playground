import { Command } from "commander";
import { writeFileSync, existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";
import { parseSkillFrontmatter } from "./scan.js";
import { suggestDomains } from "../utils/domain-suggest.js";

async function resolveDomain(
  name: string,
  explicitDomain: string | undefined,
  defaultDomain: string,
  description?: string
): Promise<string> {
  if (explicitDomain) return explicitDomain;

  const suggestions = suggestDomains(name, description);
  if (suggestions.length === 0) return defaultDomain;

  if (!process.stdin.isTTY) {
    const best = suggestions[0].domain;
    return best;
  }

  console.log();
  display.info("Suggested domains based on gene name:");
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
  .description("Wrap a function as a Rotifer gene (generates Phenotype), or a SKILL.md as a gene")
  .argument("<name>", "function/gene directory name, or gene name when using --from-skill")
  .option("-d, --domain <domain>", "gene functional domain")
  .option("--fidelity <level>", "fidelity level", "Wrapped")
  .option("--from-skill <path>", "create gene from a SKILL.md file (path to SKILL.md or its directory)")
  .action(async (name: string, options: { domain?: string; fidelity: string; fromSkill?: string }) => {
    const root = getProjectRoot();
    const config = loadConfig(root);
    const domain = await resolveDomain(name, options.domain, config.default_domain || "general");

    display.header("Gene Wrapper");

    const geneDir = join(root, config.genes_dir, name);

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
        createdAt: Date.now(),
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
      const phenotypeStr = JSON.stringify(phenotype, null, 2);
      const geneId = createHash("sha256").update(phenotypeStr).digest("hex");
      writeFileSync(join(geneDir, "phenotype.json"), phenotypeStr + "\n");
      copyFileSync(skillFile, join(geneDir, "SKILL.md"));
      writeFileSync(
        join(geneDir, ".gene-manifest.json"),
        JSON.stringify(
          { geneId, name, domain, fidelity: options.fidelity, wrappedAt: new Date().toISOString(), fromSkill: relative(root, skillFile) },
          null,
          2
        ) + "\n"
      );
      display.success(`Skill '${parsed.name}' wrapped as gene '${name}'`);
      display.keyValue("Gene ID", display.geneId(geneId));
      display.keyValue("Domain", domain);
      display.keyValue("Fidelity", options.fidelity);
      console.log();
      display.info("Next steps:");
      display.info("  rotifer compile " + name + "   # validate (Wrapped, no WASM)");
      display.info("  rotifer publish " + name + "  # upload to Rotifer Cloud");
      return;
    }

    if (!existsSync(geneDir)) {
      display.rustStyleError({
        code: "E0001",
        message: `Gene directory '${name}' not found`,
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
        createdAt: Date.now(),
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

    const phenotypeStr = JSON.stringify(phenotype, null, 2);
    const geneId = createHash("sha256").update(phenotypeStr).digest("hex");

    writeFileSync(phenotypePath, phenotypeStr + "\n");
    writeFileSync(
      join(geneDir, ".gene-manifest.json"),
      JSON.stringify({ geneId, name, domain, fidelity: options.fidelity, wrappedAt: new Date().toISOString() }, null, 2) + "\n"
    );

    display.success(`Gene '${name}' wrapped successfully`);
    display.keyValue("Gene ID", display.geneId(geneId));
    display.keyValue("Domain", domain);
    display.keyValue("Fidelity", options.fidelity);

    console.log();
    display.info("Next steps:");
    display.info("  rotifer test " + name);
    display.info("  rotifer compile " + name + "          # Wrapped fidelity");
    display.info("  rotifer compile " + name + " --wasm <file>  # Native fidelity (with WASM)");
  });
