import { basename, dirname } from "node:path";
import * as display from "./display.js";
import { c } from "./palette.js";
import { geneIdV2 } from "./binding.js";
import { contentHash } from "./content-hash.js";

/**
 * Print the gene's v2 ID, or why it has none (docs/gene-id-v2.md) — the ID
 * the protocol names the gene by: P2P announces it and agent memory records
 * it as createdBy. Not the unprefixed phenotype hash (superseded).
 */
export function showGeneIdV2(geneDir: string): void {
  const r = geneIdV2(dirname(geneDir), basename(geneDir));
  if ("id" in r) display.keyValue("Gene ID (v2)", c.warn(r.id));
  else display.keyValue("Gene ID (v2)", `not computable — ${r.reason}`);
}

/**
 * Print the content_hash `rotifer publish` sends for this phenotype
 * (docs/content-hash-v1.md, ADR-341) — what install compares against.
 * Labelled for what it is: a hash of phenotype.json as it stands, not an
 * identity (that is the v2 ID above).
 */
export function showContentHash(phenotype: Record<string, unknown>): void {
  display.keyValue("Content hash", `${contentHash(phenotype)} (phenotype.json as publish sends it — not an identity)`);
}
