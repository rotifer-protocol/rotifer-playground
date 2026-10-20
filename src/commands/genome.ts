import { Command } from "commander";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as display from "../utils/display.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { geneIdV2 } from "../utils/binding.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { loadCredentials } from "../cloud/auth.js";
import type { AgentRecord } from "./agent-create.js";
import {
  BINDING_NAME,
  BLUEPRINT_FORMAT,
  BLUEPRINT_PROTOCOL_VERSION,
  COMPARE_OPS,
  DEFAULT_MIN_FITNESS,
  GENE_ID_V2,
  GenomeImportError,
  MIN_VG_FLOOR,
  parseBlueprint,
  scanBlueprint,
  type AlgebraExpr,
  type CapabilityQuery,
  type CredentialFinding,
  type CredentialLayer,
  type GeneReference,
  type GenomeBlueprint,
  type ResolutionHint,
} from "./genome-format.js";

export * from "./genome-format.js";

export interface RoleSummary {
  role: string;
  geneId: string;
  fidelity: string;
  hasHints: boolean;
}

export class GenomeExportError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly findings?: CredentialFinding[],
  ) {
    super(message);
    this.name = "GenomeExportError";
  }
}

// ── Agent lookup ─────────────────────────────────────────────

/** Find a local agent by id, or by name when the name is unique. */
export function findAgent(root: string, ref: string): AgentRecord {
  const agentsDir = join(root, ".rotifer", "agents");
  const records: AgentRecord[] = existsSync(agentsDir)
    ? readdirSync(agentsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(readFileSync(join(agentsDir, f), "utf-8")) as AgentRecord)
    : [];

  const byId = records.find((a) => a.id === ref);
  if (byId) return byId;

  const byName = records.filter((a) => a.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new GenomeExportError(
      `${byName.length} agents are named '${ref}'`,
      `Pass one of their ids instead: ${byName.map((a) => a.id).join(", ")}`,
    );
  }
  throw new GenomeExportError(`Agent '${ref}' not found`, "List local agents: rotifer agent list");
}

// ── Composition ──────────────────────────────────────────────

type LocalComposition = {
  type?: string;
  merge?: string;
  predicate?: { field?: string; op?: string; value?: unknown; equals?: unknown };
};

/** Composition type exactly as `agent run` derives it. */
export function compositionTypeOf(agent: AgentRecord): string {
  const comp = agent.composition as unknown;
  const declared = typeof comp === "object" && comp !== null ? (comp as LocalComposition).type : comp;
  return (typeof declared === "string" && declared) || (agent.genome.length >= 2 ? "Seq" : "Single");
}

function outsideSubset(type: string, why: string): GenomeExportError {
  return new GenomeExportError(
    `Composition '${type}' cannot be exported: ${why}`,
    "v0.9.2 exports only what 'rotifer agent run' executes faithfully: " +
      "Single (1 gene), Seq, Par (2+ genes), Cond and Try (exactly 2 genes).",
  );
}

/**
 * Map the agent's composition onto §15.2, limited to what `agent run` executes:
 * branches are single genes, Par/Cond/Try take the genome in order. Anything
 * else fails rather than being approximated.
 */
