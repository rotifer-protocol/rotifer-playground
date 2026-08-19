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
  return {
    answer: `[Simulated] Quick answer for "${input.query}": This is a placeholder response from genesis-web-search-lite. In production, this returns a concise answer from a search provider.`,
    source: "https://example.com/instant?q=" + encodeURIComponent(input.query),
  };
}
