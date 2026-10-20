/**
 * Capability-mode candidate resolution for `rotifer genome import`.
 *
 * Evidence comes only from existing read-only endpoints:
 *   - scores: `get_arena_leaderboard` (one row per logical gene; `gene_id` is
 *     the Registry row UUID of the version on the board);
 *   - full phenotype + artifact: `getGene(<UUID>)`. `listGenes()` and
 *     `getGene().fitness` are not used — the search RPC blanks phenotype and
 *     fitness, so they cannot support a selection.
 *
 * A candidate is admitted only when every condition holds, and missing
 * evidence counts as failing (§5.1: F(g) and V(g) must both clear their
 * thresholds). Nothing here is relaxed to make a candidate pass.
 *
 * `safety_score` is the value the Arena submitter reported with its run; the
 * server does not recompute it. It is used as a declared safety score and
 * labelled that way in every output — it is not the `rotifer vg` grade and not
 * the full §5.1 V(g).
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { arenaLeaderboard, downloadGeneWasm, getGene, type LeaderboardRow } from "./client.js";
import type { CloudGene } from "./types.js";
import { geneIdV2, type GeneIdV2Result } from "../utils/binding.js";
import { validateGeneName } from "../utils/validate-gene-name.js";
import { jcs } from "../commands/genome-format.js";

export type RejectionCode =
  | "not-verified"
  | "invalidated"
  | "fidelity"
  | "missing-evidence"
  | "fitness-below-threshold"
  | "vg-below-threshold"
  | "stale-evidence"
  | "no-artifact"
  | "schema-incompatible"
  | "excluded";

export interface Rejection {
  code: RejectionCode;
  detail: string;
}

export interface CandidateEvidence {
  tier: string;
  fitness_value: number | null;
  safety_score: number | null;
  safety_score_source: "submitter-declared";
  evaluation_method: string | null;
  evaluation_n: number | null;
  last_evaluated: string | null;
  invalidation_reason: string | null;
}

export interface CandidateVerdict {
  /** Registry row UUID — what `rotifer install` takes. */
  cloudId: string;
  owner: string;
  name: string;
  version: string;
  fidelity: string;
  /** v2 gene ID of the row's content, computed for every candidate that passed the other checks. */
  geneId?: string;
  evidence: CandidateEvidence;
  admitted: boolean;
  rejections: Rejection[];
}

export interface AdmissionPolicy {
  minFitness: number;
  minVg: number;
  maxEvalAgeDays: number;
  now: Date;
}

export interface CapabilityQueryLike {
  domain: string;
  inputSchemaCompat: unknown;
  outputSchemaCompat: unknown;
  minFitness?: number;
  excludeGeneIds?: string[];
}

export interface CandidateResolution {
  /** Every candidate considered, admitted or not, best first among the admitted. */
  candidates: CandidateVerdict[];
  /** Admitted candidates ordered by fitness_value, highest first. */
  admitted: CandidateVerdict[];
}

/** Evidence could not be obtained — a failure, never a reason to fall back silently. */
export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceError";
  }
}

const LEADERBOARD_PAGE = 200;
/** 10 000 rows per domain is far beyond today's board; past it the read is treated as unreliable. */
const LEADERBOARD_MAX_PAGES = 50;

export interface CandidateSources {
  arenaLeaderboard: (o: { domain?: string; limit?: number; offset?: number }) => Promise<LeaderboardRow[]>;
  getGene: (id: string) => Promise<CloudGene>;
  /** v2 gene ID of a Registry row's content — needed to apply excludeGeneIds before choosing. */
  computeGeneId: (gene: CloudGene) => Promise<GeneIdV2Result>;
}

/**
 * Compute a candidate's v2 gene ID from its Registry row without installing it:
 * phenotype and WASM go to a throwaway directory, the WASM is checked against
 * the row's size and SHA-256, and nothing is counted as a download.
 */
