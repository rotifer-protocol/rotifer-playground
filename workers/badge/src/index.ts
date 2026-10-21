export interface Env {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  BADGE_KV: KVNamespace;
  BADGE_AUTH_TOKEN: string;
}

interface BadgeResponse {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  cacheSeconds?: number;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GRADE_COLORS: Record<string, string> = {
  A: "brightgreen",
  B: "green",
  C: "yellow",
  D: "red",
  "?": "lightgrey",
};

const REPUTATION_COLORS = [
  { min: 80, color: "brightgreen" },
  { min: 60, color: "green" },
  { min: 40, color: "yellow" },
  { min: 20, color: "orange" },
  { min: 0, color: "red" },
];

function badge(label: string, message: string, color: string): BadgeResponse {
  return { schemaVersion: 1, label, message, color, cacheSeconds: 3600 };
}

function notFound(label: string): BadgeResponse {
  return badge(label, "not found", "lightgrey");
}

function reputationColor(score: number): string {
  for (const tier of REPUTATION_COLORS) {
    if (score >= tier.min) return tier.color;
  }
  return "lightgrey";
}

async function supabaseGet(
  env: Env,
  path: string,
): Promise<{ data: unknown; status: number }> {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      Accept: "application/json",
    },
  });
  const data = await res.json();
  return { data, status: res.status };
}

/**
 * Resolve a gene identifier to a UUID.
 * Accepts: UUID, plain name, or @owner/name (qualified name).
 * Returns the gene UUID or null if not found.
 */
async function resolveGeneId(
  identifier: string,
  env: Env,
): Promise<string | null> {
  if (UUID_RE.test(identifier)) return identifier;

  let ownerFilter = "";
  let name = identifier;

  if (identifier.startsWith("@") && identifier.includes("/")) {
    const slashIdx = identifier.indexOf("/");
    const owner = identifier.slice(1, slashIdx);
    name = identifier.slice(slashIdx + 1);
    ownerFilter = `&profiles.username=eq.${encodeURIComponent(owner)}`;
  }

  const qs = `name=eq.${encodeURIComponent(name)}&published=eq.true&select=id,profiles!inner(username)&order=created_at.desc&limit=1${ownerFilter}`;
  const { data, status } = await supabaseGet(env, `/rest/v1/genes?${qs}`);
  if (status !== 200 || !Array.isArray(data) || data.length === 0) return null;

  return (data[0] as { id: string }).id;
}

interface SafetyPayload {
  gene_id: string;
  version_id?: string;
  grade?: string;
  scanner_version: string;
  findings_count?: number;
  mode?: "self-reported" | "skipped";
}

const SAFETY_RATE_LIMIT = 30; // writes per IP per window
const SAFETY_RATE_WINDOW = 60; // seconds

/**
 * KV fixed-window rate limit (R10). Returns true if allowed, false once `ip`
 * has hit `limit` within the current `windowSec` window. KV is eventually
 * consistent (not atomic), so this is best-effort abuse prevention rather than a
 * hard boundary — sufficient to gate the auth'd POST /safety write endpoint
 * against flooding (v0.8 security checklist §2.1, deferred to v0.9).
 */
export async function rateLimit(
  kv: KVNamespace,
  ip: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const windowStart = Math.floor(Date.now() / 1000 / windowSec) * windowSec;
  const key = `rl:safety:${ip}:${windowStart}`;
  const current = parseInt((await kv.get(key)) || "0", 10);
  if (current >= limit) return false;
  await kv.put(key, String(current + 1), { expirationTtl: windowSec + 5 });
  return true;
}

