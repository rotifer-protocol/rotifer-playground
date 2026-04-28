const ALLOWED_ORIGINS = (
  Deno.env.get("ALLOWED_ORIGIN") ||
  "https://rotifer.dev,https://www.rotifer.dev"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function getCorsHeaders(requestOrigin?: string | null): Record<string, string> {
  const allowedOrigin = requestOrigin && isAllowedOrigin(requestOrigin)
    ? requestOrigin
    : ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info",
    "Access-Control-Max-Age": "86400",
  };
}

export const corsHeaders = getCorsHeaders();

export function handleCors(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}
