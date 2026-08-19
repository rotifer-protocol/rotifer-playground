import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import {
  fetchArenaAuditRows,
  geneWasmUrl,
  type ArenaAuditRow,
} from "../cloud/client.js";
import {
  judgeRow,
  findDrift,
  CRITERION_ORDER,
  type AuditInput,
  type RowVerdict,
  type CriterionId,
} from "../arena/invalidation-criteria.js";

const DEFAULT_CONCURRENCY = 6;

function toAuditInput(row: ArenaAuditRow): AuditInput {
  return {
    geneId: row.gene_id,
    domain: row.domain,
    gene: row.genes
      ? {
          name: row.genes.name,
          version: row.genes.version,
          fidelity: row.genes.fidelity,
          wasmPath: row.genes.wasm_path,
          wasmSize: row.genes.wasm_size ?? 0,
        }
      : null,
    evaluationMethod: row.evaluation_method,
    invalidatedAt: row.invalidated_at,
    invalidationReason: row.invalidation_reason,
  };
}

/** Fetch one artifact, or null if it cannot be read. */
async function fetchArtifact(wasmPath: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(geneWasmUrl(wasmPath));
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Run `worker` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

export const arenaAuditCommand = new Command("audit")
  .description("Check every Arena score against the public invalidation criteria")
  .option(
    "--skip-artifacts",
    "skip the criterion that inspects published WASM (no downloads; those rows are reported unchecked, not clean)",
    false
  )
  .option("--concurrency <n>", `parallel artifact downloads (default ${DEFAULT_CONCURRENCY})`)
  .action(async (options: { skipArtifacts: boolean; concurrency?: string }) => {
    const concurrency = options.concurrency
      ? Math.max(1, parseInt(options.concurrency, 10))
      : DEFAULT_CONCURRENCY;

    const spin = display.isJsonMode() ? null : display.spinner("Reading Arena rows");
    let rows: ArenaAuditRow[];
    try {
      rows = await fetchArenaAuditRows();
    } catch (err) {
      spin?.stop();
      display.error("Could not read the Arena", (err as Error).message);
      process.exitCode = 1;
      return;
    }
    spin?.stop(`Read ${rows.length} Arena rows`);

    const inputs = rows.map(toAuditInput);
    const withArtifacts = inputs.filter((r) => r.gene?.wasmPath && r.gene.wasmSize > 0);

    let artifacts = new Map<string, Uint8Array | null>();
    if (!options.skipArtifacts && withArtifacts.length > 0) {
      const bytes = withArtifacts.reduce((n, r) => n + (r.gene?.wasmSize ?? 0), 0);
      const spin2 = display.isJsonMode()
        ? null
        : display.spinner(
            `Downloading ${withArtifacts.length} artifacts (${(bytes / 1e6).toFixed(0)} MB)`
          );
      const fetched = await mapLimit(withArtifacts, concurrency, (r) =>
        fetchArtifact(r.gene!.wasmPath!)
      );
      artifacts = new Map(withArtifacts.map((r, i) => [r.geneId, fetched[i]]));
      const failed = fetched.filter((b) => b === null).length;
      spin2?.stop(
        `Scanned ${withArtifacts.length - failed} artifacts` +
          (failed > 0 ? ` (${failed} could not be downloaded — reported unchecked)` : "")
      );
    }

    const verdicts: RowVerdict[] = inputs.map((row) => {
      const hasArtifact = Boolean(row.gene?.wasmPath && row.gene.wasmSize > 0);
      const bytes = artifacts.get(row.geneId) ?? null;
      // Fetched only counts when we actually hold bytes: a failed download must
      // report unchecked, never clean.
      return judgeRow(row, bytes, { artifactFetched: hasArtifact ? bytes !== null : true });
    });

    const flagged = verdicts.filter((v) => v.criterion !== null);
    const unchecked = verdicts.filter((v) => v.artifactUnchecked);
    const drift = findDrift(verdicts);

    const byCriterion = Object.fromEntries(
      CRITERION_ORDER.map((id) => [id, flagged.filter((v) => v.criterion === id).length])
    ) as Record<CriterionId, number>;

    display.renderResult(
      {
        total: verdicts.length,
        flagged: flagged.length,
        clean: verdicts.length - flagged.length - unchecked.length,
        unchecked: unchecked.length,
        by_criterion: byCriterion,
        drift,
        rows: verdicts.map((v) => ({
          gene_id: v.geneId,
          gene_name: v.geneName,
          criterion: v.criterion,
          reason: v.reason,
          evidence: v.evidence,
          also_hits: v.allHits.slice(1).map((h) => h.criterion),
          artifact_unchecked: v.artifactUnchecked,
          stored_reason: v.storedReason,
        })),
      },
      (data) => {
        display.header("Arena invalidation audit");
        display.kv("Rows", String(data.total));
        display.kv("Flagged", String(data.flagged));
        display.kv("Clean", String(data.clean));
        if (data.unchecked > 0) display.kv("Unchecked", String(data.unchecked));

        console.log();
        for (const id of CRITERION_ORDER) {
          const n = byCriterion[id];
          console.log(`  ${n > 0 ? c.warn(String(n).padStart(4)) : "   0"}  ${id}`);
        }

        if (flagged.length > 0) {
          console.log();
          display.header("Flagged rows", { separator: false });
          for (const v of flagged) {
            const extra = v.allHits.length > 1 ? c.dim(` (+${v.allHits.length - 1} more)`) : "";
            console.log(`  ${c.warn(v.criterion!)}  ${v.geneName}${extra}`);
            console.log(`      ${c.dim(v.evidence || "")}`);
          }
        }

        console.log();
        if (drift.length === 0) {
          display.success("No drift: what the criteria say and what the board records agree.");
        } else {
          display.warn(`${drift.length} rows where the criteria and the board disagree:`);
          for (const d of drift) {
            console.log(
              `  ${c.warn(d.kind)}  ${d.geneName}  computed=${d.computed ?? "-"} stored=${d.stored ?? "-"}`
            );
          }
          display.hint(
            "'missing' means the criteria fire but nothing recorded it — expected until the invalidation job runs."
          );
        }

        if (unchecked.length > 0) {
          console.log();
          display.warn(
            `${unchecked.length} rows have an artifact that was not read — they are unevaluated, not clean.`
          );
        }

        console.log();
        display.hint(
          "Criteria: src/arena/invalidation-criteria.ts — every input above is public, so anyone can reproduce this."
        );
      }
    );
  });
