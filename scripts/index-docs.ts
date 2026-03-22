#!/usr/bin/env npx tsx
/**
 * index-docs.ts — Document indexing script for Rotifer RAG pipeline.
 *
 * Reads Markdown documentation, splits by heading into chunks,
 * computes embeddings via OpenAI, and upserts into Supabase doc_chunks.
 *
 * Usage:
 *   ROTIFER_EMBEDDING_API_KEY=sk-... \
 *   ROTIFER_SUPABASE_URL=https://xxx.supabase.co \
 *   ROTIFER_SUPABASE_SERVICE_KEY=eyJ... \
 *   npx tsx scripts/index-docs.ts [--dry-run]
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

// ── Config ──────────────────────────────────────────────

const EMBEDDING_API_KEY = process.env.ROTIFER_EMBEDDING_API_KEY || "";
const SUPABASE_URL = process.env.ROTIFER_SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.ROTIFER_SUPABASE_SERVICE_KEY || "";
const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = process.cwd();

// ~512-1024 tokens ≈ 2000-4000 chars; target midpoint
const MAX_CHUNK_CHARS = 4000;
const MIN_CHUNK_CHARS = 200;
const EMBEDDING_MODEL = "text-embedding-3-small";
const BATCH_SIZE = 20;

// ── Types ───────────────────────────────────────────────

interface DocChunk {
  content: string;
  source: string;
  heading: string | null;
  metadata: Record<string, unknown>;
}

interface EmbeddedChunk extends DocChunk {
  embedding: number[];
}

// ── Markdown splitting ──────────────────────────────────

function splitByHeading(content: string, source: string): DocChunk[] {
  const lines = content.split("\n");
  const chunks: DocChunk[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  function flush() {
    const text = currentLines.join("\n").trim();
    if (text.length >= MIN_CHUNK_CHARS) {
      if (text.length <= MAX_CHUNK_CHARS) {
        chunks.push({ content: text, source, heading: currentHeading, metadata: {} });
      } else {
        for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
          const slice = text.slice(i, i + MAX_CHUNK_CHARS).trim();
          if (slice.length >= MIN_CHUNK_CHARS) {
            chunks.push({
              content: slice,
              source,
              heading: currentHeading,
              metadata: { part: Math.floor(i / MAX_CHUNK_CHARS) + 1 },
            });
          }
        }
      }
    }
    currentLines = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[2].trim();
    }
    currentLines.push(line);
  }
  flush();

  return chunks;
}

// ── Embedding ───────────────────────────────────────────

async function computeEmbeddings(texts: string[]): Promise<number[][]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${EMBEDDING_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI Embedding API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json() as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

// ── Supabase upsert ─────────────────────────────────────

async function clearExistingChunks(): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/doc_chunks?id=gt.0`, {
    method: "DELETE",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: "return=minimal",
    },
  });
  if (!res.ok && res.status !== 404) {
    console.warn(`  Warning: failed to clear old chunks (${res.status})`);
  }
}

async function insertChunks(chunks: EmbeddedChunk[]): Promise<number> {
  const rows = chunks.map((c) => ({
    content: c.content,
    source: c.source,
    heading: c.heading,
    embedding: `[${c.embedding.join(",")}]`,
    metadata: c.metadata,
  }));

  const res = await fetch(`${SUPABASE_URL}/rest/v1/doc_chunks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase insert failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return rows.length;
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log("\n=== Rotifer Document Indexer ===\n");

  if (!DRY_RUN) {
    if (!EMBEDDING_API_KEY) { console.error("Missing ROTIFER_EMBEDDING_API_KEY"); process.exit(1); }
    if (!SUPABASE_URL) { console.error("Missing ROTIFER_SUPABASE_URL"); process.exit(1); }
    if (!SUPABASE_SERVICE_KEY) { console.error("Missing ROTIFER_SUPABASE_SERVICE_KEY"); process.exit(1); }
  }

  // Collect doc files
  const files: string[] = [];
  const docsDir = join(ROOT, "docs");
  if (existsSync(docsDir)) {
    for (const f of readdirSync(docsDir)) {
      if (f.endsWith(".md")) files.push(join(docsDir, f));
    }
  }
  for (const name of ["README.md", "README.zh.md", "CONTRIBUTING.md", "CHANGELOG.md"]) {
    const p = join(ROOT, name);
    if (existsSync(p)) files.push(p);
  }

  console.log(`  Found ${files.length} document files`);

  // Split into chunks
  const allChunks: DocChunk[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    const source = relative(ROOT, file);
    const chunks = splitByHeading(content, source);
    allChunks.push(...chunks);
    console.log(`  ${source}: ${chunks.length} chunks`);
  }

  console.log(`\n  Total: ${allChunks.length} chunks\n`);

  if (DRY_RUN) {
    console.log("  [DRY RUN] Showing first 3 chunks:\n");
    for (const c of allChunks.slice(0, 3)) {
      console.log(`  --- ${c.source} > ${c.heading || "(top)"} ---`);
      console.log(`  ${c.content.slice(0, 120)}...\n`);
    }
    console.log(`  Would embed ${allChunks.length} chunks and write to Supabase.`);
    return;
  }

  // Compute embeddings in batches
  console.log("  Computing embeddings...");
  const embedded: EmbeddedChunk[] = [];

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.content);
    const embeddings = await computeEmbeddings(texts);

    for (let j = 0; j < batch.length; j++) {
      embedded.push({ ...batch[j], embedding: embeddings[j] });
    }

    console.log(`  Embedded ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length}`);
  }

  // Upsert to Supabase
  console.log("\n  Clearing existing chunks...");
  await clearExistingChunks();

  console.log("  Inserting new chunks...");
  let totalInserted = 0;
  for (let i = 0; i < embedded.length; i += BATCH_SIZE) {
    const batch = embedded.slice(i, i + BATCH_SIZE);
    const count = await insertChunks(batch);
    totalInserted += count;
    console.log(`  Inserted ${totalInserted}/${embedded.length}`);
  }

  console.log(`\n  Done! ${totalInserted} chunks indexed in Supabase.\n`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
