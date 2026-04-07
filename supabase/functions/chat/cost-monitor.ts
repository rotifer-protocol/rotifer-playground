import { createClient } from "jsr:@supabase/supabase-js@2";

const DAILY_LIMIT = 500;
const COST_ALERT_THRESHOLD = 5.0; // USD

let dailyCount = 0;
let dailyDate = "";
let estimatedCost = 0;
let dbSynced = false;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function resetIfNewDay(): void {
  const today = todayStr();
  if (today !== dailyDate) {
    dailyCount = 0;
    estimatedCost = 0;
    dailyDate = today;
    dbSynced = false;
  }
}

async function syncFromDb(): Promise<void> {
  if (dbSynced) return;
  try {
    const ragUrl = Deno.env.get("RAG_SUPABASE_URL");
    const ragKey = Deno.env.get("RAG_SUPABASE_SERVICE_KEY");
    if (!ragUrl || !ragKey) return;

    const client = createClient(ragUrl, ragKey);
    const today = todayStr();

    const { count } = await client
      .from("chat_analytics")
      .select("*", { count: "exact", head: true })
      .gte("created_at", `${today}T00:00:00Z`)
      .lt("created_at", `${today}T23:59:59Z`);

    if (count !== null) {
      dailyCount = count;
    }
    dbSynced = true;
  } catch {
    // fallback to memory count
  }
}

export async function checkDailyLimit(): Promise<boolean> {
  resetIfNewDay();
  await syncFromDb();
  return dailyCount < DAILY_LIMIT;
}

export async function recordCost(model: string, _responseChars: number): Promise<void> {
  resetIfNewDay();
  dailyCount++;

  const costPerCall = model.includes("deepseek") ? 0.0005 : model.includes("haiku") ? 0.002 : 0.005;
  estimatedCost += costPerCall;

  if (estimatedCost > COST_ALERT_THRESHOLD) {
    console.warn(
      `[COST ALERT] Daily LLM cost estimate: $${estimatedCost.toFixed(2)} (${dailyCount} calls)`
    );
  }
}
