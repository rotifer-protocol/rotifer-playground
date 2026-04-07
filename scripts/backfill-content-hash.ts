#!/usr/bin/env npx tsx
/**
 * Backfill content_hash for existing genes in Supabase.
 *
 * Connects to Supabase → reads all genes → computes canonical SHA-256
 * from phenotype → updates content_hash → outputs CSV report.
 *
 * Usage:
 *   ROTIFER_CLOUD_ENDPOINT=... ROTIFER_CLOUD_SERVICE_KEY=... npx tsx scripts/backfill-content-hash.ts
 *
 * Requires service_role key for direct UPDATE bypassing RLS.
 */
import { writeFileSync } from "node:fs";
import { contentHash } from "../src/utils/content-hash.js";

const endpoint = process.env.ROTIFER_CLOUD_ENDPOINT;
const serviceKey = process.env.ROTIFER_CLOUD_SERVICE_KEY;

if (!endpoint || !serviceKey) {
  console.error("Required: ROTIFER_CLOUD_ENDPOINT and ROTIFER_CLOUD_SERVICE_KEY");
  process.exit(1);
}

async function main() {
  const res = await fetch(`${endpoint}/rest/v1/genes?select=id,name,version,phenotype,content_hash&order=created_at`, {
    headers: {
      apikey: serviceKey!,
      Authorization: `Bearer ${serviceKey}`,
    },
  });

  if (!res.ok) {
    console.error(`Failed to fetch genes: ${res.status} ${await res.text()}`);
    process.exit(1);
  }

  const genes: Array<{
    id: string;
    name: string;
    version: string;
    phenotype: Record<string, unknown> | null;
    content_hash: string | null;
  }> = await res.json();

  console.log(`Found ${genes.length} genes`);

  const csvRows: string[] = ["id,name,version,old_hash,new_hash,status"];
  const hashMap = new Map<string, string>();
  let updated = 0;
  let skipped = 0;
  let conflicts = 0;

  for (const gene of genes) {
    if (!gene.phenotype) {
      csvRows.push(`${gene.id},${gene.name},${gene.version},,,"SKIP_NO_PHENOTYPE"`);
      skipped++;
      continue;
    }

    const newHash = contentHash(gene.phenotype);
    const existingOwner = hashMap.get(newHash);
    if (existingOwner) {
      csvRows.push(`${gene.id},${gene.name},${gene.version},${gene.content_hash || ""},${newHash},"CONFLICT_WITH:${existingOwner}"`);
      conflicts++;
      continue;
    }
    hashMap.set(newHash, `${gene.name}@${gene.version}`);

    if (gene.content_hash === newHash) {
      csvRows.push(`${gene.id},${gene.name},${gene.version},${gene.content_hash},${newHash},UNCHANGED`);
      skipped++;
      continue;
    }

    const updateRes = await fetch(
      `${endpoint}/rest/v1/genes?id=eq.${gene.id}`,
      {
        method: "PATCH",
        headers: {
          apikey: serviceKey!,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ content_hash: newHash }),
      },
    );

    if (updateRes.ok) {
      csvRows.push(`${gene.id},${gene.name},${gene.version},${gene.content_hash || ""},${newHash},UPDATED`);
      updated++;
    } else {
      csvRows.push(`${gene.id},${gene.name},${gene.version},${gene.content_hash || ""},${newHash},FAILED`);
      console.error(`  Failed to update ${gene.name}@${gene.version}: ${updateRes.status}`);
    }
  }

  const reportPath = "backfill-content-hash-report.csv";
  writeFileSync(reportPath, csvRows.join("\n") + "\n");

  console.log(`\nResults:`);
  console.log(`  Updated:   ${updated}`);
  console.log(`  Skipped:   ${skipped}`);
  console.log(`  Conflicts: ${conflicts}`);
  console.log(`  Report:    ${reportPath}`);

  if (conflicts > 0) {
    console.warn("\n⚠️  Hash conflicts detected — review the CSV report before proceeding to NOT NULL migration");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
