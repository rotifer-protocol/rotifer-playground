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
    if (!isDocSource(d.source)) {
      if (nonDocCount >= opts.maxNonDocDocs) continue;
      nonDocCount++;
    }
    selected.push(d);
  }
  return selected;
}
