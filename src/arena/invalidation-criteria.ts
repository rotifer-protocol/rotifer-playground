/**
 * The criteria that disqualify an Arena score — as code, over public data.
 *
 * ADR-319 D2 asks for invalidation to be reproducible rather than curated: no
 * hand-written list of rows to drop, and no criterion that only the maintainer
 * can evaluate. Everything here therefore reads what any anonymous caller can
 * read (`arena_entries`, `genes`, and the public `gene-wasm` bucket), so a
 * third party can run the same criteria and get the same verdicts. A criterion
 * that needed a service key would defeat the point of writing it down.
 *
 * The criteria answer one question: *could this score have come from running
 * the gene, and can anyone check?* They deliberately say nothing about whether
 * a score is flattering or plausible — "0.97 looks too high" is not checkable
 * and would put a human back in the loop that D2 exists to remove.
 */

/**
 * Artifact-level shapes of an async `express()`.
 *
 * Kept byte-identical to `ASYNC_EXPRESS_MARKERS` in
 * `crates/rotifer-core/src/sandbox/wasmtime_sandbox.rs`, which is what the
 * runtime refuses to execute. If the two lists disagree, the Arena ranks a
 * gene the sandbox will not run — the exact contradiction ADR-319 exists to
 * remove — so `tests/unit/async-express-marker-parity.test.ts` reads the Rust
 * source and fails when they drift.
 *
 * Note this is the *artifact* list, not the source list. The compiler's
 * `detectAsyncExpress()` carries a third pattern (`express(): Promise<…>`)
 * that is a TypeScript type annotation and cannot survive compilation, so it
 * has no artifact-level counterpart by construction, not by omission.
 */
export const ARTIFACT_ASYNC_EXPRESS_MARKERS = [
  "async function express",
  "express = async",
] as const;

export type CriterionId =
  | "test-data"
  | "no-published-artifact"
  | "async-express-artifact";

/**
 * Evaluation order, and the reason for it: each criterion answers a question
 * that only makes sense once the previous one has been ruled out. Asking
 * "does the artifact carry the defect" of a row that has no artifact — or of a
 * row that was never a real gene — produces a true but useless reason. A row
 * is reported under the first criterion it satisfies, and `allHits` keeps the
 * rest so nothing is hidden.
 */
export const CRITERION_ORDER: readonly CriterionId[] = [
  "test-data",
  "no-published-artifact",
  "async-express-artifact",
];

/**
 * Fidelities that promise a published WASM artifact.
 *
 * Native only. The spec's Hybrid tier (L-II, "partially native execution") is
 * headed for a WASM core plus host functions for I/O, and when that lands a
 * Hybrid gene will carry an artifact too. But the shipping Hybrid path is the
 * one the v0.7 plan chose on purpose as an interim: the gene runs under
 * Node.js with a gateway-wrapped fetch injected, and there is no WASM to
 * publish. Holding Hybrid genes to an artifact they were told not to produce
 * would invalidate them for following the toolchain. When the host-function
 * path ships, add "Hybrid" here — and the production rows it then catches
 * will be genuine.
 *
 * This is the one criterion whose answer depends on which Hybrid design is
 * in force, which is why the dependency is written down here rather than left
 * implicit in a set literal.
 */
const WASM_BEARING_FIDELITIES = new Set(["Native"]);

/** One Arena row plus the gene fields the criteria read. */
export interface AuditInput {
  geneId: string;
  /** `arena_entries.domain` — the domain recorded at submission time. */
  domain: string | null;
  /** Null when the gene is not publicly readable (unpublished; never orphaned — the FK cascades). */
  gene: {
    name: string;
    version: string;
    fidelity: string;
    wasmPath: string | null;
    wasmSize: number;
  } | null;
  evaluationMethod: string | null;
  invalidatedAt: string | null;
  invalidationReason: string | null;
}

export interface CriterionHit {
  criterion: CriterionId;
  /** Why this row is disqualified, in terms a reader can check against the evidence. */
  reason: string;
  /** The specific observation the verdict rests on. */
  evidence: string;
}

/**
 * `test-data` — the row is tagged as test traffic at submission time.
 *
 * Reads `arena_entries.domain` rather than `genes.domain`: the arena row
 * records what the submitter declared when submitting, which is the claim
 * being judged. A gene can also be renamed or re-domained after the fact.
 */
export function hitsTestData(row: AuditInput): CriterionHit | null {
  if ((row.domain || "").trim().toLowerCase() !== "test") return null;
  return {
    criterion: "test-data",
    reason: "Submitted under the 'test' domain — test traffic, not a competing gene.",
    evidence: `arena_entries.domain = ${JSON.stringify(row.domain)}`,
  };
}

/**
 * `no-published-artifact` — the gene claims a WASM-executing fidelity but has
 * published no artifact.
 *
 * Only Native is WASM-executing today; see WASM_BEARING_FIDELITIES for why
 * Hybrid is not (yet) held to this.
 *
 * The verdict is about *recomputability*, not honesty. The score may well have
 * come from a real local sandbox run; but with no published artifact nobody
 * else can re-run it, and §9.7.1 asks that every published number be one a
 * third party can arrive at independently. So the reason says what is missing,
 * rather than accusing the author of a false declaration.
 *
 * Unpublished genes (`gene === null`) are deliberately *not* caught here. The
 * FK from `arena_entries` cascades on delete, so a row can never be orphaned;
 * an unreadable gene means the author unpublished it, which is a supported
 * action, not a defect.
 */
