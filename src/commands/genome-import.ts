import { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import * as display from "../utils/display.js";
import { loadConfig } from "../utils/config.js";
import { requireProjectRoot } from "../utils/project-root.js";
import { geneIdV2 } from "../utils/binding.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { getGene, listGeneVersions } from "../cloud/client.js";
import {
  EvidenceError,
  resolveCapabilityCandidates,
  type CandidateEvidence,
  type CandidateVerdict,
} from "../cloud/capability-candidates.js";
import { installGeneFromCloud } from "./install.js";
import { createAgentCore, type AgentRecord } from "./agent-create.js";
import {
  BINDING_NAME,
  BLUEPRINT_FORMAT,
  COMPARE_OPS,
  DEFAULT_MIN_FITNESS,
  GENE_ID_V2,
  MIN_VG_FLOOR,
  scanBlueprint,
  type AlgebraExpr,
  type CapabilityQuery,
  type GeneReference,
  type GenomeBlueprint,
  type ResolutionHint,
} from "./genome.js";

/** Recommended V_min of §5.1: the floor every capability selection must clear. */
export const DEFAULT_MIN_VG = 0.7;
export const DEFAULT_MAX_EVAL_AGE_DAYS = 90;

const PAR_MERGES = new Set(["first", "concat", "merge"]);

export class GenomeImportError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "GenomeImportError";
  }
}

// ── 1. Parse and validate ────────────────────────────────────

/** What `agent create` needs to rebuild the composition. */
export interface CompositionPlan {
  type: "Single" | "Seq" | "Par" | "Cond" | "Try";
  /** Roles in execution order (= the agent's genome order). */
  roles: string[];
  parMerge?: string;
  predicate?: { field: string; op: string; value: unknown };
}

export interface ParsedBlueprint {
  blueprint: GenomeBlueprint;
  plan: CompositionPlan;
  /** The author's suggested V(g) threshold, if any. */
  suggestedMinVg?: number;
}

const OPS_FROM_SPEC: Record<string, string> = Object.fromEntries(
  Object.entries(COMPARE_OPS).map(([local, spec]) => [spec, local]),
);

