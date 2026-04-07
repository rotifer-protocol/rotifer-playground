/**
 * telegram-bot-notifier Gene (Hybrid)
 *
 * Pushes arbitrage signals to a Telegram group via Bot API.
 * Each signal is formatted as a structured message with Markdown v2 markup.
 *
 * Environment variables:
 *   ROTIFER_TELEGRAM_BOT_TOKEN — Telegram Bot token from @BotFather (required)
 *   ROTIFER_TELEGRAM_CHAT_ID   — Target group/channel chat ID (required)
 */

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

interface NotifierInput {
  signals: ArbSignal[];
  summary?: {
    totalMarketsAnalyzed: number;
    signalsFound: number;
    avgEdge: number;
    scanTimestamp: string;
  };
}

interface NotifierOutput {
  delivered: number;
  failed: number;
  report: {
    totalSignals: number;
    sentAt: string;
    chatId: string;
    messageIds: number[];
    errors: string[];
  };
}

interface GatewayContext {
  gatewayFetch: (url: string, options?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<{ status: number; body: string }>;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

const TYPE_EMOJI: Record<string, string> = {
  MISPRICING: "\u26a0\ufe0f",
  MULTI_OUTCOME_ARB: "\ud83c\udfaf",
  SPREAD: "\ud83d\udcca",
};

const CONFIDENCE_BAR = ["\u2591", "\u2592", "\u2593", "\u2588"];

function confidenceMeter(c: number): string {
  const filled = Math.round(c * 5);
  return CONFIDENCE_BAR[3].repeat(filled) + CONFIDENCE_BAR[0].repeat(5 - filled);
}

function escapeMarkdown(text: string): string {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function escapeNum(n: number): string {
  return String(n).replace(/\./g, "\\.");
}

const TYPE_LABEL: Record<string, string> = {
  MISPRICING: "\u5b9a\u4ef7\u504f\u5dee",
  MULTI_OUTCOME_ARB: "\u591a\u7ed3\u679c\u5957\u5229",
  SPREAD: "\u4e70\u5356\u4ef7\u5dee",
};

const DIRECTION_LABEL: Record<string, string> = {
  SELL_BOTH: "\u505a\u7a7a\u53cc\u65b9",
  BUY_BOTH: "\u4e70\u5165\u53cc\u65b9",
  SELL_WEAKEST: "\u505a\u7a7a\u6700\u5f31\u9879",
  BUY_STRONGEST: "\u4e70\u5165\u6700\u5f3a\u9879",
  PROVIDE_LIQUIDITY: "\u63d0\u4f9b\u6d41\u52a8\u6027",
};

function formatSignalMessage(sig: ArbSignal, index: number): string {
  const emoji = TYPE_EMOJI[sig.type] || "\ud83d\udd14";
  const meter = confidenceMeter(sig.confidence);
  const marketUrl = `https://polymarket.com/event/${sig.marketId}`;
  const typeLabel = TYPE_LABEL[sig.type] || sig.type;
  const dirLabel = DIRECTION_LABEL[sig.direction] || sig.direction;

  const lines = [
    `${emoji} *\u4fe1\u53f7 \\#${index + 1}* \\| \`${escapeMarkdown(sig.signalId)}\``,
    ``,
    `*\u7c7b\u578b:* ${escapeMarkdown(typeLabel)}`,
    `*\u8fb9\u9645:* ${escapeNum(sig.edge)}%`,
    `*\u4fe1\u5fc3\u5ea6:* ${meter} ${Math.round(sig.confidence * 100)}%`,
    `*\u65b9\u5411:* ${escapeMarkdown(dirLabel)}`,
    ``,
    `\u2753 ${escapeMarkdown(sig.question.slice(0, 100))}`,
    ``,
    `\ud83d\udcdd ${escapeMarkdown(sig.description.slice(0, 200))}`,
    ``,
    `[\u5728 Polymarket \u67e5\u770b](${marketUrl})`,
  ];

  return lines.join("\n");
}

function formatSummaryMessage(
  summary: NotifierInput["summary"],
  delivered: number,
  failed: number,
): string {
  if (!summary) return "";

  const lines = [
    `\ud83d\udce1 *Polymarket \u5957\u5229\u626b\u63cf\u62a5\u544a*`,
    ``,
    `\ud83d\udd0d \u626b\u63cf\u5e02\u573a\u6570: ${summary.totalMarketsAnalyzed}`,
    `\ud83c\udfaf \u53d1\u73b0\u4fe1\u53f7: ${summary.signalsFound}`,
    `\ud83d\udcca \u5e73\u5747\u8fb9\u9645: ${escapeNum(summary.avgEdge)}%`,
    `\u2705 \u5df2\u63a8\u9001: ${delivered} \\| \u274c \u5931\u8d25: ${failed}`,
    `\u23f0 ${escapeMarkdown(summary.scanTimestamp || new Date().toISOString())}`,
  ];

  return lines.join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function express(
  input: NotifierInput,
  ctx?: GatewayContext,
): Promise<NotifierOutput> {
  const gf = ctx?.gatewayFetch;
  if (!gf) {
    throw new Error("telegram-bot-notifier is a Hybrid gene — gatewayFetch is required");
  }

  const botToken = requireEnv("ROTIFER_TELEGRAM_BOT_TOKEN");
  const chatId = requireEnv("ROTIFER_TELEGRAM_CHAT_ID");
  const signals = input.signals || [];

  const messageIds: number[] = [];
  const errors: string[] = [];
  let delivered = 0;
  let failed = 0;

  for (let i = 0; i < signals.length; i++) {
    const text = formatSignalMessage(signals[i], i);

    try {
      const res = await gf(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "MarkdownV2",
          disable_web_page_preview: true,
        }),
      });

      const data = JSON.parse(res.body);

      if (res.status === 200 && data.ok) {
        messageIds.push(data.result.message_id);
        delivered++;
      } else {
        const errMsg = data.description || `HTTP ${res.status}`;
        errors.push(`Signal ${signals[i].signalId}: ${errMsg}`);
        failed++;
      }
    } catch (err: any) {
      errors.push(`Signal ${signals[i].signalId}: ${err.message}`);
      failed++;
    }

    // Telegram rate limit: ~30 msg/sec to same group, be conservative
    if (i < signals.length - 1) {
      await sleep(350);
    }
  }

  // Send summary as final message
  if (input.summary && (delivered > 0 || signals.length > 0)) {
    const summaryText = formatSummaryMessage(input.summary, delivered, failed);
    if (summaryText) {
      try {
        const res = await gf(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: summaryText,
            parse_mode: "MarkdownV2",
            disable_web_page_preview: true,
          }),
        });

        const data = JSON.parse(res.body);
        if (res.status === 200 && data.ok) {
          messageIds.push(data.result.message_id);
        }
      } catch {
        // Summary failure is non-critical
      }
    }
  }

  return {
    delivered,
    failed,
    report: {
      totalSignals: signals.length,
      sentAt: new Date().toISOString(),
      chatId,
      messageIds,
      errors,
    },
  };
}
