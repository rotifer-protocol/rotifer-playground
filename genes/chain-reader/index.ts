interface ChainReaderInput {
  address: string;
  chain?: string;
  action: "balance" | "code" | "txCount";
}

interface ChainReaderOutput {
  result: string;
  chain: string;
  blockNumber?: number;
}

const CHAIN_RPC: Record<string, string> = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
};

const ACTION_METHOD: Record<string, string> = {
  balance: "eth_getBalance",
  code: "eth_getCode",
  txCount: "eth_getTransactionCount",
};

function isValidAddress(address: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

async function rpcCall(url: string, method: string, params: unknown[]): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!res.ok) {
    throw new Error(`RPC request failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { result?: string; error?: { message: string } };

  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }

  return json.result ?? "0x0";
}

export async function express(input: ChainReaderInput): Promise<ChainReaderOutput> {
  const chain = input.chain ?? "ethereum";
  const rpcUrl = CHAIN_RPC[chain];

  if (!rpcUrl) {
    throw new Error(`Unsupported chain: ${chain}. Supported: ${Object.keys(CHAIN_RPC).join(", ")}`);
  }

  if (!isValidAddress(input.address)) {
    throw new Error(`Invalid address format: ${input.address}. Expected 0x-prefixed 40-hex-char string.`);
  }

  const method = ACTION_METHOD[input.action];
  if (!method) {
    throw new Error(`Unknown action: ${input.action}. Supported: balance, code, txCount`);
  }

  const result = await rpcCall(rpcUrl, method, [input.address, "latest"]);

  return { result, chain };
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

function looksLikeHexNumber(s: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(s);
}

export function display(output: ChainReaderOutput, options?: { verbose?: boolean }): void {
  void options;
  console.log(`${BOLD}${CYAN}Chain Data${RESET}`);
  console.log(`${DIM}Chain:${RESET} ${BOLD}${GREEN}${output.chain}${RESET}`);
  console.log(`${DIM}Result:${RESET} ${BLUE}${output.result}${RESET}`);
  if (looksLikeHexNumber(output.result)) {
    try {
      const dec = BigInt(output.result).toString();
      console.log(`${DIM}Decimal:${RESET} ${YELLOW}${dec}${RESET}`);
    } catch {
      // ignore parse errors
    }
  }
  console.log();
}