function outsideSubset(why: string): GenomeImportError {
  return new GenomeImportError(
    `Composition is outside the v0.9.2 executable subset: ${why}`,
    "v0.9.2 imports Gene, Seq of genes, Par of genes (no deadline), and Cond/TryCatch over exactly two genes.",
  );
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The single key of an externally tagged AlgebraExpr, and its body. */
function tagOf(expr: unknown): [string, Record<string, unknown>] {
  if (!isObject(expr)) throw outsideSubset("an expression is not an object");
  const keys = Object.keys(expr);
  if (keys.length !== 1) throw outsideSubset(`an expression has ${keys.length} tags`);
  const body = expr[keys[0]];
  if (!isObject(body)) throw outsideSubset(`'${keys[0]}' has no body`);
  return [keys[0], body];
}

/** A `Gene` leaf's role, checked against the snapshot's gene list. */
function leafRole(expr: unknown, genes: GeneReference[]): string {
  const [tag, body] = tagOf(expr);
  if (tag === "RemoteGene") throw outsideSubset("RemoteGene is not supported");
  if (tag !== "Gene") throw outsideSubset(`'${tag}' appears where only a single gene may`);
  const ref = body.geneRef;
  if (!isObject(ref) || typeof ref.role !== "string" || typeof ref.geneId !== "string") {
    throw outsideSubset("a Gene leaf has no geneRef { geneId, role }");
  }
  const listed = genes.find((g) => g.role === ref.role);
  if (!listed || listed.geneId !== ref.geneId) {
    throw new GenomeImportError(`Composition leaf '${ref.role}' does not match snapshot.genes`);
  }
  return ref.role;
}

export function compositionPlan(blueprint: GenomeBlueprint): CompositionPlan {
  const genes = blueprint.snapshot.genes;
  const order = genes.map((g) => g.role);
  const ext = blueprint.bindingExtensions?.[BINDING_NAME] ?? {};
  const expr = blueprint.snapshot.composition;

  // §4.3: a genome is an ordered composition; with no expression it runs in order.
  if (expr === undefined) {
    return genes.length === 1 ? { type: "Single", roles: order } : { type: "Seq", roles: order };
  }

  const [tag, body] = tagOf(expr);
  let plan: CompositionPlan;
  switch (tag) {
    case "Gene":
      plan = { type: "Single", roles: [leafRole(expr, genes)] };
      break;
    case "Seq": {
      if (!Array.isArray(body.steps) || body.steps.length === 0) throw outsideSubset("Seq has no steps");
      plan = { type: "Seq", roles: body.steps.map((s) => leafRole(s, genes)) };
      break;
    }
    case "Par": {
      // `agent run` executes Par flat and n-ary; export writes it right-nested.
      // Flatten Par(a, Par(b, c)) back to [a, b, c]; anything else nested is refused.
      const roles: string[] = [];
      let node: Record<string, unknown> = body;
      for (;;) {
        if (node.deadline !== undefined && node.deadline !== null) throw outsideSubset("Par with a deadline");
        roles.push(leafRole(node.left, genes));
        const [rightTag, rightBody] = tagOf(node.right);
        if (rightTag === "Par") {
          node = rightBody;
          continue;
        }
        roles.push(leafRole(node.right, genes));
        break;
      }
      const merge = ext.parMerge ?? "first";
      if (typeof merge !== "string" || !PAR_MERGES.has(merge)) {
        throw new GenomeImportError(`bindingExtensions["${BINDING_NAME}"].parMerge '${String(merge)}' is not first, concat or merge`);
      }
      plan = { type: "Par", roles, parMerge: merge };
      break;
    }
    case "Cond": {
      const p = body.predicate;
      if (!isObject(p) || typeof p.field !== "string" || typeof p.operator !== "string" || !("value" in p)) {
        throw outsideSubset("Cond predicate must be { field, operator, value }");
      }
      // agent run substitutes "type" for an empty field and "primary" for a null
      // value; accepting them would run a different branch than the one declared.
      if (p.field === "") throw outsideSubset("Cond predicate needs a non-empty field");
      if (p.value === null) throw outsideSubset("Cond predicate value must not be null");
      const op = OPS_FROM_SPEC[p.operator];
      if (!op) throw outsideSubset(`unknown CompareOp '${p.operator}'`);
      plan = {
        type: "Cond",
        roles: [leafRole(body.ifTrue, genes), leafRole(body.ifFalse, genes)],
        predicate: { field: p.field, op, value: p.value },
      };
      break;
    }
    case "TryCatch":
      plan = { type: "Try", roles: [leafRole(body.body, genes), leafRole(body.handler, genes)] };
      break;
    default:
      throw outsideSubset(`'${tag}' is not a §15.2 operator v0.9.2 supports`);
  }

  if (plan.roles.join("\u0000") !== order.join("\u0000")) {
    throw outsideSubset("the composition must use every gene of snapshot.genes once, in order");
  }
  return plan;
}

function checkMinVg(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_VG_FLOOR || value >= 1) {
    throw new GenomeImportError(`${where} must be in [${MIN_VG_FLOOR}, 1.0)`, "§5.1 does not allow a V(g) threshold below 0.5.");
  }
  return value;
}

