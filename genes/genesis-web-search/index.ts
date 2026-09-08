interface SearchInput {
  query: string;
  maxResults?: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

interface SearchOutput {
  results: SearchResult[];
  totalResults: number;
  searchTime: number;
}

/**
 * Genesis Gene: Web Search
 *
 * Full-featured web search gene. In MVP, returns simulated results.
 * Production binding would connect to a real search API.
 */
export function express(input: SearchInput): SearchOutput {
  const start = Date.now();

  // `input.query` used to be interpolated straight into the result strings, so
  // a missing field produced a simulated search for the literal "undefined" and
  // a numeric one searched for "42". Neither is a search; both are the Gene
  // answering confidently about a question nobody asked.
  //
  // Unlike a Gene with a documented default, there is nothing sensible to
  // search for in place of a query, so this refuses: no query, no results. The
  // shape still conforms to outputSchema, which is what "correct handling"
  // means on this boundary (ADR-333).
  const query: unknown = input.query;
  if (typeof query !== "string" || query.trim() === "") {
    return { results: [], totalResults: 0, searchTime: Date.now() - start };
  }

  const rawMax: unknown = input.maxResults;
  const max =
    typeof rawMax === "number" && Number.isInteger(rawMax) && rawMax > 0
      ? Math.min(rawMax, 20)
      : 5;

  const results: SearchResult[] = Array.from({ length: max }, (_, i) => ({
    title: `Result ${i + 1} for "${query}"`,
    url: `https://example.com/search?q=${encodeURIComponent(query)}&p=${i + 1}`,
    snippet: `This is a simulated search result #${i + 1} for the query "${query}". In production, this gene binds to a real search provider.`,
  }));

  return {
    results,
    totalResults: results.length,
    searchTime: Date.now() - start,
  };
}
