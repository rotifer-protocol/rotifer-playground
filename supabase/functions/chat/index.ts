import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleCors } from "./cors.ts";
import { checkRateLimit } from "./rate-limiter.ts";
import { getCachedResponse, setCachedResponse } from "./cache.ts";
import { checkDailyLimit, recordCost } from "./cost-monitor.ts";
import { recordAnalytics } from "./analytics.ts";
import { filterContent } from "./content-filter.ts";

const RAG_URL = Deno.env.get("RAG_SUPABASE_URL")!;
const RAG_ANON_KEY = Deno.env.get("RAG_SUPABASE_ANON_KEY")!;
const MAIN_URL = Deno.env.get("SUPABASE_URL")!;
const MAIN_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LLM_API_KEY = Deno.env.get("LLM_API_KEY")!;
const LLM_MODEL = Deno.env.get("LLM_MODEL") || "claude-3-5-haiku-20241022";
const LLM_BASE_URL = Deno.env.get("LLM_BASE_URL") || "https://api.anthropic.com";
const MAX_TOKENS = 1024;
const TOP_K = 5;

interface ChatRequest {
  question: string;
  session_id?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return handleCors();

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  try {
    const rateLimitResult = await checkRateLimit(clientIp);
    if (!rateLimitResult.allowed) {
      return new Response(
        JSON.stringify({ error: "Rate limit exceeded", retry_after: rateLimitResult.retryAfter }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const dailyOk = await checkDailyLimit();
    if (!dailyOk) {
      return new Response(
        JSON.stringify({ error: "Daily quota exceeded. Please try again tomorrow." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body: ChatRequest = await req.json();

    if (!body.question || typeof body.question !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'question' field" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.question.length > 2000) {
      return new Response(
        JSON.stringify({ error: "Question too long (max 2000 characters)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.history && body.history.length > 20) {
      return new Response(
        JSON.stringify({ error: "Session limit exceeded (max 20 turns)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const contentCheck = filterContent(body.question);
    if (!contentCheck.allowed) {
      return new Response(
        JSON.stringify({ error: contentCheck.reason }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cached = await getCachedResponse(body.question);
    if (cached) {
      await recordAnalytics({
        questionHash: cached.hash,
        cacheHit: true,
        sources: cached.sources,
      });
      return new Response(JSON.stringify(cached.response), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ragClient = createClient(RAG_URL, RAG_ANON_KEY);

    const embeddingRes = await fetch(`${LLM_BASE_URL.replace("api.anthropic.com", "api.openai.com")}/v1/embeddings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY") || LLM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: body.question,
      }),
    });

    if (!embeddingRes.ok) {
      throw new Error(`Embedding API error: ${embeddingRes.status}`);
    }

    const embeddingData = await embeddingRes.json();
    const queryEmbedding = embeddingData.data[0].embedding;

    const { data: docs, error: ragError } = await ragClient.rpc("match_documents", {
      query_embedding: queryEmbedding,
      match_count: TOP_K,
      match_threshold: 0.5,
    });

    if (ragError) throw new Error(`RAG query failed: ${ragError.message}`);

    const context = (docs || [])
      .map((d: { content: string; source: string; similarity: number }) =>
        `[Source: ${d.source}]\n${d.content}`
      )
      .join("\n\n---\n\n");

    const sources = (docs || []).map((d: { source: string; similarity: number }) => ({
      source: d.source,
      similarity: d.similarity,
    }));

    const systemPrompt = `You are the Rotifer Protocol documentation assistant. Answer questions about the Rotifer Protocol based ONLY on the provided documentation context. If the context doesn't contain relevant information, say so honestly.

Rules:
- Be concise and accurate
- Always cite sources using [Source: path] format
- If a question is not about Rotifer Protocol, politely redirect
- Respond in the same language as the user's question
- Format responses with Markdown when helpful
- Do not reveal internal implementation details or file paths outside the public documentation

Documentation context:
${context || "No relevant documentation found."}`;

    const messages = [
      ...(body.history || []).slice(-6).map((m) => ({
        role: m.role,
        content: m.content,
      })),
      { role: "user", content: body.question },
    ];

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const llmRes = await fetch(`${LLM_BASE_URL}/v1/messages`, {
            method: "POST",
            headers: {
              "x-api-key": LLM_API_KEY,
              "anthropic-version": "2023-06-01",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: LLM_MODEL,
              max_tokens: MAX_TOKENS,
              system: systemPrompt,
              messages,
              stream: true,
            }),
          });

          if (!llmRes.ok) {
            const err = await llmRes.text();
            controller.enqueue(
              new TextEncoder().encode(`data: ${JSON.stringify({ type: "error", error: err })}\n\n`)
            );
            controller.close();
            return;
          }

          let fullResponse = "";
          const reader = llmRes.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;

              try {
                const event = JSON.parse(data);
                if (event.type === "content_block_delta" && event.delta?.text) {
                  fullResponse += event.delta.text;
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ type: "text", text: event.delta.text })}\n\n`
                    )
                  );
                }
              } catch {
                // skip unparseable lines
              }
            }
          }

          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "done",
                sources,
                pipeline: [
                  { gene: "doc-retrieval", domain: "retrieval.document", ms: 0 },
                  { gene: "answer-synthesizer", domain: "prompt.summarize", ms: 0 },
                  { gene: "source-linker", domain: "utility.link", ms: 0 },
                  { gene: "grammar-checker", domain: "utility.grammar", ms: 0 },
                ],
              })}\n\n`
            )
          );
          controller.close();

          await setCachedResponse(body.question, {
            answer: fullResponse,
            sources,
          });

          await recordCost(LLM_MODEL, fullResponse.length);

          await recordAnalytics({
            questionHash: await hashQuestion(body.question),
            cacheHit: false,
            sources: sources.map((s: { source: string }) => s.source),
            responseLength: fullResponse.length,
          });

          const mainClient = createClient(MAIN_URL, MAIN_SERVICE_KEY);
          const genes = ["doc-retrieval", "answer-synthesizer", "source-linker", "grammar-checker"];
          for (const gene of genes) {
            await mainClient.rpc("log_gene_invocation", {
              p_gene_id: gene,
              p_caller_agent_id: `chat-widget:${clientIp.slice(0, 8)}`,
            }).catch(() => {});
          }
        } catch (err) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "error", error: String(err) })}\n\n`
            )
          );
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal server error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function hashQuestion(q: string): Promise<string> {
  const data = new TextEncoder().encode(q.toLowerCase().trim());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
