import { createClient } from "jsr:@supabase/supabase-js@2";
import { getCorsHeaders, handleCors } from "./cors.ts";
import { checkRateLimit, recordContentFilterHit } from "./rate-limiter.ts";
import { getCachedResponse, setCachedResponse } from "./cache.ts";
import { checkDailyLimit, recordCost } from "./cost-monitor.ts";
import { recordAnalytics, recordSecurityEvent } from "./analytics.ts";
import { filterContent } from "./content-filter.ts";
import { selectContextDocs } from "./rank.ts";

const RAG_URL = Deno.env.get("RAG_SUPABASE_URL")!;
const RAG_ANON_KEY = Deno.env.get("RAG_SUPABASE_ANON_KEY")!;
const MAIN_URL = Deno.env.get("SUPABASE_URL")!;
const MAIN_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LLM_API_KEY = Deno.env.get("LLM_API_KEY")!;
const LLM_MODEL = Deno.env.get("LLM_MODEL") || "deepseek-v4-flash";
const LLM_BASE_URL = Deno.env.get("LLM_BASE_URL") || "https://api.deepseek.com";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")!;
const MAX_TOKENS = 1024;
const TOP_K = 14;

interface ChatRequest {
  question: string;
  session_id?: string;
  locale?: "en" | "zh";
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

type Locale = "en" | "zh";

const ERR_MESSAGES: Record<string, Record<Locale, string>> = {
  rate_limit_hourly: {
    en: "Too many requests. Please wait a moment and try again. In the meantime, you can browse our documentation at https://rotifer.dev/docs",
    zh: "请求过于频繁，请稍后再试。等待期间可以浏览文档：https://rotifer.dev/docs",
  },
  rate_limit_daily: {
    en: "Daily limit reached. You can continue tomorrow, or explore our docs at https://rotifer.dev/docs and CLI guide at https://rotifer.dev/docs/getting-started",
    zh: "今日请求已达上限，明天可继续使用。等待期间可浏览文档 https://rotifer.dev/docs 或 CLI 指南 https://rotifer.dev/docs/getting-started",
  },
  auto_ban: {
    en: "Your IP has been temporarily restricted due to excessive requests. Access will be restored in 24 hours. Browse our docs: https://rotifer.dev/docs",
    zh: "因请求过于频繁，您的 IP 已被临时限制，24 小时后自动恢复。您可以浏览文档：https://rotifer.dev/docs",
  },
  adaptive_limit: {
    en: "Your request rate has been temporarily reduced due to repeated policy violations. Normal limits will restore in 30 minutes.",
    zh: "因多次触发安全策略，您的请求频率已被临时降低，30 分钟后自动恢复正常限额。",
  },
  daily_quota: {
    en: "Daily quota exceeded. Please try again tomorrow.",
    zh: "今日全局配额已用完，请明天再试。",
  },
  missing_question: {
    en: "Missing or invalid 'question' field",
    zh: "请输入有效的问题",
  },
  question_too_long: {
    en: "Question too long (max 2000 characters)",
    zh: "问题过长（最多 2000 个字符）",
  },
  session_limit: {
    en: "Session limit exceeded (max 20 turns). Please clear history and start a new conversation.",
    zh: "会话轮数已达上限（最多 20 轮），请清除历史记录开始新对话。",
  },
  content_blocked: {
    en: "This type of question is not supported. Please ask about the Rotifer Protocol.",
    zh: "该类型的问题不被支持，请提问与轮虫协议相关的内容。",
  },
};

function errMsg(key: string, locale: Locale): string {
  return ERR_MESSAGES[key]?.[locale] || ERR_MESSAGES[key]?.en || key;
}

function detectLocale(body: ChatRequest): Locale {
  if (body.locale === "zh") return "zh";
  if (body.locale === "en") return "en";
  if (/[\u4e00-\u9fff]/.test(body.question)) return "zh";
  return "en";
}

Deno.serve(async (req: Request) => {
  const requestOrigin = req.headers.get("origin");
  const corsHeaders = getCorsHeaders(requestOrigin);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

  const startTime = Date.now();

  try {
    const body: ChatRequest = await req.json();
    const locale = detectLocale(body);

    const rateLimitResult = await checkRateLimit(clientIp);
    if (!rateLimitResult.allowed) {
      const reason = rateLimitResult.reason || "rate_limit";
      const errKey = reason === "auto_ban" ? "auto_ban"
        : reason === "daily_limit" ? "rate_limit_daily"
        : reason === "adaptive_limit" ? "adaptive_limit"
        : "rate_limit_hourly";
      await recordSecurityEvent("rate_limit", rateLimitResult.ipHash, "", reason);
      return new Response(
        JSON.stringify({ error: errMsg(errKey, locale), retry_after: rateLimitResult.retryAfter }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const dailyOk = await checkDailyLimit();
    if (!dailyOk) {
      await recordSecurityEvent("cost_limit", rateLimitResult.ipHash, "", "Daily quota exceeded");
      return new Response(
        JSON.stringify({ error: errMsg("daily_quota", locale) }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!body.question || typeof body.question !== "string") {
      return new Response(
        JSON.stringify({ error: errMsg("missing_question", locale) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.question.length > 2000) {
      return new Response(
        JSON.stringify({ error: errMsg("question_too_long", locale) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (body.history && body.history.length > 20) {
      return new Response(
        JSON.stringify({ error: errMsg("session_limit", locale) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const qHash = await hashQuestion(body.question);

    const contentCheck = filterContent(body.question);
    if (!contentCheck.allowed) {
      recordContentFilterHit(rateLimitResult.ipHash);
      await recordSecurityEvent("content_filter", rateLimitResult.ipHash, qHash, contentCheck.category || "unknown");
      await recordAnalytics({
        questionHash: qHash,
        cacheHit: false,
        sources: [],
        blocked: true,
        blockReason: contentCheck.category,
        responseTimeMs: Date.now() - startTime,
      });
      return new Response(
        JSON.stringify({ error: errMsg("content_blocked", locale) }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const cached = await getCachedResponse(body.question);
    if (cached) {
      await recordAnalytics({
        questionHash: cached.hash,
        cacheHit: true,
        sources: cached.sources,
        responseTimeMs: Date.now() - startTime,
      });
      return new Response(JSON.stringify(cached.response), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ragClient = createClient(RAG_URL, RAG_ANON_KEY);

    const embeddingRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
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
      match_threshold: 0.3,
    });

    if (ragError) throw new Error(`RAG query failed: ${ragError.message}`);

    const langPrefix = locale === "zh" ? "src/content/docs/zh/" : "src/content/docs/docs/";
    const MAX_CONTEXT_DOCS = 6;
    const MAX_NONDOC_DOCS = 3;

    function normalizePath(source: string): string {
      return source
        .replace(/^src\/content\/docs\/zh\//, "")
        .replace(/^src\/content\/docs\//, "");
    }

    function isUserLang(source: string): boolean {
      return source.startsWith(langPrefix);
    }

    type Doc = { content: string; source: string; similarity: number; metadata?: { title?: string } };
    const allDocs = (docs || []) as Doc[];

    const filteredDocs: Doc[] = [];
    const altLangPaths = new Set<string>();

    for (const d of allDocs) {
      if (isUserLang(d.source)) {
        altLangPaths.add(normalizePath(d.source));
      }
    }

    for (const d of allDocs) {
      if (isUserLang(d.source)) {
        filteredDocs.push(d);
      } else if (!altLangPaths.has(normalizePath(d.source))) {
        filteredDocs.push(d);
      }
    }

    // Rank by similarity (same-language boost) and cap non-doc sources (papers,
    // blogs, README, catalog) so the canonical docs always have room — see rank.ts.
    const sorted = selectContextDocs(filteredDocs, {
      isUserLang,
      maxContextDocs: MAX_CONTEXT_DOCS,
      maxNonDocDocs: MAX_NONDOC_DOCS,
    });

    const context = sorted
      .map((d, i) => `[Document ${i + 1}]\n${d.content}`)
      .join("\n\n---\n\n");

    const seenSources = new Set<string>();
    const sources = sorted
      .filter((d) => {
        if (seenSources.has(d.source)) return false;
        seenSources.add(d.source);
        return true;
      })
      .map((d) => ({
        source: d.source,
        similarity: d.similarity,
        ...(d.metadata?.title && { title: d.metadata.title }),
      }));

    const systemPrompt = `You are the Rotifer Protocol documentation assistant. Answer questions about the Rotifer Protocol based ONLY on the provided documentation context. If the context doesn't contain relevant information, say so honestly.

Rules:
- Be concise and accurate. Keep answers focused; use bullet points and short paragraphs.
- Do NOT include source citations, file paths, or [Source: ...] references in your response text. Source attribution is handled separately by the system.
- If a question is not about Rotifer Protocol, politely redirect.
- Respond in the same language as the user's question.
- Format responses with Markdown (headers, lists, code blocks) for readability.
- Do not reveal internal file paths, directory structures, or implementation details.

Documentation context:
${context || "No relevant documentation found."}`;

    const messages = [
      ...(body.history || []).slice(-4).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 1000),
      })),
      { role: "user", content: body.question },
    ];

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const llmRes = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LLM_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: LLM_MODEL,
              max_tokens: MAX_TOKENS,
              messages: [
                { role: "system", content: systemPrompt },
                ...messages,
              ],
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
                const delta = event.choices?.[0]?.delta?.content;
                if (delta) {
                  fullResponse += delta;
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ type: "text", text: delta })}\n\n`
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
            questionHash: qHash,
            cacheHit: false,
            sources: sources.map((s: { source: string }) => s.source),
            responseLength: fullResponse.length,
            responseTimeMs: Date.now() - startTime,
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