export function buildComposition(
  agent: AgentRecord,
  refs: GeneReference[],
): { composition: AlgebraExpr; parMerge?: string } {
  const type = compositionTypeOf(agent);
  const comp = (typeof agent.composition === "object" ? agent.composition : {}) as LocalComposition;
  const leaf = (i: number): AlgebraExpr => ({ Gene: { geneRef: refs[i] } });
  const n = refs.length;

  switch (type) {
    case "Single":
      if (n !== 1) throw outsideSubset(type, `needs exactly 1 gene, the genome has ${n}`);
      return { composition: leaf(0) };
    case "Seq":
      if (n < 1) throw outsideSubset(type, "the genome is empty");
      return { composition: { Seq: { steps: refs.map((_, i) => leaf(i)) } } };
    case "Par": {
      if (n < 2) throw outsideSubset(type, `needs at least 2 genes, the genome has ${n}`);
      // Right-associative: [a, b, c] → Par(a, Par(b, c)). No deadline — `agent run` has none.
      let expr = leaf(n - 1);
      for (let i = n - 2; i >= 0; i--) expr = { Par: { left: leaf(i), right: expr } };
      return { composition: expr, parMerge: comp.merge || "first" };
    }
    case "Cond": {
      if (n !== 2) throw outsideSubset(type, `needs exactly 2 genes, the genome has ${n}`);
      // Same defaults `agent run` applies to a missing predicate.
      const pred = comp.predicate ?? {};
      const op = pred.op || "Eq";
      const operator = COMPARE_OPS[op];
      if (!operator) {
        throw outsideSubset(type, `unknown predicate operator '${op}' (expected one of ${Object.keys(COMPARE_OPS).join(", ")})`);
      }
      return {
        composition: {
          Cond: {
            predicate: { field: pred.field || "type", operator, value: pred.value ?? pred.equals ?? "primary" },
            ifTrue: leaf(0),
            ifFalse: leaf(1),
          },
        },
      };
    }
    case "Try":
      if (n !== 2) throw outsideSubset(type, `needs exactly 2 genes, the genome has ${n}`);
      return { composition: { TryCatch: { body: leaf(0), handler: leaf(1) } } };
    default:
      throw outsideSubset(type, "§15.2 has no such operator, or it is outside the v0.9.2 executable subset");
  }
}

// ── Blueprint assembly ───────────────────────────────────────

export interface BuildBlueprintInput {
  root: string;
  genesDir: string;
  agent: AgentRecord;
  lock?: boolean;
  minFitness?: number;
  minVg?: number;
  description?: string;
  author?: string;
  now?: Date;
}

export interface BuildBlueprintResult {
  blueprint: GenomeBlueprint;
  roles: RoleSummary[];
  notices: string[];
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hintForUncomputableId(gene: string, reason: string): string {
  if (/ir\.wasm|rotifer\.version|rotifer\.constraints/.test(reason)) {
    return `Compile it first: rotifer compile ${gene}`;
  }
  if (/fidelity/.test(reason)) return `Re-wrap it so phenotype.json declares a fidelity: rotifer wrap ${gene}`;
  return "See docs/gene-id-v2.md §5 for what makes a gene ID computable.";
}

function checkUnitInterval(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new GenomeExportError(`${name} must be a number between 0 and 1`);
  }
}

