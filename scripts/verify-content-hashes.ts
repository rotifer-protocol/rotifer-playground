#!/usr/bin/env npx tsx
/**
 * Check local genes against the content hash v1 rules (docs/content-hash-v1.md).
 *
 * For every genes/<name>/phenotype.json, prints the content_hash `rotifer
 * publish` would send, and flags a phenotype that stores its own hash. The
 * hash is computed at publish time and sent alongside the phenotype; a
 * phenotype must not contain it under any field name (ADR-341 D2).
 *
 * This script never writes to phenotype.json. It used to: `--fix` wrote the
 * hash back as `contentHash`, which is exactly what the rule above forbids.
 * `--fix` is now refused.
 *
 * Usage (from the rotifer-playground root):
 *   npx tsx scripts/verify-content-hashes.ts
 *
 * Exit codes: 0 all clean · 1 a phenotype stores its own hash, or one could
 * not be read · 2 bad arguments (e.g. --fix)
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash } from "../src/utils/content-hash.js";

// Field names a phenotype has been seen to store its own hash under.
const SELF_HASH_FIELDS = ["content_hash", "contentHash"];

export interface GeneHashReport {
  name: string;
  /** The content_hash publish would send, or null if phenotype.json is unreadable. */
  computed: string | null;
  /** Self-hash fields present in phenotype.json (should be empty). */
  selfHashFields: string[];
  error?: string;
}

export function checkGenes(genesDir: string): GeneHashReport[] {
  const names = readdirSync(genesDir).filter((name) => {
    const p = join(genesDir, name);
    return statSync(p).isDirectory() && existsSync(join(p, "phenotype.json"));
  });

  return names.map((name) => {
    try {
      const phenotype = JSON.parse(readFileSync(join(genesDir, name, "phenotype.json"), "utf-8"));
      return {
        name,
        computed: contentHash(phenotype),
        selfHashFields: SELF_HASH_FIELDS.filter((f) => Object.prototype.hasOwnProperty.call(phenotype, f)),
      };
    } catch (err) {
      return { name, computed: null, selfHashFields: [], error: (err as Error).message };
    }
  });
}

export function main(argv: string[], cwd: string): number {
  if (argv.includes("--fix")) {
    console.error(
      "--fix was removed: content_hash is computed at publish time and must not be stored in phenotype.json " +
        "(docs/content-hash-v1.md). Nothing was changed. Remove any content_hash / contentHash field by hand.",
    );
    return 2;
  }

  const genesDir = join(cwd, "genes");
  if (!existsSync(genesDir)) {
    console.error("genes/ directory not found. Run from the rotifer-playground root.");
    return 2;
  }

  const reports = checkGenes(genesDir);
  let violations = 0;
  let errors = 0;
  for (const r of reports) {
    if (r.error) {
      errors++;
      console.log(`  ERROR      ${r.name}: ${r.error}`);
    } else if (r.selfHashFields.length > 0) {
      violations++;
      console.log(`  SELF-HASH  ${r.name}: phenotype.json stores ${r.selfHashFields.join(", ")} — remove it`);
    } else {
      console.log(`  OK         ${r.name}  ${r.computed}`);
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  OK:        ${reports.length - violations - errors}`);
  console.log(`  Self-hash: ${violations}`);
  console.log(`  Errors:    ${errors}`);
  console.log(`  Total:     ${reports.length}`);

  return violations > 0 || errors > 0 ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exit(main(process.argv.slice(2), process.cwd()));
}
