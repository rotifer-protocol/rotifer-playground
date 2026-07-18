// Retrieval ranking + context-window selection for the chat RAG pipeline.
// Extracted as a pure module so the context-capping behaviour can be unit-tested
// (see rank.test.ts) independently of the Deno.serve request handler.

export type RankDoc = {
  content: string;
  source: string;
  similarity: number;
  metadata?: { title?: string };
};

/**
 * Authoritative documentation lives under src/content/docs/. Everything else
 * indexed into the KB — research papers (.papers-cache/), blog posts (blog/,
 * zh/blog/), README, and the synthetic content-catalog — is supplementary.
 */
export function isDocSource(source: string): boolean {
  return source.startsWith("src/content/docs/");
}

/**
 * The synthetic content-catalog is a single tiny index card holding the blog /
 * paper inventory. It is the ONLY chunk that can answer "how many posts are
 * there?", so it must never lose its slot to the hundreds of blog/paper chunks
 * it competes with — it is exempt from the non-doc cap.
 */
const CAP_EXEMPT = new Set(["content-catalog"]);

/**
 * Collapse each bilingual twin onto one key so the alt-language copy can be
 * deduped: docs (src/content/docs/zh/x ↔ docs/x), blogs (zh/blog/x ↔ blog/x)
 * and papers (x.zh.md ↔ x.md). Without this the same post occupies two of the
 * few context slots, once per language.
 */
export function normalizePath(source: string): string {
  return source
    .replace(/^src\/content\/docs\/zh\//, "")
    .replace(/^src\/content\/docs\//, "")
    .replace(/^zh\/blog\//, "blog/")
    .replace(/\.zh\.md$/, ".md");
}

/**
 * Is this source written in the reader's language? Docs, blogs and papers each
 * encode language differently (path prefix / route prefix / filename suffix).
 */
export function isUserLangFor(locale: "en" | "zh", source: string): boolean {
  const zh = locale === "zh";
  if (source.startsWith("blog/") || source.startsWith("zh/blog/")) {
    return zh ? source.startsWith("zh/blog/") : source.startsWith("blog/");
  }
  if (source.startsWith(".papers-cache/")) {
    return zh ? source.endsWith(".zh.md") : !source.endsWith(".zh.md");
  }
  return source.startsWith(zh ? "src/content/docs/zh/" : "src/content/docs/docs/");
}

export interface SelectOpts {
  /** True when a source is in the user's language (gets a small ranking boost). */
  isUserLang: (source: string) => boolean;
  /** Size of the context window handed to the LLM. */
  maxContextDocs: number;
  /** Max number of non-doc (paper/blog/README/catalog) chunks in the window. */
  maxNonDocDocs: number;
}

/**
 * Rank docs by similarity (with a small same-language boost) and pick the
 * context window, capping non-doc sources at `maxNonDocDocs`.
 *
 * Supplementary sources (papers, blogs) are numerous and often semantically
 * dense, so on core-doc questions they can crowd the authoritative docs out of
 * the window. Docs are never skipped; non-docs are capped, so the canonical
 * docs always have room while papers/blogs still contribute for depth/recency.
 */
export function selectContextDocs(docs: RankDoc[], opts: SelectOpts): RankDoc[] {
  const ranked = [...docs].sort((a, b) => {
    const aBoost = opts.isUserLang(a.source) ? 0.05 : 0;
    const bBoost = opts.isUserLang(b.source) ? 0.05 : 0;
    return b.similarity + bBoost - (a.similarity + aBoost);
  });

  const selected: RankDoc[] = [];
  let nonDocCount = 0;
  for (const d of ranked) {
    if (selected.length >= opts.maxContextDocs) break;
    if (!isDocSource(d.source) && !CAP_EXEMPT.has(d.source)) {
      if (nonDocCount >= opts.maxNonDocDocs) continue;
      nonDocCount++;
    }
    selected.push(d);
  }
  return selected;
}
