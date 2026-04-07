interface FormatterInput {
  data: unknown;
  format?: "human" | "json" | "table";
}

interface FormatterOutput {
  formatted: string;
  type: string;
}

function weiToEth(wei: string | bigint): string {
  const value = typeof wei === "string" ? BigInt(wei) : wei;
  const ethWhole = value / BigInt(1e18);
  const ethFraction = value % BigInt(1e18);
  const fractionStr = ethFraction.toString().padStart(18, "0").slice(0, 6);
  return `${ethWhole}.${fractionStr}`;
}

function shortenAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function hexToDecimal(hex: string): string {
  if (!hex.startsWith("0x")) return hex;
  return BigInt(hex).toString();
}

function timestampToDate(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function isEthereumAddress(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function isHexString(v: unknown): v is string {
  return typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);
}

function isWeiLike(v: unknown): boolean {
  if (typeof v === "string" && /^\d{15,}$/.test(v)) return true;
  if (typeof v === "bigint" && v >= BigInt(1e14)) return true;
  return false;
}

function isTimestamp(v: unknown): boolean {
  return typeof v === "number" && v > 1_000_000_000 && v < 10_000_000_000;
}

function detectAndFormat(data: unknown): { formatted: string; type: string } {
  if (isEthereumAddress(data)) {
    return { formatted: shortenAddress(data), type: "address" };
  }

  if (isWeiLike(data)) {
    const str = typeof data === "bigint" ? data.toString() : (data as string);
    return { formatted: `${weiToEth(str)} ETH`, type: "wei" };
  }

  if (isHexString(data)) {
    return { formatted: hexToDecimal(data), type: "hex" };
  }

  if (isTimestamp(data)) {
    return { formatted: timestampToDate(data as number), type: "timestamp" };
  }

  if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;
    const entries: string[] = [];
    for (const [key, val] of Object.entries(obj)) {
      const sub = detectAndFormat(val);
      entries.push(`${key}: ${sub.formatted}`);
    }
    return { formatted: entries.join("\n"), type: "object" };
  }

  return { formatted: String(data), type: "passthrough" };
}

function formatAsTable(data: unknown): string {
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    const keys = Object.keys(obj);
    const maxKeyLen = Math.max(...keys.map((k) => k.length), 5);
    const lines = [
      `${"Field".padEnd(maxKeyLen)} | Value`,
      `${"-".repeat(maxKeyLen)} | ${"-----"}`,
    ];
    for (const [key, val] of Object.entries(obj)) {
      const sub = detectAndFormat(val);
      lines.push(`${key.padEnd(maxKeyLen)} | ${sub.formatted}`);
    }
    return lines.join("\n");
  }
  return detectAndFormat(data).formatted;
}

export function express(input: FormatterInput): FormatterOutput {
  const fmt = input.format ?? "human";

  if (fmt === "json") {
    const detected = detectAndFormat(input.data);
    return {
      formatted: JSON.stringify({ value: detected.formatted, type: detected.type }),
      type: detected.type,
    };
  }

  if (fmt === "table") {
    return {
      formatted: formatAsTable(input.data),
      type: "table",
    };
  }

  return detectAndFormat(input.data);
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

function truncateAddressMiddle(addr: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return addr;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function parseWeiFromFormattedEth(formatted: string): string | undefined {
  const trimmed = formatted.replace(/\s*ETH\s*$/i, "").trim();
  const m = trimmed.match(/^(\d+)\.(\d{1,18})$/);
  if (!m) return undefined;
  const whole = m[1];
  const frac = m[2].padEnd(18, "0").slice(0, 18);
  try {
    return (BigInt(whole) * 10n ** 18n + BigInt(frac)).toString();
  } catch {
    return undefined;
  }
}

export function display(output: FormatterOutput, options?: { verbose?: boolean }): void {
  void options;
  console.log(`${BOLD}${CYAN}Formatted Data${RESET} ${DIM}[${output.type}]${RESET}`);
  console.log();

  if (output.type === "address") {
    const shown = truncateAddressMiddle(output.formatted.replace(/\s/g, ""));
    console.log(`${GREEN}${shown}${RESET}`);
    return;
  }

  if (output.type === "wei") {
    const wei = parseWeiFromFormattedEth(output.formatted);
    if (wei !== undefined) {
      console.log(`${DIM}Wei:${RESET} ${YELLOW}${wei}${RESET}`);
    }
    console.log(`${DIM}ETH:${RESET} ${GREEN}${output.formatted}${RESET}`);
    return;
  }

  if (output.type === "timestamp") {
    const d = new Date(output.formatted);
    const human = Number.isNaN(d.getTime()) ? output.formatted : d.toLocaleString();
    console.log(`${DIM}ISO:${RESET} ${BLUE}${output.formatted}${RESET}`);
    console.log(`${DIM}Human:${RESET} ${GREEN}${human}${RESET}`);
    return;
  }

  console.log(`${BLUE}${output.formatted}${RESET}`);
}
