/**
 * Network Gateway — controlled fetch proxy for Hybrid genes.
 *
 * Enforces domain whitelist, per-request timeout, response size cap,
 * and per-minute rate limiting. Genes call `gatewayFetch()` instead
 * of raw `fetch()`.
 *
 * SSRF hardening, the same as the WASM path (rotifer-core hybrid.rs
 * `check_url` / `perform_fetch`, Hybrid Binding API §2.1): https only, no IP
 * literals, and redirects followed by hand, at most MAX_REDIRECT_HOPS, each
 * hop checked against the whitelist before it is requested.
 */

/** Same as rotifer-core `constants::MAX_REDIRECT_HOPS`. */
export const MAX_REDIRECT_HOPS = 5;

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
      | "INVALID_REQUEST"
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

/** Binding-internal options, never read from a phenotype. */
export interface GatewayTestOptions {
  /** Test hook, as rotifer-core's `allow_insecure_loopback`: permit plain
   * http to loopback hosts and loopback IP literals. Off in every production
   * path — `createGatewayFetch`, which the CLI uses, never sets it. */
  allowInsecureLoopbackForTests?: boolean;
}

export class NetworkGateway {
  private config: NetworkConfig;
  private allowInsecureLoopback: boolean;
  private requestTimestamps: number[] = [];
  private totalRequests = 0;
  private totalBytes = 0;

  constructor(config?: Partial<NetworkConfig>, testOptions: GatewayTestOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.allowInsecureLoopback = testOptions.allowInsecureLoopbackForTests === true;
  }

  get stats() {
    return {
      totalRequests: this.totalRequests,
      totalBytes: this.totalBytes,
      windowRequests: this.requestTimestamps.length,
    };
  }

  async fetch(url: string, options?: GatewayFetchOptions): Promise<GatewayResponse> {
    this.validateUrl(url);
    this.enforceRateLimit();

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.maxTimeoutMs,
    );

    try {
      // Redirects are followed here, not by fetch: fetch would follow a
      // whitelisted host's 302 to anywhere. Every hop is checked before it
      // is requested; the timeout covers the whole chain.
      let current = url;
      let response: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
        if (hop > 0) this.validateUrl(current);
        response = await fetch(current, {
          method: options?.method || "POST",
          headers: options?.headers,
          body: options?.body,
          signal: controller.signal,
          redirect: "manual",
        });
        const location = response.headers.get("location");
        if (response.status < 300 || response.status >= 400 || !location) break;
        if (hop === MAX_REDIRECT_HOPS) {
          await response.body?.cancel();
          throw new NetworkGatewayError(
            "NETWORK_ERROR",
            `Request to ${url} failed: more than ${MAX_REDIRECT_HOPS} redirects`,
          );
        }
        await response.body?.cancel();
        current = new URL(location, current).toString();
      }
      if (!response) throw new Error("no response");

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
      if (err instanceof NetworkGatewayError) throw err;
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

  /** Whitelist first, then scheme and host shape. Runs for the first request
   * and for every redirect hop. rotifer-core's `check_url` checks shape first;
   * here a URL off the whitelist keeps the DOMAIN_BLOCKED callers have always
   * had, and INVALID_REQUEST is what a whitelisted host gets over http or as
   * an IP literal. Either way nothing is sent. */
  private validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new NetworkGatewayError(
        "DOMAIN_BLOCKED",
        `Invalid URL: ${url}`,
      );
    }
    const hostname = parsed.hostname;

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

    const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
    const isLoopback =
      hostname === "localhost" || hostname === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
    const isLoopbackAdmitted = this.allowInsecureLoopback && isLoopback;

    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackAdmitted)) {
      throw new NetworkGatewayError(
        "INVALID_REQUEST",
        `Only https is allowed: ${parsed.protocol}//${hostname}`,
      );
    }
    if (isIpLiteral && !isLoopbackAdmitted) {
      throw new NetworkGatewayError(
        "INVALID_REQUEST",
        `IP addresses are not allowed, use a host name: ${hostname}`,
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
