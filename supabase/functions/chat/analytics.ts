import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface AnalyticsEvent {
  questionHash: string;
  cacheHit: boolean;
  sources: string[];
  responseLength?: number;
  responseTimeMs?: number;
  blocked?: boolean;
  blockReason?: string;
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
      response_time_ms: event.responseTimeMs || 0,
      blocked: event.blocked || false,
      block_reason: event.blockReason || null,
      category: classifyQuestion(event.sources),
    });
  } catch (err) {
    console.error("[analytics] Failed to record:", err);
  }
}

export async function recordSecurityEvent(
  eventType: string,
  ipHash: string,
  questionHash: string,
  reason: string
): Promise<void> {
  try {
    const ragUrl = Deno.env.get("RAG_SUPABASE_URL");
    const ragKey = Deno.env.get("RAG_SUPABASE_SERVICE_KEY");
    if (!ragUrl || !ragKey) return;

    const client = createClient(ragUrl, ragKey);

    await client.from("security_events").insert({
      event_type: eventType,
      ip_hash: ipHash,
      question_hash: questionHash,
      reason,
    });

    const shouldAlert =
      eventType === "content_filter" || reason === "auto_ban";
    if (shouldAlert) {
      await sendSecurityAlert(eventType, reason, ipHash).catch((err) =>
        console.error("[security] Alert delivery failed:", err)
      );
    }
  } catch (err) {
    console.error("[security] Failed to record event:", err);
  }
}

async function sendSecurityAlert(
  eventType: string,
  reason: string,
  ipHash: string
): Promise<void> {
  const webhookUrl = Deno.env.get("SECURITY_ALERT_WEBHOOK");
  if (!webhookUrl) return;

  const severity = reason === "auto_ban" ? "HIGH" : "MEDIUM";
  const message = {
    content: `**[${severity}] Security Alert**\nType: \`${eventType}\`\nReason: \`${reason}\`\nIP: \`${ipHash.slice(0, 12)}...\`\nTime: ${new Date().toISOString()}`,
  };

  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
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
