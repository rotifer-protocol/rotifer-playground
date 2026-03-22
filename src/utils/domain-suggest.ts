import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadCloudConfig } from "../cloud/client.js";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer"
);
const CACHE_FILE = join(ROTIFER_HOME, "domain_registry.json");
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export interface DomainEntry {
  domain: string;
  description?: string;
  gene_count: number;
}

export function loadDomainCache(): DomainEntry[] {
  if (!existsSync(CACHE_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (raw.updated_at && Date.now() - raw.updated_at > CACHE_MAX_AGE_MS) {
      return raw.domains || [];
    }
    return raw.domains || [];
  } catch {
    return [];
  }
}

export function saveDomainCache(domains: DomainEntry[]): void {
  if (!existsSync(ROTIFER_HOME)) {
    mkdirSync(ROTIFER_HOME, { recursive: true });
  }
  writeFileSync(
    CACHE_FILE,
    JSON.stringify({ updated_at: Date.now(), domains }, null, 2) + "\n"
  );
}

/**
 * Suggest domains from local cache based on gene name keywords.
 * Returns top matches sorted by relevance.
 */
export function suggestDomains(
  geneName: string,
  description?: string,
  limit: number = 3
): DomainEntry[] {
  const cache = loadDomainCache();
  if (cache.length === 0) return [];

  const keywords = extractKeywords(geneName, description);
  if (keywords.length === 0) return [];

  const scored = cache.map((entry) => {
    let keywordScore = 0;
    const domainParts = entry.domain.split(".");
    const descWords = (entry.description || "").toLowerCase().split(/\s+/);

    for (const kw of keywords) {
      for (const dp of domainParts) {
        if (dp === kw) keywordScore += 10;
        else if (dp.includes(kw) || kw.includes(dp)) keywordScore += 5;
      }
      for (const dw of descWords) {
        if (dw === kw) keywordScore += 3;
        else if (dw.includes(kw)) keywordScore += 1;
      }
    }

    const score = keywordScore > 0
      ? keywordScore + Math.min(entry.gene_count, 10) * 0.5
      : 0;

    return { entry, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.entry);
}

function extractKeywords(name: string, description?: string): string[] {
  const parts = name
    .toLowerCase()
    .split(/[-_.]/)
    .filter((p) => p.length > 2);

  if (description) {
    const descWords = description
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w));
    parts.push(...descWords.slice(0, 5));
  }

  return [...new Set(parts)];
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "will",
  "been", "were", "being", "each", "which", "their", "about", "would",
  "there", "could", "other", "into", "more", "some", "than", "them",
  "gene", "rotifer", "function", "tool",
]);

/**
 * Fire-and-forget: fetch domain_registry from cloud and update local cache.
 * Swallows all errors to never disrupt the caller.
 */
export async function refreshDomainCacheFromCloud(): Promise<void> {
  try {
    const config = loadCloudConfig();
    if (!config.endpoint || !config.anonKey) return;

    const base = config.endpoint.replace(/\/+$/, "");
    const url = `${base}/rest/v1/domain_registry?select=domain,description,gene_count&order=gene_count.desc&limit=500`;
    const res = await fetch(url, {
      headers: {
        apikey: config.anonKey,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return;

    const data = (await res.json()) as DomainEntry[];
    if (Array.isArray(data) && data.length > 0) {
      saveDomainCache(data);
    }
  } catch {
    // intentionally swallowed
  }
}
