interface CacheEntry {
  hash: string;
  response: { answer: string; sources: Array<{ source: string; similarity: number }> };
  sources: string[];
  expiresAt: number;
}

const CACHE_VERSION = "v9";
const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_CACHE_SIZE = 200;
const cache = new Map<string, CacheEntry>();

async function hash(text: string): Promise<string> {
  const data = new TextEncoder().encode(`${CACHE_VERSION}:${text.toLowerCase().trim()}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export async function getCachedResponse(
  question: string
): Promise<CacheEntry | null> {
  const h = await hash(question);
  const entry = cache.get(h);

  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(h);
    return null;
  }

  return entry;
}

export async function setCachedResponse(
  question: string,
  response: { answer: string; sources: Array<{ source: string; similarity: number }> }
): Promise<void> {
  const h = await hash(question);

  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }

  cache.set(h, {
    hash: h,
    response,
    sources: response.sources.map((s) => s.source),
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}