export function buildBlueprint(input: BuildBlueprintInput): BuildBlueprintResult {
  const { root, genesDir, agent } = input;
  const genesRoot = join(root, genesDir);
  const notices: string[] = [];

  checkUnitInterval("--min-fitness", input.minFitness);
  if (input.minVg !== undefined) {
    if (!Number.isFinite(input.minVg) || input.minVg < MIN_VG_FLOOR || input.minVg >= 1) {
      throw new GenomeExportError(
        `--min-vg must be in [${MIN_VG_FLOOR}, 1.0)`,
        "§5.1 does not allow a V(g) threshold below 0.5.",
      );
    }
  }

  if (!Array.isArray(agent.genome) || agent.genome.length === 0) {
    throw new GenomeExportError(`Agent '${agent.name}' has an empty genome`);
  }
  const seen = new Set<string>();
  for (const gene of agent.genome) {
    if (seen.has(gene)) {
      throw new GenomeExportError(
        `Gene '${gene}' appears more than once in the genome`,
        "A Blueprint keys each role by gene name, so every gene can appear only once.",
      );
    }
    seen.add(gene);
  }

  const refs: GeneReference[] = [];
  const roles: RoleSummary[] = [];
  const capabilities: Record<string, CapabilityQuery> = {};
  const hints: Record<string, ResolutionHint> = {};

  for (const gene of agent.genome) {
    try {
      validateGeneName(gene);
    } catch (err) {
      throw new GenomeExportError((err as Error).message);
    }
    const geneDir = join(genesRoot, gene);
    const phenotype = readJson(join(geneDir, "phenotype.json"));
    if (!phenotype) {
      throw new GenomeExportError(
        `Gene '${gene}' has no readable phenotype.json under ${genesDir}/`,
        `Install or wrap it first: rotifer install ${gene}  or  rotifer wrap ${gene}`,
      );
    }

    const idResult = geneIdV2(genesRoot, gene);
    if (!("id" in idResult)) {
      throw new GenomeExportError(
        `Gene '${gene}' has no v2 gene ID: ${idResult.reason}`,
        hintForUncomputableId(gene, idResult.reason),
      );
    }
    if (!GENE_ID_V2.test(idResult.id)) {
      throw new GenomeExportError(`Gene '${gene}' got a malformed v2 gene ID from the native module`);
    }

    refs.push({ geneId: idResult.id, role: gene, optional: false });

    const fidelity = typeof phenotype.fidelity === "string" ? phenotype.fidelity : "";
    const isWrapped = fidelity.toLowerCase() === "wrapped";

    if (!input.lock) {
      if (typeof phenotype.domain === "string" && phenotype.domain) {
        capabilities[gene] = {
          domain: phenotype.domain,
          inputSchemaCompat: phenotype.inputSchema ?? {},
          outputSchemaCompat: phenotype.outputSchema ?? {},
          minFitness: input.minFitness ?? DEFAULT_MIN_FITNESS,
        };
      } else {
        notices.push(`Gene '${gene}' declares no domain — the receiver can only import it by gene ID.`);
      }
    }

    const manifest = readJson(join(geneDir, ".cloud-manifest.json"));
    const owner = manifest?.owner;
    const version = manifest?.version;
    let hasHints = false;
    if (typeof owner === "string" && owner && typeof version === "string" && version && fidelity) {
      hints[gene] = {
        owner,
        name: gene,
        version,
        ...(typeof manifest?.cloud_id === "string" && manifest.cloud_id ? { cloudId: manifest.cloud_id } : {}),
        fidelity,
      };
      hasHints = true;
    } else {
      notices.push(
        input.lock
          ? `Gene '${gene}' was never published or installed from the Registry — the receiver has no way to fetch it.`
          : `Gene '${gene}' was never published or installed from the Registry — the receiver can only find a substitute by capability.`,
      );
    }

    if (isWrapped) {
      notices.push(
        `Gene '${gene}' is Wrapped: in v0.9.2 the receiver cannot install Wrapped genes from the Registry ` +
          "(their source is not distributed there), only find a Native/Hybrid substitute by capability.",
      );
    }

    roles.push({ role: gene, geneId: idResult.id, fidelity, hasHints });
  }

  const { composition, parMerge } = buildComposition(agent, refs);

  const extension: Record<string, unknown> = {};
  if (parMerge !== undefined) extension.parMerge = parMerge;
  if (input.minVg !== undefined) extension.minVg = input.minVg;

  const now = (input.now ?? new Date()).toISOString();
  const blueprint: GenomeBlueprint = {
    blueprintFormat: BLUEPRINT_FORMAT,
    protocolVersion: { ...BLUEPRINT_PROTOCOL_VERSION, supportedFeatures: ["GENE_COMPOSITION_ALGEBRA"] },
    snapshot: { genes: refs, composition, snapshotAt: now },
    metadata: {
      name: agent.name,
      ...(input.description ? { description: input.description } : {}),
      ...(input.author ? { author: input.author } : {}),
      createdAt: now,
    },
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(Object.keys(hints).length > 0 ? { resolutionHints: hints } : {}),
    ...(Object.keys(extension).length > 0 ? { bindingExtensions: { [BINDING_NAME]: extension } } : {}),
  };

  return { blueprint, roles, notices };
}

// ── Export ───────────────────────────────────────────────────

export interface ExportGenomeInput extends BuildBlueprintInput {
  output: string;
}

export interface ExportGenomeResult {
  file: string;
  agent: string;
  composition: string;
  geneCount: number;
  mode: "capability" | "lock";
  roles: RoleSummary[];
  notices: string[];
  credentialScan: { passed: true; layers: CredentialLayer[] };
}

/**
 * Build, scan, and write a Blueprint. Nothing is written when the scan finds
 * anything, or when this CLI's own import would refuse the file: the reader's
 * rules (Cond forms, numbers, strings, required fields) run on the exact text.
 */
