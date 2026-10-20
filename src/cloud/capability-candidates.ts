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
import { arenaLeaderboard, getGene, type LeaderboardRow } from "./client.js";
import type { CloudGene } from "./types.js";

export type RejectionCode =
  | "not-verified"
  | "invalidated"
  | "fidelity"
  | "missing-evidence"
  | "fitness-below-threshold"
  | "vg-below-threshold"
  | "stale-evidence"
  | "no-artifact"
  | "schema-incompatible";

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

export interface CandidateSources {
  arenaLeaderboard: (o: { domain?: string; limit?: number }) => Promise<LeaderboardRow[]>;
  getGene: (id: string) => Promise<CloudGene>;
}

const DEFAULT_SOURCES: CandidateSources = { arenaLeaderboard, getGene };

// ── Schema compatibility ─────────────────────────────────────
//
// Structural rule until the Blueprint RFC fixes one: the candidate must accept
// what the original was fed, and produce what the original produced.
//   input:  every field the candidate requires is offered by the query's
//           inputSchemaCompat, with the same JSON type when both declare one;
//   output: every field the query's outputSchemaCompat declares is produced by
//           the candidate, with the same JSON type when both declare one.
// A schema without a `properties` object cannot be checked and is incompatible.

type ObjectSchema = { properties: Record<string, { type?: unknown }>; required?: unknown };

function asObjectSchema(s: unknown): ObjectSchema | null {
  if (typeof s !== "object" || s === null) return null;
  const props = (s as { properties?: unknown }).properties;
  if (typeof props !== "object" || props === null || Array.isArray(props)) return null;
  return s as ObjectSchema;
}

function sameType(a: { type?: unknown } | undefined, b: { type?: unknown } | undefined): boolean {
  if (!a || !b || a.type === undefined || b.type === undefined) return true;
  return JSON.stringify(a.type) === JSON.stringify(b.type);
}

export function schemaIncompatibility(
  query: { inputSchemaCompat: unknown; outputSchemaCompat: unknown },
  candidate: { inputSchema?: unknown; outputSchema?: unknown },
): string | null {
  const qIn = asObjectSchema(query.inputSchemaCompat);
  const qOut = asObjectSchema(query.outputSchemaCompat);
  const cIn = asObjectSchema(candidate.inputSchema);
  const cOut = asObjectSchema(candidate.outputSchema);
  if (!qIn || !qOut) return "the Blueprint's capability query has no checkable schema";
  if (!cIn || !cOut) return "the candidate declares no checkable input/output schema";

  const required = Array.isArray(cIn.required) ? (cIn.required as unknown[]).filter((r) => typeof r === "string") : [];
  for (const field of required as string[]) {
    if (!(field in qIn.properties)) return `candidate requires input '${field}', which the original input does not provide`;
    if (!sameType(qIn.properties[field], cIn.properties[field])) return `input '${field}' has a different type`;
  }
  for (const field of Object.keys(qOut.properties)) {
    if (!(field in cOut.properties)) return `candidate does not produce output '${field}'`;
    if (!sameType(qOut.properties[field], cOut.properties[field])) return `output '${field}' has a different type`;
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
  let rows: LeaderboardRow[];
  try {
    rows = await sources.arenaLeaderboard({ domain: query.domain });
  } catch (err) {
    throw new EvidenceError(`could not read the Arena leaderboard for '${query.domain}': ${(err as Error).message}`);
  }
  if (!Array.isArray(rows)) throw new EvidenceError(`the Arena leaderboard for '${query.domain}' returned no rows array`);

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
    candidates.push({
      cloudId: row.gene_id,
      owner: row.owner_username,
      name: row.gene_name,
      version: row.gene_version,
      fidelity: row.fidelity,
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
