interface SearchInput {
  query: string;
  region?: string;
  resultCount?: number;
  safeSearch?: boolean;
  timeRange?: "day" | "week" | "month" | "year" | "all";
}

interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

interface SearchOutput {
  results: SearchResultItem[];
  totalHits: number;
  searchTime: number;
  query: string;
}

const TIME_RANGE_MAP: Record<string, string> = {
  day: "d",
  week: "w",
  month: "m",
  year: "y",
};

function parseHtmlResults(html: string): SearchResultItem[] {
  const results: SearchResultItem[] = [];

  const linkPattern = /<a[^>]+class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  const links: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = linkPattern.exec(html)) !== null) {
    links.push({
      url: match[1].trim(),
      title: match[2].replace(/<[^>]*>/g, "").trim(),
    });
  }

  const snippets: string[] = [];
  while ((match = snippetPattern.exec(html)) !== null) {
    snippets.push(match[1].replace(/<[^>]*>/g, "").trim());
  }

  if (links.length === 0) {
    const altPattern = /<a[^>]+rel="nofollow"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = altPattern.exec(html)) !== null) {
      const url = match[1].trim();
      const title = match[2].replace(/<[^>]*>/g, "").trim();
      if (url.startsWith("http") && title.length > 5) {
        links.push({ url, title });
      }
    }
  }

  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || "",
    });
  }

  return results;
}

export async function express(input: SearchInput): Promise<SearchOutput> {
  const start = Date.now();
  const maxResults = input.resultCount ?? 5;
  const region = input.region ?? "wt-wt";

  const params = new URLSearchParams({
    q: input.query,
    kl: region,
  });

  if (input.safeSearch === false) {
    params.set("kp", "-2");
  }

  const timeKey = input.timeRange && TIME_RANGE_MAP[input.timeRange];
  if (timeKey) {
    params.set("df", timeKey);
  }

  const url = `https://lite.duckduckgo.com/lite/?${params.toString()}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Rotifer-Gene/1.0 (clawhub-web-search)",
      Accept: "text/html",
    },
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo search failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const allResults = parseHtmlResults(html);
  const results = allResults.slice(0, maxResults);

  return {
    results,
    totalHits: allResults.length,
    searchTime: Date.now() - start,
    query: input.query,
  };
}