export function hitsNoPublishedArtifact(row: AuditInput): CriterionHit | null {
  if (!row.gene) return null;
  if (!WASM_BEARING_FIDELITIES.has(row.gene.fidelity)) return null;
  if (row.gene.wasmSize > 0) return null;
  return {
    criterion: "no-published-artifact",
    reason:
      `Declares fidelity '${row.gene.fidelity}', which promises an executable WASM artifact, ` +
      "but none is published — so this score cannot be recomputed by anyone (§9.7.1).",
    evidence: `genes.fidelity = ${row.gene.fidelity}, genes.wasm_size = ${row.gene.wasmSize}, genes.wasm_path = ${JSON.stringify(row.gene.wasmPath)}`,
  };
}

/**
 * `async-express-artifact` — the published artifact carries an async
 * `express()`, which Javy/QuickJS cannot await.
 *
 * The gene returns a Promise, the shim serialises it to `{}`, and the run
 * exits 0 — so the gene reports success while producing nothing. Any score
 * measured against that output describes the empty object, not the gene.
 *
 * Takes bytes rather than fetching, so the criterion stays a pure function and
 * the caller decides the transport (and can skip the download entirely).
 */
export function hitsAsyncExpressArtifact(
  row: AuditInput,
  artifact: Uint8Array | null
): CriterionHit | null {
  if (!artifact || artifact.length === 0) return null;
  const text = Buffer.from(artifact).toString("latin1");
  const found = ARTIFACT_ASYNC_EXPRESS_MARKERS.filter((m) => text.includes(m));
  if (found.length === 0) return null;
  return {
    criterion: "async-express-artifact",
    reason:
      "The published artifact carries an async express(); Javy/QuickJS has no event loop, " +
      "so the gene returns a Promise that serialises to {} and still exits 0. " +
      "The score describes that empty output, not the gene. The sandbox refuses to run it.",
    evidence: found
      .map((m) => `${JSON.stringify(m)} × ${countOccurrences(text, m)}`)
      .join(", "),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

export interface RowVerdict {
  geneId: string;
  geneName: string;
  /** The criterion this row is reported under — the first in CRITERION_ORDER that it satisfies. */
  criterion: CriterionId | null;
  reason: string | null;
  evidence: string | null;
  /** Every criterion the row satisfies, so a second reason is never silently dropped. */
  allHits: CriterionHit[];
  /** True when the artifact criterion could not be evaluated (download skipped or failed). */
  artifactUnchecked: boolean;
  /** What the database currently records, for the drift comparison. */
  storedReason: string | null;
  storedInvalidatedAt: string | null;
}

/**
 * Apply every criterion to one row.
 *
 * `artifact` is the fetched WASM, or null when it was not fetched. Passing
 * null does not make the row clean — it makes the artifact criterion
 * *unevaluated*, which `artifactUnchecked` reports so a partial run is never
 * mistaken for a clean bill of health.
 */
export function judgeRow(
  row: AuditInput,
  artifact: Uint8Array | null,
  opts: { artifactFetched: boolean }
): RowVerdict {
  const hits: CriterionHit[] = [];
  const testData = hitsTestData(row);
  if (testData) hits.push(testData);
  const noArtifact = hitsNoPublishedArtifact(row);
  if (noArtifact) hits.push(noArtifact);
  const asyncExpress = hitsAsyncExpressArtifact(row, artifact);
  if (asyncExpress) hits.push(asyncExpress);

  hits.sort(
    (a, b) => CRITERION_ORDER.indexOf(a.criterion) - CRITERION_ORDER.indexOf(b.criterion)
  );
  const primary = hits[0] || null;

  // A row with no artifact to fetch is fully evaluated, not partially: there is
  // nothing the artifact criterion could have found. Only a row that has an
  // artifact we did not read is genuinely unchecked.
  const hasArtifactToRead = Boolean(row.gene && row.gene.wasmSize > 0);

  return {
    geneId: row.geneId,
    geneName: row.gene?.name || "(unpublished)",
    criterion: primary?.criterion ?? null,
    reason: primary?.reason ?? null,
    evidence: primary?.evidence ?? null,
    allHits: hits,
    artifactUnchecked: hasArtifactToRead && !opts.artifactFetched,
    storedReason: row.invalidationReason,
    storedInvalidatedAt: row.invalidatedAt,
  };
}

export type DriftKind =
  /** Criteria say invalidate, the database has not recorded it. */
  | "missing"
  /** The database records an invalidation no criterion reproduces. */
  | "unreproducible"
  /** Both agree it is invalid, but under different reasons. */
  | "reason-mismatch";

export interface Drift {
  geneId: string;
  geneName: string;
  kind: DriftKind;
  computed: string | null;
  stored: string | null;
}

/**
 * Compare the criteria's verdicts against what the database records.
 *
 * This is the part that makes the criteria worth writing down. Anyone can run
 * the audit and diff it against the live board; if the two disagree, either the
 * job has not run or something wrote an invalidation by hand. A criteria engine
 * with no way to check it against reality is just a second opinion.
 *
 * Rows whose artifact went unchecked are skipped for `unreproducible`: a
 * partial run cannot tell "no criterion fires" from "we did not look".
 */
export function findDrift(verdicts: RowVerdict[]): Drift[] {
  const drift: Drift[] = [];
  for (const v of verdicts) {
    const computed = v.criterion;
    const stored = v.storedInvalidatedAt ? v.storedReason : null;
    if (computed && !stored) {
      drift.push({ geneId: v.geneId, geneName: v.geneName, kind: "missing", computed, stored });
    } else if (!computed && stored && !v.artifactUnchecked) {
      drift.push({
        geneId: v.geneId,
        geneName: v.geneName,
        kind: "unreproducible",
        computed,
        stored,
      });
    } else if (computed && stored && computed !== stored) {
      drift.push({
        geneId: v.geneId,
        geneName: v.geneName,
        kind: "reason-mismatch",
        computed,
        stored,
      });
    }
  }
  return drift;
}