export async function computeGeneIdFromRegistry(gene: CloudGene): Promise<GeneIdV2Result> {
  if (!gene.wasm_url) return { reason: "the Registry row has no WASM artifact" };
  validateGeneName(gene.name);
  const root = mkdtempSync(join(tmpdir(), "rotifer-candidate-"));
  try {
    const dir = join(root, gene.name);
    mkdirSync(dir);
    writeFileSync(join(dir, "phenotype.json"), JSON.stringify(gene.phenotype, null, 2) + "\n");
    const wasm = await downloadGeneWasm(gene.wasm_url);
    if (gene.wasm_size && wasm.length !== gene.wasm_size) return { reason: "WASM size does not match the Registry row" };
    if (gene.wasm_hash && createHash("sha256").update(wasm).digest("hex") !== gene.wasm_hash) {
      return { reason: "WASM hash does not match the Registry row" };
    }
    writeFileSync(join(dir, "gene.ir.wasm"), wasm);
    return geneIdV2(root, gene.name);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const DEFAULT_SOURCES: CandidateSources = { arenaLeaderboard, getGene, computeGeneId: computeGeneIdFromRegistry };

// ── Schema compatibility (RFC §4.5, decision B2) ─────────────
//
// A substitute is compatible only if its schemas equal the query's exactly
// after normalisation: JCS(normalise(query)) = JCS(normalise(candidate)), for
// input and output. normalise deletes the annotation keywords and nothing else,
// and descends only into keywords whose value is itself a schema. Every other
// member is compared verbatim. A schema without a `properties` object, or a
// `$ref` member anywhere in either schema, makes the pair incompatible.

const ANNOTATIONS = new Set(["description", "title", "examples", "default", "$comment"]);
/** Keywords whose member values are schemas (member names are kept). */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs"]);
/** Keywords whose value is a schema. */
const SCHEMA_VALUES = new Set(["items", "additionalProperties", "not", "if", "then", "else", "contains"]);
/** Keywords whose elements are schemas. */
const SCHEMA_ARRAYS = new Set(["prefixItems", "allOf", "anyOf", "oneOf"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** RFC §4.5 normalise. A schema that is not an object is returned as it is. */
export function normaliseSchema(schema: unknown): unknown {
  if (!isPlainObject(schema)) return schema;
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (SCHEMA_MAPS.has(key) && isPlainObject(value)) {
      entries.push([key, Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, normaliseSchema(sub)]))]);
    } else if (SCHEMA_VALUES.has(key)) {
      entries.push([key, normaliseSchema(value)]);
    } else if (SCHEMA_ARRAYS.has(key) && Array.isArray(value)) {
      entries.push([key, value.map(normaliseSchema)]);
    } else {
      entries.push([key, value]);
    }
  }
  // fromEntries, not assignment: a member called "__proto__" stays a member.
  return Object.fromEntries(entries);
}

function hasRefMember(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRefMember);
  if (!isPlainObject(node)) return false;
  return Object.entries(node).some(([key, value]) => key === "$ref" || hasRefMember(value));
}

function hasProperties(s: unknown): boolean {
  return isPlainObject(s) && isPlainObject(s.properties);
}

/** JCS of the normalised schema, or null when canonical JSON has no form for it. */
function canonicalSchema(s: unknown): string | null {
  try {
    return jcs(normaliseSchema(s));
  } catch {
    return null;
  }
}

export function schemaIncompatibility(
  query: { inputSchemaCompat: unknown; outputSchemaCompat: unknown },
  candidate: { inputSchema?: unknown; outputSchema?: unknown },
): string | null {
  const pairs: Array<[string, unknown, unknown]> = [
    ["input", query.inputSchemaCompat, candidate.inputSchema],
    ["output", query.outputSchemaCompat, candidate.outputSchema],
  ];
  for (const [side, q, c] of pairs) {
    if (!hasProperties(q)) return `the Blueprint's ${side} schema has no checkable properties`;
    if (!hasProperties(c)) return `the candidate declares no checkable ${side} schema`;
    if (hasRefMember(q) || hasRefMember(c)) return `the ${side} schemas use $ref, which cannot be compared`;
    const qc = canonicalSchema(q);
    const cc = canonicalSchema(c);
    if (qc === null || cc === null) return `the ${side} schemas hold a value canonical JSON cannot represent`;
    if (qc !== cc) return `${side} schema differs from the original's (annotations aside)`;
  }
  return null;
}

// ── Admission ────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Every condition a candidate fails; empty means admitted. */
export function admissionRejections(
  row: LeaderboardRow,
  gene: CloudGene,
  query: CapabilityQueryLike,
  policy: AdmissionPolicy,
): Rejection[] {
  const out: Rejection[] = [];

  if (row.tier !== "verified") {
    out.push({ code: "not-verified", detail: `Arena tier is '${row.tier}', not 'verified'` });
  }
  if (row.invalidation_reason) {
    out.push({ code: "invalidated", detail: `Arena entry invalidated: ${row.invalidation_reason}` });
  }
  const fidelity = (row.fidelity || gene.fidelity || "").toLowerCase();
  if (fidelity !== "native" && fidelity !== "hybrid") {
    out.push({ code: "fidelity", detail: `fidelity '${row.fidelity || gene.fidelity}' is not Native or Hybrid` });
  }

  if (row.fitness_value === null || row.fitness_value === undefined) {
    out.push({ code: "missing-evidence", detail: "no fitness_value" });
  } else if (!(row.fitness_value > policy.minFitness)) {
    out.push({ code: "fitness-below-threshold", detail: `fitness ${row.fitness_value} ≤ minFitness ${policy.minFitness}` });
  }

  if (row.safety_score === null || row.safety_score === undefined) {
    out.push({ code: "missing-evidence", detail: "no safety_score" });
  } else if (!(row.safety_score > policy.minVg)) {
    out.push({
      code: "vg-below-threshold",
      detail: `submitter-declared safety ${row.safety_score} ≤ V(g) threshold ${policy.minVg}`,
    });
  }

  if (!row.last_evaluated) {
    out.push({ code: "missing-evidence", detail: "no last_evaluated" });
  } else {
    const ageDays = (policy.now.getTime() - Date.parse(row.last_evaluated)) / DAY_MS;
    if (!Number.isFinite(ageDays) || ageDays > policy.maxEvalAgeDays) {
      out.push({
        code: "stale-evidence",
        detail: `last evaluated ${row.last_evaluated}, older than ${policy.maxEvalAgeDays} days`,
      });
    }
  }

  // Installing it must give something executable whose v2 ID can be checked.
  if (!gene.wasm_url) out.push({ code: "no-artifact", detail: "the Registry row has no WASM artifact" });

  const schemaProblem = schemaIncompatibility(query, gene.phenotype ?? {});
  if (schemaProblem) out.push({ code: "schema-incompatible", detail: schemaProblem });

  return out;
}