/** Parse a Blueprint, keep only what v0.9.2 can rebuild faithfully, and run the credential scan. */
export function parseBlueprint(text: string): ParsedBlueprint {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new GenomeImportError(`Not a JSON Blueprint: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new GenomeImportError("Not a Blueprint: the top level is not an object");

  const format = raw.blueprintFormat;
  if (typeof format !== "number" || !Number.isInteger(format) || format < 1) {
    throw new GenomeImportError("Not a Blueprint: blueprintFormat is missing or not a positive integer");
  }
  if (format > BLUEPRINT_FORMAT) {
    throw new GenomeImportError(
      `Blueprint format ${format} is newer than this CLI understands (${BLUEPRINT_FORMAT})`,
      "Update the CLI: rotifer self-update",
    );
  }

  const snapshot = raw.snapshot;
  if (!isObject(snapshot) || !Array.isArray(snapshot.genes) || snapshot.genes.length === 0) {
    throw new GenomeImportError("Blueprint has no snapshot.genes");
  }
  const roles = new Set<string>();
  for (const g of snapshot.genes) {
    if (!isObject(g) || typeof g.geneId !== "string" || typeof g.role !== "string" || g.role === "") {
      throw new GenomeImportError("Every snapshot.genes entry needs a geneId and a role");
    }
    if (!GENE_ID_V2.test(g.geneId)) throw new GenomeImportError(`Gene '${g.role}' has no v2 gene ID`);
    if (g.optional === true) throw outsideSubset(`gene '${g.role}' is optional, which agent run has no notion of`);
    if (roles.has(g.role)) throw new GenomeImportError(`Role '${g.role}' appears twice in snapshot.genes`);
    roles.add(g.role);
  }

  if (raw.capabilities !== undefined) {
    if (!isObject(raw.capabilities)) throw new GenomeImportError("capabilities must be an object");
    for (const [role, q] of Object.entries(raw.capabilities)) {
      if (!roles.has(role)) throw new GenomeImportError(`capabilities has a role '${role}' that snapshot.genes lacks`);
      if (!isObject(q) || typeof q.domain !== "string" || q.domain === "") {
        throw new GenomeImportError(`capabilities['${role}'] has no domain`);
      }
      if (q.minFitness !== undefined && (typeof q.minFitness !== "number" || q.minFitness < 0 || q.minFitness > 1)) {
        throw new GenomeImportError(`capabilities['${role}'].minFitness must be between 0 and 1`);
      }
      if (q.excludeGeneIds !== undefined) {
        if (!Array.isArray(q.excludeGeneIds) || !q.excludeGeneIds.every((id) => typeof id === "string" && GENE_ID_V2.test(id))) {
          throw new GenomeImportError(`capabilities['${role}'].excludeGeneIds must be v2 gene IDs`);
        }
      }
    }
  }

  if (raw.resolutionHints !== undefined) {
    if (!isObject(raw.resolutionHints)) throw new GenomeImportError("resolutionHints must be an object");
    for (const [role, h] of Object.entries(raw.resolutionHints)) {
      if (!roles.has(role)) throw new GenomeImportError(`resolutionHints has a role '${role}' that snapshot.genes lacks`);
      const isValid =
        isObject(h) &&
        ["owner", "name", "version", "fidelity"].every((k) => typeof h[k] === "string" && h[k] !== "") &&
        (h.cloudId === undefined || typeof h.cloudId === "string");
      if (!isValid) throw new GenomeImportError(`resolutionHints['${role}'] needs owner, name, version and fidelity`);
    }
  }

  const blueprint = raw as unknown as GenomeBlueprint;
  const ext = blueprint.bindingExtensions?.[BINDING_NAME];
  const suggestedMinVg = ext?.minVg === undefined ? undefined : checkMinVg(ext.minVg, `bindingExtensions["${BINDING_NAME}"].minVg`);

  const plan = compositionPlan(blueprint);

  const findings = scanBlueprint(blueprint);
  if (findings.length > 0) {
    const where = findings.map((f) => `${f.pointer || "/"} [${f.layer}] ${f.rule}`).join("; ");
    throw new GenomeImportError(`The Blueprint carries what looks like a credential, so it is not imported: ${where}`);
  }

  return { blueprint, plan, suggestedMinVg };
}

// ── 2–5. Resolve each role ───────────────────────────────────

export type RoleMode = "capability" | "pinned" | "fallback";

export interface RoleResolution {
  role: string;
  mode: RoleMode;
  /** Why a capability role ended in lock mode. */
  fallback?: "no-admissible-candidate" | "cross-author-not-confirmed";
  originalGeneId: string;
  /** Registry row UUID to install — directly usable with `rotifer install`. */
  cloudId: string;
  owner: string;
  name: string;
  version: string;
  fidelity: string;
  /** v2 gene ID computed at admission; set for every capability pick. */
  candidateGeneId?: string;
  /** Same author and gene name as the hint, newer version. */
  selfHealUpgrade: boolean;
  crossAuthor: boolean;
  evidence?: CandidateEvidence;
  candidates?: CandidateVerdict[];
  /** Admitted substitutes that were not taken, and why. */
  rejectedSubstitutions?: Array<{ cloudId: string; owner: string; name: string; version: string; reason: string }>;
}

export interface ImportOptions {
  isPinned?: boolean;
  isConfirmed?: boolean;
  minVg?: number;
  maxEvalAgeDays?: number;
  now?: Date;
  /** Asks the user to accept a cross-author substitute; undefined → non-interactive. */
  confirm?: (question: string) => Promise<boolean>;
}

function isWrapped(fidelity: string): boolean {
  return fidelity.toLowerCase() === "wrapped";
}

/** Lock mode: the exact author + name + version from the hints. */
export async function locatePinned(role: string, hint: ResolutionHint | undefined): Promise<{ cloudId: string }> {
  if (!hint) {
    throw new GenomeImportError(
      `Role '${role}' has no resolutionHints, so it cannot be located by gene ID`,
      "The author's gene was never published; ask them to publish it, or import with capability mode.",
    );
  }
  if (isWrapped(hint.fidelity)) {
    throw new GenomeImportError(
      `Role '${role}' is a Wrapped gene: v0.9.2 does not support installing Wrapped genes from the Registry`,
      "Drop --pinned so capability mode can look for a Native/Hybrid substitute.",
    );
  }
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (hint.cloudId) {
    try {
      const row = await getGene(hint.cloudId);
      if (same(row.owner, hint.owner) && row.name === hint.name && row.version === hint.version) {
        return { cloudId: row.id };
      }
    } catch {
      // Unpublished or unknown id: fall through to the version list.
    }
  }
  const versions = await listGeneVersions(hint.owner, hint.name);
  const match = versions.find((v) => v.version === hint.version);
  if (!match) {
    throw new GenomeImportError(
      `Role '${role}': ${hint.owner}/${hint.name}@${hint.version} is not in the Registry (unpublished, or never published)`,
    );
  }
  return { cloudId: match.id };
}

export interface ResolveContext {
  blueprint: GenomeBlueprint;
  suggestedMinVg?: number;
  options: ImportOptions;
}

/** Strictest of the author's suggestion, the local flag, and the §5.1 default. */
export function effectiveMinVg(suggested: number | undefined, local: number | undefined): number {
  return Math.max(DEFAULT_MIN_VG, suggested ?? 0, local ?? 0);
}

export async function resolveRole(role: string, ctx: ResolveContext): Promise<RoleResolution> {
  const { blueprint, options } = ctx;
  const ref = blueprint.snapshot.genes.find((g) => g.role === role)!;
  const hint = blueprint.resolutionHints?.[role];
  const query: CapabilityQuery | undefined = blueprint.capabilities?.[role];

  const pinned = async (mode: RoleMode, extra: Partial<RoleResolution> = {}): Promise<RoleResolution> => {
    const { cloudId } = await locatePinned(role, hint);
    return {
      role,
      mode,
      originalGeneId: ref.geneId,
      cloudId,
      owner: hint!.owner,
      name: hint!.name,
      version: hint!.version,
      fidelity: hint!.fidelity,
      selfHealUpgrade: false,
      crossAuthor: false,
      ...extra,
    };
  };

  if (options.isPinned || !query) return pinned("pinned");

  const policy = {
    minFitness: query.minFitness ?? DEFAULT_MIN_FITNESS,
    minVg: effectiveMinVg(ctx.suggestedMinVg, options.minVg),
    maxEvalAgeDays: options.maxEvalAgeDays ?? DEFAULT_MAX_EVAL_AGE_DAYS,
    now: options.now ?? new Date(),
  };
  const { candidates, admitted } = await resolveCapabilityCandidates(query, policy);

  if (admitted.length === 0) {
    return pinned("fallback", { fallback: "no-admissible-candidate", candidates });
  }

  const best = admitted[0];
  // With no hint there is no original author to compare against, so any pick is treated as a substitution.
  const isCrossAuthor = !hint || best.owner.toLowerCase() !== hint.owner.toLowerCase();
  if (isCrossAuthor && !options.isConfirmed) {
    const question = `Role '${role}': replace ${hint ? `${hint.owner}/${hint.name}@${hint.version}` : "the original gene"} with ${best.owner}/${best.name}@${best.version} (another author)?`;
    const isAccepted = options.confirm ? await options.confirm(question) : false;
    if (!isAccepted) {
      return pinned("fallback", {
        fallback: "cross-author-not-confirmed",
        candidates,
        rejectedSubstitutions: [
          {
            cloudId: best.cloudId,
            owner: best.owner,
            name: best.name,
            version: best.version,
            reason: options.confirm ? "declined" : "cross-author substitute needs confirmation; re-run with --yes to accept",
          },
        ],
      });
    }
  }

  return {
    role,
    mode: "capability",
    originalGeneId: ref.geneId,
    cloudId: best.cloudId,
    owner: best.owner,
    name: best.name,
    version: best.version,
    fidelity: best.fidelity,
    ...(best.geneId ? { candidateGeneId: best.geneId } : {}),
    selfHealUpgrade:
      !!hint && !isCrossAuthor && best.name === hint.name && best.version !== hint.version,
    crossAuthor: isCrossAuthor,
    evidence: best.evidence,
    candidates,
  };
}

// ── 6. Install and verify ────────────────────────────────────

interface StagedGene {
  role: string;
  name: string;
  geneId: string;
  /** Directory under staging, or null when an identical local copy is reused. */
  stagedDir: string | null;
}

/**
 * Install every role into a staging directory, recompute each v2 gene ID, and
 * check it: lock-mode roles must reproduce the Blueprint's geneId exactly;
 * capability picks must be the content that was admitted. Nothing touches genes/ until every
 * role has passed.
 */
async function installAndVerify(
  resolutions: RoleResolution[],
  genesRoot: string,
  stagingRoot: string,
  isVerbose: boolean,
): Promise<StagedGene[]> {
  const staged: StagedGene[] = [];
  for (const r of resolutions) {
    validateGeneName(r.name);
    const local = join(genesRoot, r.name);
    const isLockMode = r.mode !== "capability";

    if (isLockMode && existsSync(join(local, "phenotype.json"))) {
      const localId = geneIdV2(genesRoot, r.name);
      if ("id" in localId && localId.id === r.originalGeneId) {
        staged.push({ role: r.role, name: r.name, geneId: localId.id, stagedDir: null });
        continue;
      }
    }

    if (isVerbose) display.info(`Installing ${r.owner}/${r.name}@${r.version} (${r.cloudId})`);
    const { gene } = await installGeneFromCloud(r.cloudId, { genesDir: stagingRoot });
    if (gene.name !== r.name) {
      throw new GenomeImportError(`Registry row ${r.cloudId} is '${gene.name}', expected '${r.name}'`);
    }
    const id = geneIdV2(stagingRoot, gene.name);
    if (!("id" in id)) {
      throw new GenomeImportError(`Installed '${gene.name}' has no v2 gene ID: ${id.reason}`);
    }
    if (isLockMode && id.id !== r.originalGeneId) {
      throw new GenomeImportError(
        `geneId mismatch for role '${r.role}': the Blueprint pins ${r.originalGeneId}, ` +
          `the installed ${r.owner}/${r.name}@${r.version} is ${id.id}`,
        "The gene's content differs from what the Blueprint was made from; nothing was imported.",
      );
    }
    // Exclusion was applied at admission; what was installed must be what was admitted.
    if (!isLockMode && id.id !== r.candidateGeneId) {
      throw new GenomeImportError(
        `Role '${r.role}': installed ${r.owner}/${r.name}@${r.version} is ${id.id}, not the ${r.candidateGeneId} admitted`,
        "The Registry row changed between admission and install; nothing was imported.",
      );
    }

    if (existsSync(join(local, "phenotype.json"))) {
      const localId = geneIdV2(genesRoot, r.name);
      if (!("id" in localId) || localId.id !== id.id) {
        throw new GenomeImportError(
          `A different gene named '${r.name}' already exists in this workspace`,
          "Import into another workspace, or move the local gene aside first.",
        );
      }
      staged.push({ role: r.role, name: r.name, geneId: id.id, stagedDir: null });
      continue;
    }
    staged.push({ role: r.role, name: r.name, geneId: id.id, stagedDir: join(stagingRoot, gene.name) });
  }
  return staged;
}

// ── 7–8. Build the agent and report ──────────────────────────

export interface ImportResult {
  ok: true;
  dryRun: boolean;
  agent: { id: string; name: string } | null;
  composition: CompositionPlan["type"];
  /** §4.6 ExecutionSnapshot; resolvedDeps keyed by role, valued by v2 gene ID. */
  executionSnapshot: {
    genomeId: string;
    resolvedDeps: Record<string, string>;
    resolvedAt: string;
    status: "ACTIVE";
  } | null;
  roles: Array<RoleResolution & { geneId: string | null }>;
  schemaWarnings: string[];
}

/** sha256 of the composition-relevant part of the Blueprint: same genome, same id. */
function genomeIdOf(blueprint: GenomeBlueprint): string {
  const material = JSON.stringify({ genes: blueprint.snapshot.genes, composition: blueprint.snapshot.composition ?? null });
  return createHash("sha256").update(material).digest("hex");
}

export interface RunImportContext {
  root: string;
  genesDir: string;
}

export async function importGenome(
  file: string,
  options: ImportOptions & { name?: string; isDryRun?: boolean },
  ctx: RunImportContext,
): Promise<ImportResult> {
  if (options.minVg !== undefined) checkMinVg(options.minVg, "--min-vg");
  if (options.maxEvalAgeDays !== undefined && !(Number.isFinite(options.maxEvalAgeDays) && options.maxEvalAgeDays > 0)) {
    throw new GenomeImportError("--max-eval-age must be a positive number of days");
  }

  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    throw new GenomeImportError(`Cannot read ${file}: ${(err as Error).message}`);
  }
  const { blueprint, plan, suggestedMinVg } = parseBlueprint(text);

  const agentName = options.name ?? blueprint.metadata?.name;
  if (typeof agentName !== "string" || agentName === "") {
    throw new GenomeImportError("The Blueprint has no metadata.name", "Name the agent: --name <agent>");
  }
  const agentsDir = join(ctx.root, ".rotifer", "agents");
  if (existsSync(agentsDir)) {
    const isTaken = readdirSync(agentsDir)
      .filter((f) => f.endsWith(".json"))
      .some((f) => (JSON.parse(readFileSync(join(agentsDir, f), "utf-8")) as AgentRecord).name === agentName);
    if (isTaken) throw new GenomeImportError(`An agent named '${agentName}' already exists`, "Pick another: --name <agent>");
  }

  const resolutions: RoleResolution[] = [];
  for (const role of plan.roles) {
    try {
      resolutions.push(await resolveRole(role, { blueprint, suggestedMinVg, options }));
    } catch (err) {
      if (err instanceof EvidenceError) {
        throw new GenomeImportError(`Role '${role}': ${err.message}`, "Capability evidence could not be read; nothing was imported.");
      }
      throw err;
    }
  }
  const names = resolutions.map((r) => r.name);
  if (new Set(names).size !== names.length) {
    throw new GenomeImportError("Two roles resolved to the same gene name; the agent cannot hold both");
  }

  const resolvedAt = (options.now ?? new Date()).toISOString();

  if (options.isDryRun) {
    return {
      ok: true,
      dryRun: true,
      agent: null,
      composition: plan.type,
      executionSnapshot: null,
      // Nothing is installed in a dry run, so no installed geneId is known yet.
      roles: resolutions.map((r) => ({ ...r, geneId: null })),
      schemaWarnings: [],
    };
  }

  const genesRoot = join(ctx.root, ctx.genesDir);
  mkdirSync(genesRoot, { recursive: true });
  const stagingRoot = join(ctx.root, ".rotifer", `import-staging-${randomUUID()}`);
  mkdirSync(stagingRoot, { recursive: true });
  const schemaWarnings: string[] = [];
  let staged: StagedGene[];
  try {
    staged = await installAndVerify(resolutions, genesRoot, stagingRoot, !display.isJsonMode());
    for (const s of staged) {
      if (s.stagedDir) cpSync(s.stagedDir, join(genesRoot, s.name), { recursive: true });
    }
  } finally {
    // The staging directory is this command's own scratch space.
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  const agent = createAgentCore({
    root: ctx.root,
    genesDir: ctx.genesDir,
    agentName,
    genome: staged.map((s) => s.name),
    compositionType: plan.type,
    parMerge: plan.parMerge,
    predicate: plan.predicate,
    strategy: "genome-import",
    onSchemaWarnings: (w) => schemaWarnings.push(...w),
  });

  return {
    ok: true,
    dryRun: false,
    agent: { id: agent.id, name: agent.name },
    composition: plan.type,
    executionSnapshot: {
      genomeId: genomeIdOf(blueprint),
      resolvedDeps: Object.fromEntries(staged.map((s) => [s.role, s.geneId])),
      resolvedAt,
      status: "ACTIVE",
    },
    roles: resolutions.map((r, i) => ({ ...r, geneId: staged[i].geneId })),
    schemaWarnings,
  };
}

// ── CLI ──────────────────────────────────────────────────────

export interface GenomeImportCliOptions {
  pinned?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  name?: string;
  minVg?: string;
  maxEvalAge?: string;
}

function parseNumber(flag: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) throw new GenomeImportError(`${flag} must be a number, got '${raw}'`);
  return n;
}

function renderHuman(r: ImportResult): void {
  display.header(r.dryRun ? "Genome Import (dry run)" : "Genome Import");
  display.keyValue("Composition", r.composition);
  for (const role of r.roles) {
    const mode = role.mode === "fallback" ? `fallback (${role.fallback})` : role.mode;
    display.keyValue(`  ${role.role}`, `${mode} → ${role.owner}/${role.name}@${role.version}  ${role.cloudId}`);
    display.keyValue("    original geneId", role.originalGeneId);
    if (role.geneId) display.keyValue("    installed geneId", role.geneId);
    if (role.selfHealUpgrade) display.keyValue("    self-heal upgrade", "yes");
    if (role.crossAuthor) display.keyValue("    cross-author", "yes");
    if (role.evidence) {
      const e = role.evidence;
      display.keyValue(
        "    evidence",
        `tier=${e.tier} fitness=${e.fitness_value} safety=${e.safety_score} (submitter-declared) ` +
          `method=${e.evaluation_method} n=${e.evaluation_n} last=${e.last_evaluated}`,
      );
    }
    for (const c of role.candidates ?? []) {
      if (c.admitted) continue;
      display.hint(`    rejected ${c.owner}/${c.name}@${c.version}: ${c.rejections.map((x) => x.detail).join("; ")}`);
    }
    for (const s of role.rejectedSubstitutions ?? []) {
      display.warn(`    substitute not taken ${s.owner}/${s.name}@${s.version}: ${s.reason}`);
    }
  }
  for (const w of r.schemaWarnings) display.warn(`Schema: ${w}`);
  if (r.agent) display.success(`Agent '${r.agent.name}' created (${r.agent.id})`);
  else display.hint("Dry run: nothing installed, no agent created.");
}

export async function runGenomeImport(file: string, cli: GenomeImportCliOptions, ctx: RunImportContext): Promise<number> {
  try {
    const isInteractive = !display.isJsonMode() && !!process.stdin.isTTY && !!process.stdout.isTTY;
    const confirm = isInteractive
      ? async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
          } finally {
            rl.close();
          }
        }
      : undefined;
    const result = await importGenome(
      resolve(file),
      {
        isPinned: cli.pinned,
        isDryRun: cli.dryRun,
        isConfirmed: cli.yes,
        name: cli.name,
        minVg: parseNumber("--min-vg", cli.minVg),
        maxEvalAgeDays: parseNumber("--max-eval-age", cli.maxEvalAge),
        confirm,
      },
      ctx,
    );
    display.renderResult(result, renderHuman);
    return 0;
  } catch (err) {
    if (!(err instanceof GenomeImportError)) {
      const message = (err as Error)?.message ?? String(err);
      err = new GenomeImportError(message);
    }
    const e = err as GenomeImportError;
    if (display.isJsonMode()) {
      process.stdout.write(JSON.stringify({ ok: false, error: e.message, hint: e.hint }, null, 2) + "\n");
    } else {
      display.error(e.message, e.hint);
    }
    return 1;
  }
}

export const genomeImportCommand = new Command("import")
  .description("Rebuild an agent from a Genome Blueprint (.rgenome)")
  .argument("<file>", "Blueprint file")
  .option("--pinned", "install exactly the genes the Blueprint pins; skip capability matching")
  .option("--dry-run", "resolve every role and print the plan; install nothing")
  .option("--yes", "accept substitutes from other authors without asking")
  .option("--name <agent>", "name for the new agent (default: the Blueprint's)")
  .option("--min-vg <n>", `V(g) threshold for capability picks, in [${MIN_VG_FLOOR}, 1.0) (default ${DEFAULT_MIN_VG}; the strictest of this, the Blueprint's and the default wins)`)
  .option("--max-eval-age <days>", `ignore Arena evidence older than this (default ${DEFAULT_MAX_EVAL_AGE_DAYS})`)
  .action(async (file: string, cli: GenomeImportCliOptions) => {
    const root = requireProjectRoot();
    const config = loadConfig(root);
    process.exitCode = await runGenomeImport(file, cli, { root, genesDir: config.genes_dir });
  });
