#!/usr/bin/env npx tsx
/**
 * Read-only audit: does each published gene version's phenotype hash (v1
 * contentHash) to the content_hash the Registry recorded for it?
 *
 * Goes through the CLI's own read paths — listGenes → listGeneVersions →
 * getGene(<UUID>) — exactly what `rotifer install` reads, with the public
 * publishable key. It writes nothing anywhere: no PATCH, no files. Rows hidden
 * by RLS (unpublished) are out of reach and out of scope.
 *
 * Output never includes phenotype contents: names, versions, ids, hash
 * prefixes, and true/false answers to the diagnostic questions below.
 *
 * Usage:
 *   npx tsx scripts/audit-content-hashes.ts            # counts + the list of mismatches
 *   npx tsx scripts/audit-content-hashes.ts --diagnose # + per-mismatch diagnostics
 *   npx tsx scripts/audit-content-hashes.ts --json     # machine-readable
 */
import { createHash } from "node:crypto";
import { getGene, listGeneVersions, listGenes } from "../src/cloud/client.js";
import { canonicalSerialize, contentHash } from "../src/utils/content-hash.js";
import type { CloudGene } from "../src/cloud/types.js";

const isDiagnose = process.argv.includes("--diagnose");
const isJson = process.argv.includes("--json");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

interface Row {
  id: string;
  owner: string;
  name: string;
  version: string;
  createdAt: string;
  recorded: string | null;
  recomputed: string;
  phenotype: Record<string, unknown>;
}

/** Every published name, by paging the search RPC until a short page. */
async function allGeneNames(): Promise<Array<{ owner: string; name: string }>> {
  const seen = new Map<string, { owner: string; name: string }>();
  for (let page = 1; ; page++) {
    const res = await listGenes({ page, perPage: 100 });
    for (const g of res.genes) seen.set(`${g.owner}/${g.name}`, { owner: g.owner, name: g.name });
    if (res.genes.length < 100) break;
  }
  return [...seen.values()];
}

/** JSON as Postgres `jsonb::text` prints it: keys by length then bytes, ", " and ": " separators. */
function jsonbText(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(", ")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort((a, b) => {
    const la = Buffer.byteLength(a);
    const lb = Buffer.byteLength(b);
    return la !== lb ? la - lb : Buffer.compare(Buffer.from(a), Buffer.from(b));
  });
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${jsonbText((v as Record<string, unknown>)[k])}`).join(", ")}}`;
}

function sortDeep(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(sortDeep);
  return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]));
}

/** Each diagnostic is a yes/no question about how the recorded hash could have been produced. */
function diagnose(r: Row, all: Row[]): Record<string, boolean | string[]> {
  const rec = r.recorded!;
  const p = r.phenotype;
  const without = (keys: string[]) => Object.fromEntries(Object.entries(p).filter(([k]) => !keys.includes(k)));
  const droppedMatches = Object.keys(p).filter((k) => contentHash(without([k])) === rec);
  const otherRow = all.find((o) => o.id !== r.id && o.recomputed === rec);
  return {
    embeddedContentHashField: p.content_hash === rec,
    embeddedCamelContentHashField: p.contentHash === rec,
    hasEmbeddedHashField: "content_hash" in p || "contentHash" in p,
    matchesWithoutEmbeddedHashFields: contentHash(without(["content_hash", "contentHash"])) === rec,
    matchesAfterDroppingOneTopLevelKey: droppedMatches,
    equalsAnotherRowsPhenotypeHash: otherRow ? [`${otherRow.name}@${otherRow.version}`] : [],
    equalsAnotherRowsRecordedHash: all.some((o) => o.id !== r.id && o.recorded === rec),
    matchesIndentedSortedJson: sha256(JSON.stringify(sortDeep(p), null, 2)) === rec,
    matchesUnsortedJsonAsReturned: sha256(JSON.stringify(p)) === rec,
    matchesJsonbTextForm: sha256(jsonbText(p)) === rec,
    matchesCanonicalWithTrailingNewline: sha256(canonicalSerialize(p) + "\n") === rec,
    matchesEmptyPhenotype: contentHash({}) === rec,
  };
}

async function main(): Promise<void> {
  const names = await allGeneNames();
  const rows: Row[] = [];
  for (const { owner, name } of names) {
    for (const v of await listGeneVersions(owner, name)) {
      const g: CloudGene = await getGene(v.id);
      rows.push({
        id: g.id,
        owner,
        name: g.name,
        version: g.version,
        createdAt: g.created_at,
        recorded: g.content_hash,
        recomputed: contentHash(g.phenotype ?? {}),
        phenotype: g.phenotype ?? {},
      });
    }
  }

  const withHash = rows.filter((r) => r.recorded);
  const mismatches = withHash.filter((r) => r.recorded !== r.recomputed).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recordedCounts = new Map<string, number>();
  for (const r of withHash) recordedCounts.set(r.recorded!, (recordedCounts.get(r.recorded!) ?? 0) + 1);
  const duplicateGroups = [...recordedCounts.values()].filter((n) => n > 1).length;

  const summary = {
    names: names.length,
    versions: rows.length,
    withRecordedHash: withHash.length,
    matching: withHash.length - mismatches.length,
    mismatching: mismatches.length,
    duplicateRecordedHashGroups: duplicateGroups,
    mismatches: mismatches.map((r) => ({
      gene: `${r.owner}/${r.name}@${r.version}`,
      id: r.id,
      createdAt: r.createdAt,
      recorded: r.recorded!.slice(0, 12),
      recomputed: r.recomputed.slice(0, 12),
      ...(isDiagnose ? { diagnostics: diagnose(r, rows) } : {}),
    })),
  };

  if (isJson) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }
  console.log(`${summary.names} names, ${summary.versions} versions, ${summary.withRecordedHash} with a recorded content_hash`);
  console.log(`matching ${summary.matching}/${summary.withRecordedHash}, mismatching ${summary.mismatching}, duplicate recorded-hash groups ${duplicateGroups}`);
  for (const m of summary.mismatches) {
    console.log(`  ${m.createdAt.slice(0, 10)}  ${m.gene}  ${m.id}  recorded ${m.recorded}… recomputed ${m.recomputed}…`);
    if (m.diagnostics) {
      for (const [k, v] of Object.entries(m.diagnostics)) {
        if (v === true || (Array.isArray(v) && v.length > 0)) console.log(`      ${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      }
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