/**
 * Fetch the evidence for every leaderboard row in `query.domain` and judge each
 * one. Fails (EvidenceError) when evidence cannot be read — an unreachable
 * leaderboard or a candidate whose Registry row has an empty phenotype is not
 * "no candidate", it is "could not decide".
 */
export async function resolveCapabilityCandidates(
  query: CapabilityQueryLike,
  policy: AdmissionPolicy,
  sources: CandidateSources = DEFAULT_SOURCES,
): Promise<CandidateResolution> {
  // The RPC returns at most `limit` rows per call; read every page, or a
  // qualifying candidate past the first page would be reported as "none".
  const rows: LeaderboardRow[] = [];
  for (let page = 0; ; page++) {
    if (page >= LEADERBOARD_MAX_PAGES) {
      throw new EvidenceError(
        `the Arena leaderboard for '${query.domain}' has more than ${LEADERBOARD_PAGE * LEADERBOARD_MAX_PAGES} rows; refusing to decide on a partial read`,
      );
    }
    let batch: LeaderboardRow[];
    try {
      batch = await sources.arenaLeaderboard({ domain: query.domain, limit: LEADERBOARD_PAGE, offset: page * LEADERBOARD_PAGE });
    } catch (err) {
      throw new EvidenceError(`could not read the Arena leaderboard for '${query.domain}': ${(err as Error).message}`);
    }
    if (!Array.isArray(batch)) throw new EvidenceError(`the Arena leaderboard for '${query.domain}' returned no rows array`);
    rows.push(...batch);
    if (batch.length < LEADERBOARD_PAGE) break;
  }

  const candidates: CandidateVerdict[] = [];
  for (const row of rows.filter((r) => r.domain === query.domain)) {
    let gene: CloudGene;
    try {
      gene = await sources.getGene(row.gene_id);
    } catch (err) {
      throw new EvidenceError(`could not read Registry row ${row.gene_id} (${row.gene_name}): ${(err as Error).message}`);
    }
    if (!gene.phenotype || Object.keys(gene.phenotype).length === 0) {
      throw new EvidenceError(`Registry row ${row.gene_id} (${row.gene_name}) returned an empty phenotype`);
    }
    const rejections = admissionRejections(row, gene, query, policy);

    // Every candidate that passed everything else is identified by content
    // before it can be chosen: the import later checks that what it installed
    // is this exact content, and excludeGeneIds (v2 IDs) can be applied here,
    // so an excluded candidate is rejected and the next one gets its turn.
    let geneId: string | undefined;
    const excluded = query.excludeGeneIds ?? [];
    if (rejections.length === 0) {
      const id = await sources.computeGeneId(gene);
      if ("id" in id) {
        geneId = id.id;
        if (excluded.includes(id.id)) {
          rejections.push({ code: "excluded", detail: `v2 gene ID ${id.id} is in the Blueprint's excludeGeneIds` });
        }
      } else {
        rejections.push({ code: "missing-evidence", detail: `v2 gene ID could not be computed from the Registry row: ${id.reason}` });
      }
    }

    candidates.push({
      cloudId: row.gene_id,
      owner: row.owner_username,
      name: row.gene_name,
      version: row.gene_version,
      fidelity: row.fidelity,
      ...(geneId ? { geneId } : {}),
      evidence: {
        tier: row.tier,
        fitness_value: row.fitness_value,
        safety_score: row.safety_score,
        safety_score_source: "submitter-declared",
        evaluation_method: row.evaluation_method,
        evaluation_n: row.evaluation_n,
        last_evaluated: row.last_evaluated,
        invalidation_reason: row.invalidation_reason,
      },
      admitted: rejections.length === 0,
      rejections,
    });
  }

  const admitted = candidates
    .filter((c) => c.admitted)
    .sort((a, b) => (b.evidence.fitness_value ?? 0) - (a.evidence.fitness_value ?? 0));
  return { candidates, admitted };
}
