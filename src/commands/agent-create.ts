import { Command } from "commander";
import {
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import * as display from "../utils/display.js";
import { getProjectRoot, loadConfig } from "../utils/config.js";

export const agentCreateCommand = new Command("create")
  .description("Create a new Agent with a genome of genes")
  .argument("<name>", "agent name")
  .option("-g, --genes <genes...>", "gene names to include in genome")
  .option("-d, --domain <domain>", "auto-select top genes from this domain")
  .option("-n, --top <n>", "number of top genes to auto-select", "2")
  .option("--strategy <strategy>", "gene selection strategy", "greedy")
  .option(
    "--composition <type>",
    "composition type: Seq, Par, Cond, Try",
    "Seq"
  )
  .option("--par-merge <strategy>", "merge strategy for Par: first, concat, merge", "first")
  .action(
    async (
      name: string,
      options: {
        genes?: string[];
        domain?: string;
        top: string;
        strategy: string;
        composition: string;
        parMerge: string;
      }
    ) => {
      const root = getProjectRoot();
      const config = loadConfig(root);

      display.header("Agent Creation");

      const agentsDir = join(root, ".rotifer", "agents");
      mkdirSync(agentsDir, { recursive: true });

      const agentId = randomUUID();
      let genome: string[] = [];
      let selectionMode = "manual";

      if (options.genes && options.genes.length > 0) {
        // Manual gene selection
        for (const geneName of options.genes) {
          const geneDir = join(root, config.genes_dir, geneName);
          if (!existsSync(join(geneDir, "phenotype.json"))) {
            display.rustStyleError({
              code: "E0040",
              message: `Gene '${geneName}' not found or not wrapped`,
              file: join(geneDir, "phenotype.json"),
              suggestion: `Run 'rotifer wrap ${geneName} --domain <domain>' first`,
            });
            process.exit(1);
          }
          genome.push(geneName);
        }
      } else {
        // Auto-select from Arena rankings
        selectionMode = options.strategy;
        const topN = parseInt(options.top, 10) || 2;
        const ranked = getArenaRankings(root, config.genes_dir, options.domain);

        if (ranked.length === 0) {
          display.error(
            "No genes found in Arena" +
              (options.domain ? ` for domain '${options.domain}'` : "") +
              ". Submit genes first: rotifer arena submit <gene>"
          );
          process.exit(1);
        }

        genome = ranked.slice(0, topN).map((r) => r.name);
        display.info(
          `Auto-selected top ${genome.length} gene(s) from Arena` +
            (options.domain ? ` (domain: ${options.domain})` : "") +
            ` [strategy: ${selectionMode}]`
        );
      }

      // Schema compatibility pre-check for Seq pipelines
      if (genome.length >= 2) {
        const schemaWarnings = checkSchemaCompatibility(root, config.genes_dir, genome);
        if (schemaWarnings.length > 0) {
          display.warn("Schema compatibility warnings:");
          for (const w of schemaWarnings) {
            display.warn(`  ${w}`);
          }
          console.log();
        }
      }

      const requestedComposition = options.composition || "Seq";
      const compositionType = genome.length >= 2 ? requestedComposition : "Single";

      let composition: Record<string, unknown> = { type: compositionType };
      if (compositionType === "Par") {
        composition = {
          type: "Par",
          branches: genome,
          merge: options.parMerge || "first",
        };
      } else if (compositionType === "Cond" && genome.length >= 2) {
        composition = {
          type: "Cond",
          predicate: { field: "type", equals: "primary" },
          thenBranch: genome[0],
          elseBranch: genome[1],
        };
      } else if (compositionType === "Try" && genome.length >= 2) {
        composition = {
          type: "Try",
          primary: genome[0],
          fallback: genome[1],
        };
      }

      const agent = {
        id: agentId,
        name,
        state: "Active",
        genome,
        composition,
        strategy: selectionMode,
        createdAt: new Date().toISOString(),
        reputation: 0.0,
      };

      writeFileSync(
        join(agentsDir, agentId + ".json"),
        JSON.stringify(agent, null, 2) + "\n"
      );

      display.success(`Agent '${name}' created`);
      display.keyValue("Agent ID", agentId.slice(0, 12) + "...");
      display.keyValue("State", agent.state);
      display.keyValue("Strategy", selectionMode);
      const separator = compositionType === "Par" ? " ∥ " : " → ";
      display.keyValue(
        "Genome",
        genome.length > 0
          ? genome.join(separator) + ` (${compositionType})`
          : "(empty)"
      );

      console.log();
      if (genome.length >= 2) {
        display.info(
          `Run: rotifer agent run ${name}  — execute the ${compositionType} pipeline`
        );
      }
      display.info("View agents: rotifer agent list");
    }
  );

interface RankedGene {
  name: string;
  domain: string;
  fitness: number;
  fidelity: string;
}

function getArenaRankings(
  root: string,
  genesDir: string,
  domainFilter?: string
): RankedGene[] {
  const dir = join(root, genesDir);
  if (!existsSync(dir)) return [];

  const entries: RankedGene[] = [];

  for (const name of readdirSync(dir)) {
    const phenotypePath = join(dir, name, "phenotype.json");
    if (!existsSync(phenotypePath)) continue;

    try {
      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
      if (domainFilter && phenotype.domain !== domainFilter) continue;

      const phenoStr = JSON.stringify(phenotype);
      const geneId = createHash("sha256").update(phenoStr).digest("hex");
      const seed = parseInt(geneId.slice(0, 8), 16);
      const isNative = phenotype.fidelity === "Native";
      const baseFitness = isNative ? 0.7 : 0.45;
      const variance = (seed % 250) / 1000;

      entries.push({
        name,
        domain: phenotype.domain || "general",
        fitness: Math.min(baseFitness + variance, 0.99),
        fidelity: phenotype.fidelity || "Wrapped",
      });
    } catch {
      // skip malformed
    }
  }

  entries.sort((a, b) => b.fitness - a.fitness);
  return entries;
}

type SchemaCheckResult = "PASS" | "UNCHECKED" | "FAIL";

interface SchemaCheckEntry {
  producer: string;
  consumer: string;
  result: SchemaCheckResult;
  detail: string;
}

function isSubtype(
  producerType: string | undefined,
  consumerType: string | undefined,
): boolean {
  if (!consumerType || !producerType) return true;
  if (consumerType === producerType) return true;
  if (consumerType === "number" && producerType === "integer") return true;
  return false;
}

function checkSchemaCompatibility(
  root: string,
  genesDir: string,
  genome: string[],
): string[] {
  const warnings: string[] = [];
  const results: SchemaCheckEntry[] = [];

  for (let i = 0; i < genome.length - 1; i++) {
    const producerName = genome[i];
    const consumerName = genome[i + 1];
    const producerPhenoPath = join(root, genesDir, producerName, "phenotype.json");
    const consumerPhenoPath = join(root, genesDir, consumerName, "phenotype.json");

    if (!existsSync(producerPhenoPath) || !existsSync(consumerPhenoPath)) {
      results.push({
        producer: producerName,
        consumer: consumerName,
        result: "UNCHECKED",
        detail: "phenotype.json missing for one or both genes",
      });
      warnings.push(
        `${producerName} → ${consumerName}: UNCHECKED (phenotype.json missing)`,
      );
      continue;
    }

    try {
      const producer = JSON.parse(readFileSync(producerPhenoPath, "utf-8"));
      const consumer = JSON.parse(readFileSync(consumerPhenoPath, "utf-8"));

      const outputSchema = producer.outputSchema;
      const inputSchema = consumer.inputSchema;

      if (!outputSchema?.properties || !inputSchema) {
        results.push({
          producer: producerName,
          consumer: consumerName,
          result: "UNCHECKED",
          detail: "schema properties not defined",
        });
        continue;
      }

      const outputProps = outputSchema.properties;
      const requiredInputs: string[] = inputSchema.required || [];
      const inputProps = inputSchema.properties || {};

      const missingFields = requiredInputs.filter(
        (field: string) => !(field in outputProps),
      );

      const typeMismatches: string[] = [];
      for (const field of Object.keys(inputProps)) {
        if (field in outputProps) {
          const outType = outputProps[field]?.type;
          const inType = inputProps[field]?.type;
          if (!isSubtype(outType, inType)) {
            typeMismatches.push(`${field}: ${outType} ≠ ${inType}`);
          }
        }
      }

      if (missingFields.length > 0 || typeMismatches.length > 0) {
        const details: string[] = [];
        if (missingFields.length > 0)
          details.push(`missing: [${missingFields.join(", ")}]`);
        if (typeMismatches.length > 0)
          details.push(`type mismatch: [${typeMismatches.join("; ")}]`);

        results.push({
          producer: producerName,
          consumer: consumerName,
          result: "FAIL",
          detail: details.join(", "),
        });
        warnings.push(
          `${producerName} → ${consumerName}: FAIL — ${details.join(", ")}`,
        );
      } else {
        results.push({
          producer: producerName,
          consumer: consumerName,
          result: "PASS",
          detail: "structural subtype check passed",
        });
      }
    } catch {
      results.push({
        producer: producerName,
        consumer: consumerName,
        result: "UNCHECKED",
        detail: "failed to parse phenotype.json",
      });
    }
  }

  return warnings;
}
