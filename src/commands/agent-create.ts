import { Command } from "commander";
import {
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { contentHash } from "../utils/content-hash.js";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { applyFidelityDiscount, estimateBaseFitness } from "../utils/fidelity-discount.js";

export interface CreateAgentParams {
  root: string;
  genesDir: string;
  agentName: string;
  genome: string[];
  compositionType: string;
  parMerge?: string;
  strategy?: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  state: string;
  genome: string[];
  composition: Record<string, unknown>;
  strategy: string;
  createdAt: string;
  reputation: number;
}

export function createAgentCore(params: CreateAgentParams): AgentRecord {
  const { root, agentName, genome, parMerge } = params;

  for (const geneName of genome) {
    validateGeneName(geneName);
    const geneDir = join(root, params.genesDir, geneName);
    if (!existsSync(join(geneDir, "phenotype.json"))) {
      throw new Error(`Gene '${geneName}' not found or not wrapped`);
    }
  }

  if (genome.length >= 2) {
    const warnings = checkSchemaCompatibility(root, params.genesDir, genome);
    if (warnings.length > 0) {
      display.warn("Schema compatibility warnings:");
      for (const w of warnings) {
        display.warn(`  ${w}`);
      }
      console.log();
    }
  }

  const compositionType = genome.length >= 2 ? params.compositionType : "Single";
  let composition: Record<string, unknown> = { type: compositionType };

  if (compositionType === "Par") {
    composition = { type: "Par", branches: genome, merge: parMerge || "first" };
  } else if (compositionType === "Cond" && genome.length >= 2) {
    composition = {
      type: "Cond",
      predicate: { field: "type", equals: "primary" },
      thenBranch: genome[0],
      elseBranch: genome[1],
    };
  } else if (compositionType === "Try" && genome.length >= 2) {
    composition = { type: "Try", primary: genome[0], fallback: genome[1] };
  } else if (compositionType === "TryPool") {
    composition = { type: "TryPool" };
  }

  const agentId = randomUUID();
  const agent: AgentRecord = {
    id: agentId,
    name: agentName,
    state: "Active",
    genome,
    composition,
    strategy: params.strategy || "manual",
    createdAt: new Date().toISOString(),
    reputation: 0.0,
  };

  const agentsDir = join(root, ".rotifer", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    join(agentsDir, agentId + ".json"),
    JSON.stringify(agent, null, 2) + "\n"
  );

  return agent;
}

export const agentCreateCommand = new Command("create")
  .description("Create a new Agent with a genome of genes")
  .argument("<agent-name>", "agent name")
  .option("-g, --genes <genes...>", "gene names to include in genome")
  .option("-d, --domain <domain>", "auto-select top genes from this domain")
  .option("-n, --top <n>", "number of top genes to auto-select", "2")
  .option("--strategy <strategy>", "gene selection strategy", "greedy")
  .option(
    "--composition <type>",
    "composition type: Seq, Par, Cond, Try, TryPool",
    "Seq"
  )
  .option("--par-merge <strategy>", "merge strategy for Par: first, concat, merge", "first")
  .action(
    async (
      agentName: string,
      options: {
        genes?: string[];
        domain?: string;
        top: string;
        strategy: string;
        composition: string;
        parMerge: string;
      }
    ) => {
      const root = requireProjectRoot();
      const config = loadConfig(root);

      display.header("Agent Creation");

      let genome: string[] = [];
      let selectionMode = "manual";

      if (options.genes && options.genes.length > 0) {
        genome = options.genes;
      } else {
        selectionMode = options.strategy;
        const topN = parseInt(options.top, 10) || 2;
        const ranked = getArenaRankings(root, config.genes_dir, options.domain);

        if (ranked.length === 0) {
          display.error(
            "No genes found in Arena" +
              (options.domain ? ` for domain '${options.domain}'` : "")
          );
          display.hint("Submit genes first: rotifer arena submit <gene-name>");
          process.exit(1);
        }

        genome = ranked.slice(0, topN).map((r) => r.name);
        display.hint(
          `Auto-selected top ${genome.length} gene(s) from Arena` +
            (options.domain ? ` (domain: ${options.domain})` : "") +
            ` [strategy: ${selectionMode}]`
        );
      }

      try {
        const agent = createAgentCore({
          root,
          genesDir: config.genes_dir,
          agentName,
          genome,
          compositionType: options.composition || "Seq",
          parMerge: options.parMerge,
          strategy: selectionMode,
        });

        const compositionType = agent.composition.type as string;
        display.success(`Agent '${agentName}' created`);
        display.keyValue("Agent ID", c.warn(agent.id));
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
          display.hint(
            `Run: rotifer agent run ${agentName}  — execute the ${compositionType} pipeline`
          );
        }
        display.hint("View agents: rotifer agent list");
      } catch (err: any) {
        display.rustStyleError({
          code: "E0040",
          message: err.message,
          suggestion: "Ensure all genes exist and are wrapped",
        });
        process.exit(1);
      }
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

      const geneId = contentHash(phenotype);
      const seed = parseInt(geneId.slice(0, 8), 16);
      const { fitness: discountedFitness } = applyFidelityDiscount(estimateBaseFitness(geneId), phenotype.fidelity);

      entries.push({
        name,
        domain: phenotype.domain || "general",
        fitness: discountedFitness,
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
