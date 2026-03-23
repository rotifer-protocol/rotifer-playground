import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HOUR_WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_HOUR = 20;
const MAX_PER_DAY = 100;

const memCache = new Map<
  string,
  { hourCount: number; hourResetAt: number; dailyCount: number; dailyDate: string }
>();

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function getDailySalt(): string {
  return todayStr();
}

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip + getDailySalt());
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function checkRateLimit(
  ip: string
): Promise<{ allowed: boolean; retryAfter?: number; ipHash: string; reason?: string }> {
  const ipHash = await hashIp(ip);
  const now = Date.now();
  const today = todayStr();

  // Fast path: in-memory check
  const cached = memCache.get(ipHash);
  if (cached) {
    if (cached.dailyDate === today && cached.dailyCount >= MAX_PER_DAY) {
      return { allowed: false, ipHash, reason: "daily_limit" };
    }
    if (now < cached.hourResetAt && cached.hourCount >= MAX_PER_HOUR) {
      return {
        allowed: false,
        retryAfter: Math.ceil((cached.hourResetAt - now) / 1000),
        ipHash,
        reason: "hourly_limit",
      };
    }
  }

  // DB persistent check
  try {
    const ragUrl = Deno.env.get("RAG_SUPABASE_URL");
    const ragKey = Deno.env.get("RAG_SUPABASE_SERVICE_KEY");
    if (ragUrl && ragKey) {
      const client = createClient(ragUrl, ragKey);

      const { data } = await client
        .from("rate_limits")
        .select("request_count, window_start, daily_count, daily_date")
        .eq("ip_hash", ipHash)
        .single();

      if (data) {
        const dbWindowStart = new Date(data.window_start).getTime();
        const isNewDay = data.daily_date !== today;
        const isWindowExpired = now - dbWindowStart > HOUR_WINDOW_MS;

        let hourCount = isWindowExpired ? 0 : data.request_count;
        let dailyCount = isNewDay ? 0 : data.daily_count;

        // Check daily limit first
        if (dailyCount >= MAX_PER_DAY) {
          memCache.set(ipHash, {
            hourCount,
            hourResetAt: dbWindowStart + HOUR_WINDOW_MS,
            dailyCount,
            dailyDate: today,
          });
          return { allowed: false, ipHash, reason: "daily_limit" };
        }

        // Check hourly limit
        if (!isWindowExpired && hourCount >= MAX_PER_HOUR) {
          const retryAfter = Math.ceil((dbWindowStart + HOUR_WINDOW_MS - now) / 1000);
          memCache.set(ipHash, {
            hourCount,
            hourResetAt: dbWindowStart + HOUR_WINDOW_MS,
            dailyCount,
            dailyDate: today,
          });
          return { allowed: false, retryAfter, ipHash, reason: "hourly_limit" };
        }

        // Allowed — increment counters
        const newHourCount = isWindowExpired ? 1 : hourCount + 1;
        const newDailyCount = dailyCount + 1;

        await client.from("rate_limits").upsert({
          ip_hash: ipHash,
          request_count: newHourCount,
          window_start: isWindowExpired ? new Date().toISOString() : data.window_start,
          daily_count: newDailyCount,
          daily_date: today,
        });

        memCache.set(ipHash, {
          hourCount: newHourCount,
          hourResetAt: isWindowExpired ? now + HOUR_WINDOW_MS : dbWindowStart + HOUR_WINDOW_MS,
          dailyCount: newDailyCount,
          dailyDate: today,
        });
      } else {
        // First request from this IP
        await client.from("rate_limits").upsert({
          ip_hash: ipHash,
          request_count: 1,
          window_start: new Date().toISOString(),
          daily_count: 1,
          daily_date: today,
        });

        memCache.set(ipHash, {
          hourCount: 1,
          hourResetAt: now + HOUR_WINDOW_MS,
          dailyCount: 1,
          dailyDate: today,
        });
      }
    }
  } catch (err) {
    console.error("[rate-limiter] DB error, falling back to memory:", err);
    if (!cached || cached.dailyDate !== today) {
      memCache.set(ipHash, { hourCount: 1, hourResetAt: now + HOUR_WINDOW_MS, dailyCount: 1, dailyDate: today });
    } else {
      cached.hourCount++;
      cached.dailyCount++;
    }
  }

  return { allowed: true, ipHash };
}
