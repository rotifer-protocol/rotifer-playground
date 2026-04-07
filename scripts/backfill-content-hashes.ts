#!/usr/bin/env npx tsx
/**
 * Backfill content_hash for all genes in Supabase Cloud.
 *
 * Reads every gene's phenotype, computes contentHash(), and
 * updates the content_hash column. Requires service_role key.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backfill-content-hashes.ts
 *   Add --dry-run to only check without updating.
 */

import { contentHash } from "../src/utils/content-hash.js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.ROTIFER_CLOUD_ENDPOINT;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.argv.includes("--dry-run");

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("Required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  console.error("");
  console.error("Example:");
  console.error("  SUPABASE_URL=https://xxxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJhbG... npx tsx scripts/backfill-content-hashes.ts --dry-run");
  console.error("");
  console.error("These are the Rotifer Cloud Supabase credentials (same project as ROTIFER_CLOUD_ENDPOINT).");
  console.error("Find them in your root .env file or Supabase dashboard → Settings → API.");
  process.exit(1);
}

try {
  new URL(SUPABASE_URL);
} catch {
  console.error(`Invalid SUPABASE_URL: "${SUPABASE_URL}"`);
  console.error("Must be a full URL like https://xxxxx.supabase.co");
  process.exit(1);
}

const baseUrl = SUPABASE_URL.replace(/\/+$/, "");

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}/rest/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      Prefer: init?.method === "PATCH" ? "return=minimal" : "return=representation",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  if (init?.method === "PATCH") return null;
  return res.json();
}

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN ===" : "=== BACKFILL ===");
  console.log(`Target: ${baseUrl}\n`);

  const genes = (await api("/genes?select=id,name,phenotype,content_hash&limit=1000")) as Array<{
    id: string;
    name: string;
    phenotype: Record<string, unknown> | null;
    content_hash: string | null;
  }>;

  console.log(`Found ${genes.length} genes\n`);

  let updated = 0;
  let skipped = 0;
  let already = 0;

  for (const gene of genes) {
    if (!gene.phenotype) {
      console.log(`  SKIP     ${gene.name} (no phenotype)`);
      skipped++;
      continue;
    }

    const computed = contentHash(gene.phenotype);

    if (gene.content_hash === computed) {
      already++;
      continue;
    }

    if (gene.content_hash && gene.content_hash !== computed) {
      console.log(`  MISMATCH ${gene.name}`);
      console.log(`           stored:   ${gene.content_hash}`);
      console.log(`           computed: ${computed}`);
    } else {
      console.log(`  FILL     ${gene.name} → ${computed.slice(0, 16)}...`);
    }

    if (!DRY_RUN) {
      await api(`/genes?id=eq.${gene.id}`, {
        method: "PATCH",
        body: JSON.stringify({ content_hash: computed }),
      });
      updated++;
    }
  }

  console.log(`\n── Summary ──`);
  console.log(`  Already OK: ${already}`);
  console.log(`  Updated:    ${updated}`);
  console.log(`  Skipped:    ${skipped}`);
  console.log(`  Total:      ${genes.length}`);

  if (DRY_RUN) {
    console.log(`\nRemove --dry-run to apply updates.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
