/**
 * polymarket-scanner Gene (Hybrid)
 *
 * Fetches active Polymarket prediction markets via the Gamma API,
 * enriches with CLOB spread data, and filters by volume/liquidity.
 */

interface ScannerInput {
  minVolume?: number;
  minLiquidity?: number;
  limit?: number;
  onlyMultiOutcome?: boolean;
}

interface MarketSnapshot {
  id: string;
  question: string;
  slug: string;
  outcomes: string[];
  outcomePrices: number[];
  bestBid: number;
  bestAsk: number;
  spread: number;
  volume24hr: number;
  liquidity: number;
  endDate: string;
  eventSlug: string;
  eventTitle: string;
  clobTokenIds: string[];
}

interface ScannerOutput {
  markets: MarketSnapshot[];
  scannedAt: string;
  totalFetched: number;
}

interface GatewayContext {
  gatewayFetch: (url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<{ status: number; body: string }>;
}

const GAMMA_API = process.env.POLYMARKET_PROXY_URL
  ? `${process.env.POLYMARKET_PROXY_URL}/gamma`
  : "https://gamma-api.polymarket.com";

function parseOutcomePrices(raw: string | string[] | number[]): number[] {
  if (Array.isArray(raw)) return raw.map(Number);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch {
    return [];
  }
}

function parseOutcomes(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseClobTokenIds(raw: string | string[]): string[] {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function express(
  input: ScannerInput,
  ctx?: GatewayContext,
): Promise<ScannerOutput> {
  const gf = ctx?.gatewayFetch;
  if (!gf) {
    throw new Error("polymarket-scanner is a Hybrid gene — gatewayFetch is required");
  }

  const minVolume = input.minVolume ?? 10_000;
  const minLiquidity = input.minLiquidity ?? 5_000;
  const limit = Math.min(input.limit ?? 50, 100);
  const onlyMulti = input.onlyMultiOutcome ?? false;

  const url = `${GAMMA_API}/markets?limit=${limit}&active=true&closed=false`;
  const res = await gf(url, { method: "GET" });

  if (res.status !== 200) {
    throw new Error(`Gamma API returned ${res.status}: ${res.body.slice(0, 300)}`);
  }

  const rawMarkets: any[] = JSON.parse(res.body);

  const markets: MarketSnapshot[] = [];

  for (const m of rawMarkets) {
    const vol24 = m.volume24hr ?? 0;
    const liq = m.liquidityNum ?? m.liquidity ?? 0;

    if (vol24 < minVolume || liq < minLiquidity) continue;

    const event = Array.isArray(m.events) && m.events.length > 0 ? m.events[0] : null;
    if (onlyMulti && !event) continue;

    const outcomes = parseOutcomes(m.outcomes);
    const outcomePrices = parseOutcomePrices(m.outcomePrices);
    const clobTokenIds = parseClobTokenIds(m.clobTokenIds);

    markets.push({
      id: m.id,
      question: m.question ?? "",
      slug: m.slug ?? "",
      outcomes,
      outcomePrices,
      bestBid: m.bestBid ?? 0,
      bestAsk: m.bestAsk ?? 0,
      spread: m.spread ?? 0,
      volume24hr: vol24,
      liquidity: liq,
      endDate: m.endDate ?? "",
      eventSlug: event?.slug ?? "",
      eventTitle: event?.title ?? "",
      clobTokenIds,
    });
  }

  return {
    markets,
    scannedAt: new Date().toISOString(),
    totalFetched: rawMarkets.length,
  };
}