async function handleSafetyPost(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.BADGE_AUTH_TOKEN) {
    return Response.json({ error: "server not configured" }, { status: 500, headers: CORS_HEADERS });
  }

  // R10: rate-limit per IP before auth, so flooding (even with bad tokens) is capped.
  if (env.BADGE_KV) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const allowed = await rateLimit(env.BADGE_KV, ip, SAFETY_RATE_LIMIT, SAFETY_RATE_WINDOW);
    if (!allowed) {
      return Response.json(
        { error: "rate limit exceeded" },
        { status: 429, headers: { ...CORS_HEADERS, "Retry-After": String(SAFETY_RATE_WINDOW) } },
      );
    }
  }

  const auth = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.BADGE_AUTH_TOKEN}`;
  const encoder = new TextEncoder();
  const a = encoder.encode(auth);
  const b = encoder.encode(expected);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: CORS_HEADERS });
  }

  let body: SafetyPayload;
  try {
    body = (await request.json()) as SafetyPayload;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400, headers: CORS_HEADERS });
  }

  if (!body.gene_id || !UUID_RE.test(body.gene_id)) {
    return Response.json({ error: "gene_id must be a valid UUID" }, { status: 400, headers: CORS_HEADERS });
  }

  const mode = body.mode ?? "self-reported";
  if (mode !== "self-reported" && mode !== "skipped") {
    return Response.json({ error: "mode must be 'self-reported' or 'skipped'" }, { status: 400, headers: CORS_HEADERS });
  }

  if (mode === "self-reported") {
    if (!body.grade || !["A", "B", "C", "D"].includes(body.grade)) {
      return Response.json({ error: "grade must be A, B, C, or D" }, { status: 400, headers: CORS_HEADERS });
    }
  }

  if (!body.scanner_version) {
    return Response.json({ error: "scanner_version is required" }, { status: 400, headers: CORS_HEADERS });
  }

  const kvValue = JSON.stringify({
    mode,
    grade: mode === "skipped" ? null : body.grade,
    version_id: body.version_id ?? null,
    scanner_version: body.scanner_version,
    scanned_at: new Date().toISOString(),
    source: "self-reported",
    findings_count: mode === "skipped" ? null : (body.findings_count ?? 0),
  });

  const ttl = 90 * 24 * 3600; // 90 days
  await env.BADGE_KV.put(`safety:${body.gene_id}`, kvValue, { expirationTtl: ttl });

  return Response.json(
    { ok: true, gene_id: body.gene_id, mode, grade: mode === "skipped" ? null : body.grade },
    { status: 200, headers: CORS_HEADERS },
  );
}

function renderSafetyBadge(payload: { mode?: string; grade?: string | null }): BadgeResponse {
  if (payload.mode === "skipped") {
    return badge("rotifer safety", "skipped", "lightgrey");
  }
  const grade = payload.grade ?? "?";
  return badge("rotifer safety", grade, GRADE_COLORS[grade] ?? "lightgrey");
}

async function handleSafety(identifier: string, env: Env): Promise<BadgeResponse> {
  if (!env.BADGE_KV) return badge("rotifer safety", "KV not configured", "lightgrey");

  const cached = await env.BADGE_KV.get(`safety:${identifier}`);
  if (cached) {
    const result = JSON.parse(cached) as { mode?: string; grade?: string | null };
    return renderSafetyBadge(result);
  }

  const geneId = await resolveGeneId(identifier, env);
  if (!geneId) return notFound("rotifer safety");

  if (geneId !== identifier) {
    const byUuid = await env.BADGE_KV.get(`safety:${geneId}`);
    if (byUuid) {
      const result = JSON.parse(byUuid) as { mode?: string; grade?: string | null };
      return renderSafetyBadge(result);
    }
  }

  return badge("rotifer safety", "not scanned", "lightgrey");
}

async function handleGene(identifier: string, env: Env): Promise<BadgeResponse> {
  const geneId = await resolveGeneId(identifier, env);
  if (!geneId) return notFound("rotifer gene");

  const { data, status } = await supabaseGet(
    env,
    `/rest/v1/genes?id=eq.${geneId}&select=name,reputation_score`,
  );
  if (status !== 200 || !Array.isArray(data) || data.length === 0) {
    return notFound("rotifer gene");
  }
  const gene = data[0] as { name: string; reputation_score: number | null };
  const score = gene.reputation_score ?? 0;
  const pct = Math.round(score * 100);
  return badge("rotifer reputation", String(pct), reputationColor(pct));
}

async function handleGeneFitness(identifier: string, env: Env): Promise<BadgeResponse> {
  const geneId = await resolveGeneId(identifier, env);
  if (!geneId) return notFound("rotifer fitness");

  const { data, status } = await supabaseGet(
    env,
    `/rest/v1/arena_entries?gene_id=eq.${geneId}&select=fitness_value&order=created_at.desc&limit=1`,
  );
  if (status !== 200 || !Array.isArray(data) || data.length === 0) {
    return notFound("rotifer fitness");
  }
  const entry = data[0] as { fitness_value: number | null };
  const score = entry.fitness_value ?? 0;
  const pct = Math.round(score * 100);
  return badge("rotifer F(g)", String(pct), reputationColor(pct));
}

async function handleDev(username: string, env: Env): Promise<BadgeResponse> {
  const cleanName = username.startsWith("@") ? username.slice(1) : username;

  const { data: profileData, status: pStatus } = await supabaseGet(
    env,
    `/rest/v1/profiles?username=eq.${encodeURIComponent(cleanName)}&select=id`,
  );
  if (pStatus !== 200 || !Array.isArray(profileData) || profileData.length === 0) {
    return notFound("rotifer dev");
  }
  const userId = (profileData[0] as { id: string }).id;

  const { data, status } = await supabaseGet(
    env,
    `/rest/v1/developer_reputation?user_id=eq.${userId}&select=score`,
  );
  if (status !== 200 || !Array.isArray(data) || data.length === 0) {
    return notFound("rotifer dev");
  }
  const dev = data[0] as { score: number };
  const pct = Math.round(dev.score * 100);
  return badge("rotifer dev", String(pct), reputationColor(pct));
}

function parseRoute(pathname: string): { handler: string; param: string } | null {
  const decoded = decodeURIComponent(pathname);
  const segments = decoded.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2) return null;

  if (segments[0] === "safety") return { handler: "safety", param: segments.slice(1).join("/") };

  if (segments[0] === "gene") {
    const lastSeg = segments[segments.length - 1];
    if (lastSeg === "fitness") {
      return { handler: "gene-fitness", param: segments.slice(1, -1).join("/") };
    }
    return { handler: "gene", param: segments.slice(1).join("/") };
  }

  if (segments[0] === "dev") return { handler: "dev", param: segments[1] };
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const route = parseRoute(url.pathname);

    if (request.method === "POST") {
      if (url.pathname === "/safety" || url.pathname === "/safety/") {
        return handleSafetyPost(request, env);
      }
      return Response.json(badge("rotifer", "method not allowed", "lightgrey"), {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    if (request.method !== "GET") {
      return Response.json(badge("rotifer", "method not allowed", "lightgrey"), {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    let result: BadgeResponse;

    if (!route) {
      result = badge("rotifer", "badge API", "blue");
    } else {
      switch (route.handler) {
        case "safety":
          result = await handleSafety(route.param, env);
          break;
        case "gene":
          result = await handleGene(route.param, env);
          break;
        case "gene-fitness":
          result = await handleGeneFitness(route.param, env);
          break;
        case "dev":
          result = await handleDev(route.param, env);
          break;
        default:
          result = notFound("rotifer");
      }
    }

    return Response.json(result, {
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "public, max-age=3600",
      },
    });
  },
};
