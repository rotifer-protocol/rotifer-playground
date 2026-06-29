// Retrieval ranking + context-window selection for the chat RAG pipeline.
// Extracted as a pure module so the paper-capping behaviour can be unit-tested
// (see rank.test.ts) independently of the Deno.serve request handler.

export type RankDoc = {
  content: string;
  source: string;
  similarity: number;
  metadata?: { title?: string };
};

/** Papers are indexed from the build-time `.papers-cache/` directory. */
export function isPaperSource(source: string): boolean {
  return source.startsWith(".papers-cache/");
}

export interface SelectOpts {
  /** True when a source is in the user's language (gets a small ranking boost). */
  isUserLang: (source: string) => boolean;
  /** Size of the context window handed to the LLM. */
  maxContextDocs: number;
  /** Max number of paper chunks allowed in the context window. */
  maxPaperDocs: number;
}

/**
 * Rank docs by similarity (with a small same-language boost) and pick the
 * context window, capping papers at `maxPaperDocs`.
 *
 * Papers are deep but semantically dense, so on core-doc questions they can
 * crowd the canonical docs out of the window. Capping them guarantees the
 * authoritative docs always have room while papers still contribute up to
 * `maxPaperDocs` chunks for depth.
 */
export function selectContextDocs(docs: RankDoc[], opts: SelectOpts): RankDoc[] {
  const ranked = [...docs].sort((a, b) => {
    const aBoost = opts.isUserLang(a.source) ? 0.05 : 0;
    const bBoost = opts.isUserLang(b.source) ? 0.05 : 0;
    return b.similarity + bBoost - (a.similarity + aBoost);
  });

  const selected: RankDoc[] = [];
  let paperCount = 0;
  for (const d of ranked) {
    if (selected.length >= opts.maxContextDocs) break;
    if (isPaperSource(d.source)) {
      if (paperCount >= opts.maxPaperDocs) continue;
      paperCount++;
    }
    selected.push(d);
  }
  return selected;
}