export function exportGenome(input: ExportGenomeInput): ExportGenomeResult {
  const { blueprint, roles, notices } = buildBlueprint(input);

  const findings = scanBlueprint(blueprint);
  if (findings.length > 0) {
    throw new GenomeExportError(
      `Credential scan blocked the export: ${findings.length} finding(s); nothing was written`,
      "Remove the flagged values (shown by position only) and export again.",
      findings,
    );
  }

  const text = JSON.stringify(blueprint, null, 2) + "\n";
  try {
    parseBlueprint(text);
  } catch (err) {
    if (!(err instanceof GenomeImportError)) throw err;
    throw new GenomeExportError(`The Blueprint would not import, so nothing was written: ${err.message}`, err.hint);
  }
  writeFileSync(input.output, text);

  return {
    file: input.output,
    agent: input.agent.name,
    composition: compositionTypeOf(input.agent),
    geneCount: blueprint.snapshot.genes.length,
    mode: blueprint.capabilities ? "capability" : "lock",
    roles,
    notices,
    credentialScan: { passed: true, layers: ["key-name", "value-pattern", "entropy"] },
  };
}

// ── CLI ──────────────────────────────────────────────────────

export interface GenomeExportOptions {
  output?: string;
  lock?: boolean;
  minFitness?: string;
  minVg?: string;
  description?: string;
}

function parseNumberOption(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new GenomeExportError(`${flag} must be a number, got '${raw}'`);
  return n;
}

function reportFailure(err: GenomeExportError): void {
  if (display.isJsonMode()) {
    process.stdout.write(
      JSON.stringify({ ok: false, error: err.message, hint: err.hint, findings: err.findings }, null, 2) + "\n",
    );
    return;
  }
  display.error(err.message, err.hint);
  for (const f of err.findings ?? []) {
    console.error(`    ${f.pointer || "/"}  [${f.layer}] ${f.rule}`);
  }
}

/** Run `genome export`; returns the process exit code. */
export function runGenomeExport(
  agentRef: string,
  options: GenomeExportOptions,
  ctx: { root: string; genesDir: string; author?: string },
): number {
  try {
    const agent = findAgent(ctx.root, agentRef);
    const output = resolve(options.output ?? `${agent.name}.rgenome`);
    const result = exportGenome({
      root: ctx.root,
      genesDir: ctx.genesDir,
      agent,
      lock: options.lock,
      minFitness: parseNumberOption("--min-fitness", options.minFitness),
      minVg: parseNumberOption("--min-vg", options.minVg),
      description: options.description,
      author: ctx.author,
      output,
    });

    display.renderResult({ ok: true, ...result }, (r) => {
      display.header("Genome Export");
      display.keyValue("Agent", r.agent);
      display.keyValue("Composition", r.composition);
      display.keyValue("Mode", r.mode === "lock" ? "lock (gene IDs only)" : "capability + gene IDs");
      for (const role of r.roles) {
        display.keyValue(`  ${role.role}`, `${role.geneId}  ${role.fidelity}${role.hasHints ? "" : "  (no Registry hints)"}`);
      }
      for (const n of r.notices) display.warn(n);
      display.success("Credential scan passed (key names, value patterns, entropy)");
      display.success(`Wrote ${r.file}`);
    });
    return 0;
  } catch (err) {
    if (err instanceof GenomeExportError) {
      reportFailure(err);
      return 1;
    }
    throw err;
  }
}

const genomeExportCommand = new Command("export")
  .description("Export an agent's genome as a shareable Blueprint (.rgenome)")
  .argument("<agent>", "agent name or id")
  .option("-o, --output <file>", "output file (default: <agent>.rgenome)")
  .option("--lock", "reference genes by ID only; write no capability queries")
  .option("--min-fitness <n>", `minimum fitness in each capability query (default: ${DEFAULT_MIN_FITNESS})`)
  .option("--min-vg <n>", `suggested minimum V(g) for importers, in [${MIN_VG_FLOOR}, 1.0)`)
  .option("-d, --description <text>", "description stored in the Blueprint metadata")
  .action((agentRef: string, options: GenomeExportOptions) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);
    const author = loadCredentials()?.user?.username;
    process.exitCode = runGenomeExport(agentRef, options, { root, genesDir: config.genes_dir, author });
  });

export const genomeCommand = new Command("genome")
  .description("Genome Blueprint commands: export an agent's genome, import one")
  .addCommand(genomeExportCommand);
