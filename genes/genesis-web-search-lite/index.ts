interface LiteSearchInput {
  query: string;
}

interface LiteSearchOutput {
  answer: string;
  source: string;
}

/**
 * Genesis Gene: Web Search Lite
 *
 * Lightweight single-answer search gene — returns a concise answer
 * instead of a list. Lower resource cost, suitable for Par composition
 * with deadline constraints.
 */
export function express(input: LiteSearchInput): LiteSearchOutput {
  // Same defect as genesis-web-search: a missing query became a confident
  // answer about "undefined". With no default query to fall back on, saying so
  // is the only honest response — and it stays inside outputSchema, which is
  // what refusal has to look like on this boundary (ADR-333).
  const query: unknown = input.query;
  if (typeof query !== "string" || query.trim() === "") {
    return {
      answer: "No query provided.",
      source: "",
    };
  }

  return {
    answer: `[Simulated] Quick answer for "${query}": This is a placeholder response from genesis-web-search-lite. In production, this returns a concise answer from a search provider.`,
    source: "https://example.com/instant?q=" + encodeURIComponent(query),
  };
}
