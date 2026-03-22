/**
 * answer-synthesizer Gene (Hybrid, LLM-agnostic)
 *
 * Assembles a RAG prompt from retrieved chunks, calls an LLM API,
 * and returns a structured answer with source attribution.
 *
 * Environment variables:
 *   ROTIFER_LLM_PROVIDER  — "claude" | "openai" (default "claude")
 *   ROTIFER_LLM_API_KEY   — API key for the chosen provider
 *   ROTIFER_LLM_MODEL     — Model override (optional)
 */

interface ChunkInput {
  content: string;
  source: string;
  heading?: string | null;
  score?: number;
}

interface SynthesizerInput {
  question: string;
  chunks: ChunkInput[];
  provider?: string;
}

interface SynthesizerOutput {
  answer: string;
  sources: string[];
  confidence: number;
}

interface GatewayContext {
  gatewayFetch: (url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<{ status: number; body: string }>;
}

interface LLMProvider {
  name: string;
  call(prompt: string, systemPrompt: string, gf: GatewayContext["gatewayFetch"]): Promise<string>;
}

function buildRAGPrompt(question: string, chunks: ChunkInput[]): { system: string; user: string } {
  const contextBlocks = chunks
    .map((c, i) => `[Source ${i + 1}: ${c.source}${c.heading ? ` > ${c.heading}` : ""}]\n${c.content}`)
    .join("\n\n---\n\n");

  const system = [
    "You are a documentation assistant for the Rotifer Protocol.",
    "Answer the user's question based ONLY on the provided context.",
    "If the context doesn't contain enough information, say so honestly.",
    "Always cite which source(s) you used in your answer.",
    "Respond in the same language as the question.",
    "",
    "Output format (strict JSON):",
    '{ "answer": "...", "cited_sources": ["source1", "source2"] }',
  ].join("\n");

  const user = `Context:\n\n${contextBlocks}\n\n---\n\nQuestion: ${question}\n\nRespond with JSON only.`;

  return { system, user };
}

function createClaudeProvider(): LLMProvider {
  const apiKey = process.env.ROTIFER_LLM_API_KEY;
  if (!apiKey) throw new Error("Missing ROTIFER_LLM_API_KEY for Claude provider");
  const model = process.env.ROTIFER_LLM_MODEL || "claude-3-5-haiku-20241022";

  return {
    name: "claude",
    async call(prompt, systemPrompt, gf) {
      const res = await gf("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (res.status !== 200) {
        throw new Error(`Claude API returned ${res.status}: ${res.body.slice(0, 200)}`);
      }

      const data = JSON.parse(res.body);
      return data.content?.[0]?.text || "";
    },
  };
}

function createOpenAIProvider(): LLMProvider {
  const apiKey = process.env.ROTIFER_LLM_API_KEY;
  if (!apiKey) throw new Error("Missing ROTIFER_LLM_API_KEY for OpenAI provider");
  const model = process.env.ROTIFER_LLM_MODEL || "gpt-4o-mini";

  return {
    name: "openai",
    async call(prompt, systemPrompt, gf) {
      const res = await gf("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          max_tokens: 1024,
          temperature: 0.3,
        }),
      });

      if (res.status !== 200) {
        throw new Error(`OpenAI API returned ${res.status}: ${res.body.slice(0, 200)}`);
      }

      const data = JSON.parse(res.body);
      return data.choices?.[0]?.message?.content || "";
    },
  };
}

function getProvider(override?: string): LLMProvider {
  const name = (override || process.env.ROTIFER_LLM_PROVIDER || "claude").toLowerCase();
  switch (name) {
    case "claude":
    case "anthropic":
      return createClaudeProvider();
    case "openai":
    case "gpt":
      return createOpenAIProvider();
    default:
      throw new Error(`Unsupported LLM provider: "${name}". Use "claude" or "openai".`);
  }
}

function parseResponse(raw: string, chunks: ChunkInput[]): { answer: string; cited: string[] } {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { answer: raw.trim(), cited: chunks.map((c) => c.source) };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      answer: parsed.answer || raw.trim(),
      cited: Array.isArray(parsed.cited_sources) ? parsed.cited_sources : chunks.map((c) => c.source),
    };
  } catch {
    return { answer: raw.trim(), cited: chunks.map((c) => c.source) };
  }
}

export async function express(
  input: SynthesizerInput,
  ctx?: GatewayContext,
): Promise<SynthesizerOutput> {
  const { question, chunks } = input;

  if (!question || !chunks || chunks.length === 0) {
    return {
      answer: "No context available to answer this question.",
      sources: [],
      confidence: 0,
    };
  }

  const gf = ctx?.gatewayFetch;
  if (!gf) {
    throw new Error("answer-synthesizer is a Hybrid gene — gatewayFetch is required");
  }

  const provider = getProvider(input.provider);
  const { system, user } = buildRAGPrompt(question, chunks);
  const raw = await provider.call(user, system, gf);
  const { answer, cited } = parseResponse(raw, chunks);

  const uniqueSources = [...new Set(cited)];
  const avgScore = chunks.reduce((s, c) => s + (c.score ?? 0.5), 0) / chunks.length;
  const confidence = Math.round(Math.min(avgScore, 1) * 100) / 100;

  return { answer, sources: uniqueSources, confidence };
}
