#!/usr/bin/env npx tsx
/**
 * Recompute geneId for all local genes using canonical serialization.
 *
 * For each genes/*/phenotype.json:
 *   1. Read phenotype → canonicalHash → new geneId
 *   2. Update .gene-manifest.json with new geneId
 *   3. Report changes
 *
 * Usage:
 *   npx tsx scripts/recompute-local-gene-ids.ts [--dry-run]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../src/utils/content-hash.js";

const dryRun = process.argv.includes("--dry-run");
const genesDir = join(process.cwd(), "genes");

if (!existsSync(genesDir)) {
  console.error("No genes/ directory found. Run from rotifer-playground root.");
  process.exit(1);
}

const entries = readdirSync(genesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory());

let updated = 0;
let unchanged = 0;
let errors = 0;

for (const entry of entries) {
  const phenotypePath = join(genesDir, entry.name, "phenotype.json");
  const manifestPath = join(genesDir, entry.name, ".gene-manifest.json");

  if (!existsSync(phenotypePath)) continue;

  try {
    const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
    const newId = contentHash(phenotype);

    let manifest: Record<string, unknown> = {};
    if (existsSync(manifestPath)) {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    }

    const oldId = manifest.geneId as string | undefined;

    if (oldId === newId) {
      unchanged++;
      continue;
    }

    console.log(`${entry.name}: ${oldId?.slice(0, 12) || "(none)"}... → ${newId.slice(0, 12)}...`);

    if (!dryRun) {
      manifest.geneId = newId;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    updated++;
  } catch (err: any) {
    console.error(`  Error processing ${entry.name}: ${err.message}`);
    errors++;
  }
}

console.log(`\n${dryRun ? "[DRY RUN] " : ""}Results:`);
console.log(`  Updated:   ${updated}`);
console.log(`  Unchanged: ${unchanged}`);
console.log(`  Errors:    ${errors}`);
console.log(`  Total:     ${entries.length} gene directories`);
