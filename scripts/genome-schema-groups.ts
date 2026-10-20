#!/usr/bin/env npx tsx
/**
 * Read-only: which genes in genes/ would count as schema-compatible substitutes
 * for one another under RFC §4.5 (decision B2, exact equality after normalisation)?
 *
 * Every pair of phenotypes goes through the CLI's own `schemaIncompatibility`,
 * one as the Blueprint's query and the other as the candidate. Equality after
 * normalisation is an equivalence, so compatible pairs form groups; the script
 * prints each group of two or more, and the genes that cannot be compared at all.
 * It writes nothing.
 *
 *   npx tsx scripts/genome-schema-groups.ts [genesDir]   (default: genes)
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { schemaIncompatibility } from "../src/cloud/capability-candidates.js";

interface Entry { name: string; domain: string; inputSchema: unknown; outputSchema: unknown }

const genesDir = resolve(process.argv[2] ?? "genes");
const entries: Entry[] = readdirSync(genesDir)
  .filter((name) => existsSync(join(genesDir, name, "phenotype.json")))
  .sort()
  .map((name) => {
    const p = JSON.parse(readFileSync(join(genesDir, name, "phenotype.json"), "utf-8")) as Record<string, unknown>;
    return { name, domain: typeof p.domain === "string" ? p.domain : "", inputSchema: p.inputSchema, outputSchema: p.outputSchema };
  });

const asQuery = (e: Entry) => ({ inputSchemaCompat: e.inputSchema, outputSchemaCompat: e.outputSchema });

// A phenotype that is not even compatible with itself can never be matched.
const uncomparable = new Map<string, string>();
for (const e of entries) {
  const why = schemaIncompatibility(asQuery(e), e);
  if (why !== null) uncomparable.set(e.name, why);
}
const comparable = entries.filter((e) => !uncomparable.has(e.name));

const groups: Entry[][] = [];
let compatiblePairs = 0;
for (const e of comparable) {
  const group = groups.find((g) => schemaIncompatibility(asQuery(g[0]), e) === null);
  if (group) group.push(e);
  else groups.push([e]);
}
// Check the grouping pairwise, both directions, instead of trusting transitivity.
for (let i = 0; i < comparable.length; i++) {
  for (let j = i + 1; j < comparable.length; j++) {
    const a = comparable[i];
    const b = comparable[j];
    const ab = schemaIncompatibility(asQuery(a), b) === null;
    const ba = schemaIncompatibility(asQuery(b), a) === null;
    if (ab !== ba) throw new Error(`asymmetric result for ${a.name} / ${b.name}`);
    const sameGroup = groups.some((g) => g.includes(a) && g.includes(b));
    if (ab !== sameGroup) throw new Error(`grouping disagrees with the pairwise check for ${a.name} / ${b.name}`);
    if (ab) compatiblePairs++;
  }
}

const shared = groups.filter((g) => g.length >= 2).sort((x, y) => y.length - x.length);
const reasons = new Map<string, number>();
for (const why of uncomparable.values()) reasons.set(why, (reasons.get(why) ?? 0) + 1);

console.log(`phenotypes: ${entries.length}`);
console.log(`cannot be compared (not compatible even with themselves): ${uncomparable.size}`);
for (const [why, n] of [...reasons].sort((x, y) => y[1] - x[1])) console.log(`  ${n}  ${why}`);
console.log(`comparable: ${comparable.length}, in ${groups.length} distinct schema pairs`);
console.log(`groups of 2 or more with equal schemas: ${shared.length} (${shared.reduce((n, g) => n + g.length, 0)} genes, ${compatiblePairs} compatible pairs)`);
for (const g of shared) {
  const domains = [...new Set(g.map((e) => e.domain || "(none)"))];
  console.log(`  [${g.length}] ${g.map((e) => e.name).join(", ")}  — domains: ${domains.join(", ")}`);
}
