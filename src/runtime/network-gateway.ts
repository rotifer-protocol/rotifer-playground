/**
 * Network Gateway — controlled fetch proxy for Hybrid genes.
 *
 * Enforces domain whitelist, per-request timeout, response size cap,
 * and per-minute rate limiting. Genes call `gatewayFetch()` instead
 * of raw `fetch()`.
 */

export interface NetworkConfig {
  allowedDomains: string[];
  maxTimeoutMs: number;
  maxResponseBytes: number;
  maxRequestsPerMin: number;
}

export interface GatewayFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  isTruncated: boolean;
}

export class NetworkGatewayError extends Error {
  constructor(
    public readonly code:
      | "DOMAIN_BLOCKED"
      | "RATE_LIMITED"
      | "TIMEOUT"
      | "RESPONSE_TOO_LARGE"
      | "NETWORK_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "NetworkGatewayError";
  }
}

const DEFAULT_CONFIG: NetworkConfig = {
  allowedDomains: [],
  maxTimeoutMs: 30_000,
  maxResponseBytes: 1_048_576, // 1 MiB
  maxRequestsPerMin: 10,
};

export class NetworkGateway {
  private config: NetworkConfig;
  private requestTimestamps: number[] = [];
  private totalRequests = 0;
  private totalBytes = 0;

  constructor(config?: Partial<NetworkConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get stats() {
    return {
      totalRequests: this.totalRequests,
      totalBytes: this.totalBytes,
      windowRequests: this.requestTimestamps.length,
    };
  }

  async fetch(url: string, options?: GatewayFetchOptions): Promise<GatewayResponse> {
    this.validateDomain(url);
    this.enforceRateLimit();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.maxTimeoutMs,
    );

    try {
      const response = await fetch(url, {
        method: options?.method || "POST",
        headers: options?.headers,
        body: options?.body,
        signal: controller.signal,
      });

      const { text, isTruncated } = await this.readBodyCapped(response);

      this.totalRequests++;
      this.totalBytes += text.length;

      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });

      return {
        status: response.status,
        headers,
        body: text,
        isTruncated,
      };
    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new NetworkGatewayError(
          "TIMEOUT",
          `Request to ${url} timed out after ${this.config.maxTimeoutMs}ms`,
        );
      }
      throw new NetworkGatewayError(
        "NETWORK_ERROR",
        `Request to ${url} failed: ${err.message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateDomain(url: string): void {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      throw new NetworkGatewayError(
        "DOMAIN_BLOCKED",
        `Invalid URL: ${url}`,
      );
    }

    const isAllowed = this.config.allowedDomains.some((d) => {
      if (d.startsWith("*.")) {
        return hostname.endsWith(d.slice(1)) || hostname === d.slice(2);
      }
      return hostname === d;
    });

    if (!isAllowed) {
      throw new NetworkGatewayError(
        "DOMAIN_BLOCKED",
        `Domain "${hostname}" is not in the allowed list: [${this.config.allowedDomains.join(", ")}]`,
      );
    }
  }

  private enforceRateLimit(): void {
    const now = Date.now();
    const windowStart = now - 60_000;
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => t > windowStart,
    );

    if (this.requestTimestamps.length >= this.config.maxRequestsPerMin) {
      throw new NetworkGatewayError(
        "RATE_LIMITED",
        `Rate limit exceeded: ${this.config.maxRequestsPerMin} requests/minute`,
      );
    }

    this.requestTimestamps.push(now);
  }

  private async readBodyCapped(
    response: Response,
  ): Promise<{ text: string; isTruncated: boolean }> {
    const reader = response.body?.getReader();
    if (!reader) {
      return { text: "", isTruncated: false };
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    let isTruncated = false;

    while (true) {
      const { done: isDone, value } = await reader.read();
      if (isDone) break;

      if (totalSize + value.length > this.config.maxResponseBytes) {
        const remaining = this.config.maxResponseBytes - totalSize;
        if (remaining > 0) {
          chunks.push(value.slice(0, remaining));
        }
        isTruncated = true;
        reader.cancel();
        break;
      }

      chunks.push(value);
      totalSize += value.length;
    }

    const decoder = new TextDecoder();
    const text = chunks.map((c) => decoder.decode(c, { stream: true })).join("") +
      decoder.decode();
    return { text, isTruncated };
  }
}

/**
 * Create a gateway-scoped fetch function for a Hybrid gene.
 * The gene receives this as its network interface.
 */
export function createGatewayFetch(
  config: Partial<NetworkConfig>,
): {
  gatewayFetch: (url: string, options?: GatewayFetchOptions) => Promise<GatewayResponse>;
  gateway: NetworkGateway;
} {
  const gateway = new NetworkGateway(config);
  return {
    gatewayFetch: (url, options) => gateway.fetch(url, options),
    gateway,
  };
}
