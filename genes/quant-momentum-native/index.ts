interface Signal {
  index: number;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
}

interface MomentumInput {
  prices: number[];
  fastWindow?: number;
  slowWindow?: number;
  momentumThreshold?: number;
  stopLoss?: number;
}

interface MomentumOutput {
  signals: Signal[];
  pnl: number;
  sharpeRatio: number;
  maxDrawdown: number;
  winRate: number;
  tradeCount: number;
}

function sma(prices: number[], window: number, end: number): number {
  if (end < window) return prices[end];
  let sum = 0;
  for (let i = end - window + 1; i <= end; i++) {
    sum += prices[i];
  }
  return sum / window;
}

export function express(input: MomentumInput): MomentumOutput {
  const prices = input.prices;
  const fast = Math.max(2, input.fastWindow ?? 5);
  const slow = Math.max(fast + 1, input.slowWindow ?? 20);
  const threshold = input.momentumThreshold ?? 0.02;
  const stopLoss = input.stopLoss ?? 0.05;

  if (!prices || prices.length < slow + 1) {
    return {
      signals: [],
      pnl: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      winRate: 0,
      tradeCount: 0,
    };
  }

  const signals: Signal[] = [];
  const returns: number[] = [];
  let position: "LONG" | "NONE" = "NONE";
  let entryPrice = 0;
  let wins = 0;
  let losses = 0;
  let equity = 1.0;
  let peak = 1.0;
  let maxDD = 0;

  for (let i = slow; i < prices.length; i++) {
    const fastMA = sma(prices, fast, i);
    const slowMA = sma(prices, slow, i);
    const momentum = (fastMA - slowMA) / slowMA;

    let action: "BUY" | "SELL" | "HOLD" = "HOLD";
    let confidence = Math.min(1, Math.abs(momentum) / (threshold * 3));

    if (position === "NONE" && momentum > threshold) {
      action = "BUY";
      position = "LONG";
      entryPrice = prices[i];
    } else if (position === "LONG") {
      const unrealizedPnl = (prices[i] - entryPrice) / entryPrice;

      if (momentum < -threshold) {
        action = "SELL";
        const tradePnl = unrealizedPnl;
        equity *= 1 + tradePnl;
        returns.push(tradePnl);
        if (tradePnl > 0) wins++;
        else losses++;
        position = "NONE";
      } else if (unrealizedPnl < -stopLoss) {
        action = "SELL";
        confidence = 0.9;
        equity *= 1 + unrealizedPnl;
        returns.push(unrealizedPnl);
        losses++;
        position = "NONE";
      }
    }

    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;

    signals.push({ index: i, action, confidence });
  }

  if (position === "LONG") {
    const finalPnl = (prices[prices.length - 1] - entryPrice) / entryPrice;
    equity *= 1 + finalPnl;
    returns.push(finalPnl);
    if (finalPnl > 0) wins++;
    else losses++;
  }

  const totalTrades = wins + losses;
  const totalPnl = (equity - 1) * 100;

  let sharpe = 0;
  if (returns.length > 1) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    if (std > 0) {
      sharpe = (mean / std) * Math.sqrt(252);
    }
  }

  return {
    signals,
    pnl: Math.round(totalPnl * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    maxDrawdown: Math.round(maxDD * 10000) / 100,
    winRate: totalTrades > 0 ? Math.round((wins / totalTrades) * 10000) / 100 : 0,
    tradeCount: totalTrades,
  };
}
