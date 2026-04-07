#!/usr/bin/env npx tsx
/**
 * Verify and optionally fix content_hash values for all local genes.
 *
 * Usage:
 *   npx tsx scripts/verify-content-hashes.ts          # dry-run: check only
 *   npx tsx scripts/verify-content-hashes.ts --fix     # fix mismatches in-place
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../src/utils/content-hash.js";

const genesDir = join(process.cwd(), "genes");
const fix = process.argv.includes("--fix");

if (!existsSync(genesDir)) {
  console.error("genes/ directory not found. Run from rotifer-playground root.");
  process.exit(1);
}

let ok = 0;
let mismatch = 0;
let missing = 0;
let errors = 0;

const entries = readdirSync(genesDir).filter((name) => {
  const p = join(genesDir, name);
  return statSync(p).isDirectory() && existsSync(join(p, "phenotype.json"));
});

for (const name of entries) {
  const phenotypePath = join(genesDir, name, "phenotype.json");
  try {
    const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
    const computed = contentHash(phenotype);

    if (!phenotype.contentHash && !phenotype.content_hash) {
      missing++;
      console.log(`  MISSING  ${name}`);
      if (fix) {
        phenotype.contentHash = computed;
        writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2) + "\n");
        console.log(`           → fixed: ${computed}`);
      }
    } else {
      const stored = phenotype.contentHash || phenotype.content_hash;
      if (stored === computed) {
        ok++;
      } else {
        mismatch++;
        console.log(`  MISMATCH ${name}`);
        console.log(`           stored:   ${stored}`);
        console.log(`           computed: ${computed}`);
        if (fix) {
          delete phenotype.content_hash;
          phenotype.contentHash = computed;
          writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2) + "\n");
          console.log(`           → fixed`);
        }
      }
    }
  } catch (err) {
    errors++;
    console.log(`  ERROR    ${name}: ${(err as Error).message}`);
  }
}

console.log(`\n── Summary ──`);
console.log(`  OK:       ${ok}`);
console.log(`  Missing:  ${missing}`);
console.log(`  Mismatch: ${mismatch}`);
console.log(`  Errors:   ${errors}`);
console.log(`  Total:    ${entries.length}`);

if (!fix && (missing > 0 || mismatch > 0)) {
  console.log(`\nRun with --fix to update phenotype.json files.`);
}

process.exit(mismatch > 0 || errors > 0 ? 1 : 0);
