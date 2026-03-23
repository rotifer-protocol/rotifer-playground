import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface AnalyticsEvent {
  questionHash: string;
  cacheHit: boolean;
  sources: string[];
  responseLength?: number;
}

export async function recordAnalytics(event: AnalyticsEvent): Promise<void> {
  try {
    const ragUrl = Deno.env.get("RAG_SUPABASE_URL");
    const ragKey = Deno.env.get("RAG_SUPABASE_SERVICE_KEY");
    if (!ragUrl || !ragKey) return;

    const client = createClient(ragUrl, ragKey);

    await client.from("chat_analytics").insert({
      question_hash: event.questionHash,
      cache_hit: event.cacheHit,
      top_sources: event.sources.slice(0, 3),
      response_length: event.responseLength || 0,
      category: classifyQuestion(event.sources),
    });
  } catch (err) {
    console.error("[analytics] Failed to record:", err);
  }
}

function classifyQuestion(sources: string[]): string {
  if (sources.length === 0) return "no-match";

  const sourceStr = sources.join(" ").toLowerCase();
  if (sourceStr.includes("getting-started") || sourceStr.includes("guides")) return "tutorial";
  if (sourceStr.includes("cli")) return "cli";
  if (sourceStr.includes("spec")) return "specification";
  if (sourceStr.includes("faq")) return "faq";
  if (sourceStr.includes("blog")) return "blog";
  return "general";
}
