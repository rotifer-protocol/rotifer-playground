import { createClient } from "jsr:@supabase/supabase-js@2";

interface CacheEntry {
  hash: string;
  response: { answer: string; sources: Array<{ source: string; similarity: number }> };
  sources: string[];
  expiresAt: number;
}

// Bumped v9 → v10 (paper-source cap) → v11 (generalised to a non-doc cap +
// blogs now indexed from the cloud CMS): old cached answers were generated from
// a different retrieval ranking and must be regenerated. See chat/index.ts
// MAX_NONDOC_DOCS / rank.ts selectContextDocs.
const CACHE_VERSION = "v11";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_MEM_SIZE = 50;

const memCache = new Map<string, CacheEntry>();

async function hash(text: string): Promise<string> {
  const data = new TextEncoder().encode(`${CACHE_VERSION}:${text.toLowerCase().trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function getClient() {
  const url = Deno.env.get("RAG_SUPABASE_URL");
  const key = Deno.env.get("RAG_SUPABASE_SERVICE_KEY");
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function getCachedResponse(
  question: string
): Promise<CacheEntry | null> {
  const h = await hash(question);
  const now = Date.now();

  const mem = memCache.get(h);
  if (mem && now < mem.expiresAt) return mem;
  if (mem) memCache.delete(h);

  try {
    const client = getClient();
    if (!client) return null;

    const { data } = await client
      .from("response_cache")
      .select("answer, sources, expires_at, hit_count")
      .eq("question_hash", h)
      .eq("cache_version", CACHE_VERSION)
      .gt("expires_at", new Date().toISOString())
      .single();

    if (!data) return null;

    await client
      .from("response_cache")
      .update({ hit_count: (data.hit_count || 0) + 1 })
      .eq("question_hash", h)
      .then(() => {});

    const sources = data.sources as Array<{ source: string; similarity: number }>;
    const entry: CacheEntry = {
      hash: h,
      response: { answer: data.answer, sources },
      sources: sources.map((s) => s.source),
      expiresAt: new Date(data.expires_at).getTime(),
    };

    if (memCache.size >= MAX_MEM_SIZE) {
      const oldest = memCache.keys().next().value;
      if (oldest) memCache.delete(oldest);
    }
    memCache.set(h, entry);

    return entry;
  } catch (err) {
    console.error("[cache] DB read failed, no cache:", err);
    return null;
  }
}

export async function setCachedResponse(
  question: string,
  response: { answer: string; sources: Array<{ source: string; similarity: number }> }
): Promise<void> {
  const h = await hash(question);
  const expiresAt = Date.now() + CACHE_TTL_MS;

  const entry: CacheEntry = {
    hash: h,
    response,
    sources: response.sources.map((s) => s.source),
    expiresAt,
  };

  if (memCache.size >= MAX_MEM_SIZE) {
    const oldest = memCache.keys().next().value;
    if (oldest) memCache.delete(oldest);
  }
  memCache.set(h, entry);

  try {
    const client = getClient();
    if (!client) return;

    await client.from("response_cache").upsert({
      question_hash: h,
      answer: response.answer,
      sources: response.sources,
      cache_version: CACHE_VERSION,
      expires_at: new Date(expiresAt).toISOString(),
      hit_count: 0,
    });
  } catch (err) {
    console.error("[cache] DB write failed:", err);
  }
}
