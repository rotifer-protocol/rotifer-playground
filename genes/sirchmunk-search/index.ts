interface SirchmunkInput {
  query: string;
  paths?: string[];
  mode?: "FAST" | "DEEP" | "FILENAME_ONLY";
  topKFiles?: number;
}

interface Evidence {
  file: string;
  snippet: string;
  summary: string;
}

interface SirchmunkOutput {
  answer: string;
  evidences: Evidence[];
  confidence: number;
  mode: string;
  searchTime: number;
}

const SIRCHMUNK_URL = process.env.SIRCHMUNK_API_URL || "http://localhost:8000";

export async function express(input: SirchmunkInput): Promise<SirchmunkOutput> {
  const start = Date.now();
  const mode = input.mode ?? "FAST";

  const body: Record<string, unknown> = {
    query: input.query,
    mode,
    top_k_files: input.topKFiles ?? 3,
  };
  if (input.paths?.length) {
    body.paths = input.paths;
  }

  const res = await fetch(`${SIRCHMUNK_URL}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Sirchmunk API error ${res.status}: ${text || res.statusText}. ` +
        `Is Sirchmunk running at ${SIRCHMUNK_URL}?`
    );
  }

  const data = await res.json();

  const evidences: Evidence[] = (data.evidences ?? data.results ?? []).map(
    (e: Record<string, string>) => ({
      file: e.file_path ?? e.file ?? "",
      snippet: e.raw_text ?? e.snippet ?? "",
      summary: e.summary ?? "",
    })
  );

  return {
    answer: data.content ?? data.answer ?? "",
    evidences,
    confidence: data.confidence ?? 0,
    mode,
    searchTime: Date.now() - start,
  };
}
