/**
 * spread-analyzer Gene (Native)
 *
 * Pure-computation gene that analyzes market snapshots for arbitrage signals.
 * Three detection strategies:
 *   1. Binary mispricing: Yes + No prices deviating from 1.0
 *   2. Multi-outcome arb: sum of probabilities across grouped markets != 1.0
 *   3. Spread opportunity: wide bid-ask spreads indicating liquidity gaps
 */

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

interface AnalyzerInput {
  markets: MarketSnapshot[];
  scannedAt?: string;
  mispricingThreshold?: number;
  minSpread?: number;
  minConfidence?: number;
}

interface ArbSignal {
  signalId: string;
  type: "MISPRICING" | "MULTI_OUTCOME_ARB" | "SPREAD";
  marketId: string;
  question: string;
  description: string;
  edge: number;
  confidence: number;
  direction: string;
  prices: Record<string, number>;
  timestamp: string;
}

interface AnalyzerOutput {
  signals: ArbSignal[];
  summary: {
    totalMarketsAnalyzed: number;
    signalsFound: number;
    avgEdge: number;
    scanTimestamp: string;
  };
}

let signalCounter = 0;
function nextSignalId(): string {
  return `SIG-${Date.now().toString(36)}-${(++signalCounter).toString(36).padStart(4, "0")}`;
}

function detectMispricing(
  market: MarketSnapshot,
  threshold: number,
  timestamp: string,
): ArbSignal | null {
  if (market.outcomes.length !== 2) return null;

  const prices = market.outcomePrices;
  if (prices.length !== 2) return null;

  const sum = prices[0] + prices[1];
  const deviation = Math.abs(sum - 1.0);

  if (deviation < threshold) return null;

  const overpriced = sum > 1.0;
  const edge = deviation;
  const confidence = Math.min(1, (deviation / threshold) * 0.5);

  return {
    signalId: nextSignalId(),
    type: "MISPRICING",
    marketId: market.id,
    question: market.question,
    description: overpriced
      ? `价格总和 = ${sum.toFixed(4)}（>${1 + threshold}），双方结果均被高估，可考虑做空双方。`
      : `价格总和 = ${sum.toFixed(4)}（<${1 - threshold}），双方结果均被低估，可考虑买入双方。`,
    edge: Math.round(edge * 10000) / 100,
    confidence: Math.round(confidence * 100) / 100,
    direction: overpriced ? "SELL_BOTH" : "BUY_BOTH",
    prices: {
      [market.outcomes[0]]: prices[0],
      [market.outcomes[1]]: prices[1],
      sum,
    },
    timestamp,
  };
}

function detectMultiOutcomeArb(
  group: MarketSnapshot[],
  threshold: number,
  timestamp: string,
): ArbSignal | null {
  if (group.length < 2) return null;

  const yesSum = group.reduce((s, m) => {
    const yesPrice = m.outcomePrices[0] ?? 0;
    return s + yesPrice;
  }, 0);

  const deviation = Math.abs(yesSum - 1.0);
  if (deviation < threshold) return null;

  const overpriced = yesSum > 1.0;
  const edge = deviation;
  const confidence = Math.min(1, (deviation / threshold) * 0.4);

  const prices: Record<string, number> = {};
  for (const m of group) {
    prices[m.question.slice(0, 60)] = m.outcomePrices[0] ?? 0;
  }
  prices["yes_price_sum"] = yesSum;

  return {
    signalId: nextSignalId(),
    type: "MULTI_OUTCOME_ARB",
    marketId: group[0].eventSlug,
    question: group[0].eventTitle || group[0].eventSlug,
    description: overpriced
      ? `事件「${group[0].eventTitle}」：${group.length} 个结果的 Yes 价格总和 = ${yesSum.toFixed(4)}，整体高估，可做空最弱项。`
      : `事件「${group[0].eventTitle}」：${group.length} 个结果的 Yes 价格总和 = ${yesSum.toFixed(4)}，整体低估，可买入最强项。`,
    edge: Math.round(edge * 10000) / 100,
    confidence: Math.round(confidence * 100) / 100,
    direction: overpriced ? "SELL_WEAKEST" : "BUY_STRONGEST",
    prices,
    timestamp,
  };
}

function detectSpread(
  market: MarketSnapshot,
  minSpread: number,
  timestamp: string,
): ArbSignal | null {
  const spread = market.spread ?? (market.bestAsk - market.bestBid);
  if (spread < minSpread || market.bestBid <= 0 || market.bestAsk <= 0) return null;

  const midpoint = (market.bestBid + market.bestAsk) / 2;
  const edge = spread;
  const volumeFactor = Math.min(1, market.volume24hr / 50_000);
  const confidence = Math.min(1, (spread / minSpread) * 0.3 * volumeFactor);

  if (confidence < 0.1) return null;

  return {
    signalId: nextSignalId(),
    type: "SPREAD",
    marketId: market.id,
    question: market.question,
    description: `买卖价差 = ${(spread * 100).toFixed(1)}%（买价: ${market.bestBid}，卖价: ${market.bestAsk}），中间价: ${midpoint.toFixed(3)}。`,
    edge: Math.round(edge * 10000) / 100,
    confidence: Math.round(confidence * 100) / 100,
    direction: "PROVIDE_LIQUIDITY",
    prices: {
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      spread,
      midpoint,
    },
    timestamp,
  };
}

export function express(input: AnalyzerInput): AnalyzerOutput {
  const markets = input.markets || [];
  const timestamp = input.scannedAt || new Date().toISOString();
  const mispricingThreshold = input.mispricingThreshold ?? 0.02;
  const minSpread = input.minSpread ?? 0.03;
  const minConfidence = input.minConfidence ?? 0.3;

  signalCounter = 0;
  const signals: ArbSignal[] = [];

  // Strategy 1: binary mispricing
  for (const m of markets) {
    const sig = detectMispricing(m, mispricingThreshold, timestamp);
    if (sig && sig.confidence >= minConfidence) signals.push(sig);
  }

  // Strategy 2: multi-outcome event arb
  const eventGroups = new Map<string, MarketSnapshot[]>();
  for (const m of markets) {
    if (m.eventSlug) {
      const group = eventGroups.get(m.eventSlug) || [];
      group.push(m);
      eventGroups.set(m.eventSlug, group);
    }
  }
  for (const group of eventGroups.values()) {
    const sig = detectMultiOutcomeArb(group, mispricingThreshold, timestamp);
    if (sig && sig.confidence >= minConfidence) signals.push(sig);
  }

  // Strategy 3: spread opportunity
  for (const m of markets) {
    const sig = detectSpread(m, minSpread, timestamp);
    if (sig && sig.confidence >= minConfidence) signals.push(sig);
  }

  // Sort by edge descending
  signals.sort((a, b) => b.edge - a.edge);

  const avgEdge = signals.length > 0
    ? Math.round((signals.reduce((s, sig) => s + sig.edge, 0) / signals.length) * 100) / 100
    : 0;

  return {
    signals,
    summary: {
      totalMarketsAnalyzed: markets.length,
      signalsFound: signals.length,
      avgEdge,
      scanTimestamp: timestamp,
    },
  };
}
