/**
 * doc-retrieval Gene (Hybrid)
 *
 * Converts a natural-language question into an embedding vector via OpenAI,
 * then queries Supabase's match_documents RPC for cosine-similar doc chunks.
 *
 * Environment variables:
 *   ROTIFER_EMBEDDING_API_KEY  — OpenAI API key (required)
 *   ROTIFER_SUPABASE_URL       — Supabase project URL (required)
 *   ROTIFER_SUPABASE_ANON_KEY  — Supabase anon/public key (required)
 */

interface DocRetrievalInput {
  question: string;
  topK?: number;
}

interface DocChunk {
  content: string;
  source: string;
  heading: string | null;
  score: number;
}

interface DocRetrievalOutput {
  question: string;
  chunks: DocChunk[];
}

interface GatewayContext {
  gatewayFetch: (url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<{ status: number; body: string }>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

async function computeEmbedding(
  text: string,
  apiKey: string,
  gf: GatewayContext["gatewayFetch"],
): Promise<number[]> {
  const res = await gf("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  if (res.status !== 200) {
    throw new Error(`OpenAI Embedding API returned ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const data = JSON.parse(res.body);
  return data.data[0].embedding;
}

async function matchDocuments(
  embedding: number[],
  topK: number,
  supabaseUrl: string,
  anonKey: string,
  gf: GatewayContext["gatewayFetch"],
): Promise<DocChunk[]> {
  const rpcUrl = `${supabaseUrl}/rest/v1/rpc/match_documents`;
  const res = await gf(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      query_embedding: `[${embedding.join(",")}]`,
      match_count: Math.min(topK, 20),
      match_threshold: 0.5,
    }),
  });

  if (res.status !== 200) {
    throw new Error(`Supabase match_documents returned ${res.status}: ${res.body.slice(0, 200)}`);
  }

  const rows: Array<{
    content: string;
    source: string;
    heading: string | null;
    similarity: number;
  }> = JSON.parse(res.body);

  return rows.map((r) => ({
    content: r.content,
    source: r.source,
    heading: r.heading,
    score: r.similarity,
  }));
}

export async function express(
  input: DocRetrievalInput,
  ctx?: GatewayContext,
): Promise<DocRetrievalOutput> {
  const question = (input.question || "").trim();
  if (!question) {
    return { question: "", chunks: [] };
  }

  const apiKey = requireEnv("ROTIFER_EMBEDDING_API_KEY");
  const supabaseUrl = requireEnv("ROTIFER_SUPABASE_URL");
  const anonKey = requireEnv("ROTIFER_SUPABASE_ANON_KEY");
  const topK = Math.min(input.topK ?? 5, 20);

  const gf = ctx?.gatewayFetch;
  if (!gf) {
    throw new Error("doc-retrieval is a Hybrid gene — gatewayFetch is required");
  }

  const embedding = await computeEmbedding(question, apiKey, gf);
  const chunks = await matchDocuments(embedding, topK, supabaseUrl, anonKey, gf);

  return { question, chunks };
}
