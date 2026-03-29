import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HOUR_WINDOW_MS = 60 * 60 * 1000;
const BAN_DURATION_MS = 24 * 60 * 60 * 1000;
const MAX_PER_HOUR = 20;
const MAX_PER_DAY = 100;
const BAN_THRESHOLD = 50;

const ADAPTIVE_WINDOW_MS = 5 * 60 * 1000;
const ADAPTIVE_TRIGGER = 3;
const TIGHTENED_MAX_PER_HOUR = 5;
const TIGHTENED_DURATION_MS = 30 * 60 * 1000;

interface IPState {
  hourCount: number;
  hourResetAt: number;
  dailyCount: number;
  dailyDate: string;
  rateLimitHits: number;
  bannedUntil?: number;
  filterHits: number[];
  tightenedUntil?: number;
}

const memCache = new Map<string, IPState>();

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

export function recordContentFilterHit(ipHash: string): void {
  const now = Date.now();
  const cached = memCache.get(ipHash);
  if (!cached) return;

  cached.filterHits = (cached.filterHits || []).filter((t) => now - t < ADAPTIVE_WINDOW_MS);
  cached.filterHits.push(now);

  if (cached.filterHits.length >= ADAPTIVE_TRIGGER && (!cached.tightenedUntil || now >= cached.tightenedUntil)) {
    cached.tightenedUntil = now + TIGHTENED_DURATION_MS;
    console.log(`[rate-limiter] Adaptive tightening for ${ipHash.slice(0, 8)}: ${ADAPTIVE_TRIGGER} filter hits in 5min → ${TIGHTENED_MAX_PER_HOUR} req/h for 30min`);
  }
}

export async function checkRateLimit(
  ip: string
): Promise<{ allowed: boolean; retryAfter?: number; ipHash: string; reason?: string }> {
  const ipHash = await hashIp(ip);
  const now = Date.now();
  const today = todayStr();

  const cached = memCache.get(ipHash);
  const effectiveMaxPerHour = (cached?.tightenedUntil && now < cached.tightenedUntil)
    ? TIGHTENED_MAX_PER_HOUR : MAX_PER_HOUR;

  if (cached) {
    if (cached.tightenedUntil && now >= cached.tightenedUntil) {
      cached.tightenedUntil = undefined;
    }
    if (cached.bannedUntil && now < cached.bannedUntil) {
      return {
        allowed: false,
        retryAfter: Math.ceil((cached.bannedUntil - now) / 1000),
        ipHash,
        reason: "auto_ban",
      };
    }
    if (cached.bannedUntil && now >= cached.bannedUntil) {
      cached.bannedUntil = undefined;
      cached.rateLimitHits = 0;
    }
    if (cached.dailyDate === today && cached.dailyCount >= MAX_PER_DAY) {
      return { allowed: false, ipHash, reason: "daily_limit" };
    }
    if (now < cached.hourResetAt && cached.hourCount >= effectiveMaxPerHour) {
      cached.rateLimitHits = (cached.rateLimitHits || 0) + 1;
      if (cached.rateLimitHits >= BAN_THRESHOLD) {
        cached.bannedUntil = now + BAN_DURATION_MS;
        return {
          allowed: false,
          retryAfter: Math.ceil(BAN_DURATION_MS / 1000),
          ipHash,
          reason: "auto_ban",
        };
      }
      return {
        allowed: false,
        retryAfter: Math.ceil((cached.hourResetAt - now) / 1000),
        ipHash,
        reason: cached.tightenedUntil ? "adaptive_limit" : "hourly_limit",
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

        const existingCache = memCache.get(ipHash);
        const currentHits = existingCache?.rateLimitHits || 0;

        const prevFilterHits = existingCache?.filterHits || [];
        const prevTightened = existingCache?.tightenedUntil;

        if (dailyCount >= MAX_PER_DAY) {
          memCache.set(ipHash, {
            hourCount, hourResetAt: dbWindowStart + HOUR_WINDOW_MS,
            dailyCount, dailyDate: today, rateLimitHits: currentHits,
            filterHits: prevFilterHits, tightenedUntil: prevTightened,
          });
          return { allowed: false, ipHash, reason: "daily_limit" };
        }

        if (!isWindowExpired && hourCount >= effectiveMaxPerHour) {
          const retryAfter = Math.ceil((dbWindowStart + HOUR_WINDOW_MS - now) / 1000);
          const newHits = currentHits + 1;
          const banned = newHits >= BAN_THRESHOLD;
          memCache.set(ipHash, {
            hourCount, hourResetAt: dbWindowStart + HOUR_WINDOW_MS,
            dailyCount, dailyDate: today, rateLimitHits: newHits,
            filterHits: prevFilterHits, tightenedUntil: prevTightened,
            ...(banned && { bannedUntil: now + BAN_DURATION_MS }),
          });
          if (banned) {
            return { allowed: false, retryAfter: Math.ceil(BAN_DURATION_MS / 1000), ipHash, reason: "auto_ban" };
          }
          return { allowed: false, retryAfter, ipHash, reason: prevTightened && now < prevTightened ? "adaptive_limit" : "hourly_limit" };
        }

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
          dailyCount: newDailyCount, dailyDate: today,
          rateLimitHits: isWindowExpired ? 0 : currentHits,
          filterHits: prevFilterHits, tightenedUntil: prevTightened,
        });
      } else {
        await client.from("rate_limits").upsert({
          ip_hash: ipHash,
          request_count: 1,
          window_start: new Date().toISOString(),
          daily_count: 1,
          daily_date: today,
        });

        memCache.set(ipHash, {
          hourCount: 1, hourResetAt: now + HOUR_WINDOW_MS,
          dailyCount: 1, dailyDate: today, rateLimitHits: 0,
          filterHits: [], tightenedUntil: undefined,
        });
      }
    }
  } catch (err) {
    console.error("[rate-limiter] DB error, falling back to memory:", err);
    if (!cached || cached.dailyDate !== today) {
      memCache.set(ipHash, {
        hourCount: 1, hourResetAt: now + HOUR_WINDOW_MS,
        dailyCount: 1, dailyDate: today, rateLimitHits: 0,
        filterHits: [], tightenedUntil: undefined,
      });
    } else {
      cached.hourCount++;
      cached.dailyCount++;
    }
  }

  return { allowed: true, ipHash };
}
