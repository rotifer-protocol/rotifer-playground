import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  NetworkGateway,
  NetworkGatewayError,
  createGatewayFetch,
} from "../../src/runtime/network-gateway.js";

describe("NetworkGateway", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("Domain whitelist", () => {
    it("blocks domain not in whitelist", async () => {
      const gw = new NetworkGateway({ allowedDomains: ["api.example.com"] });
      try {
        await gw.fetch("https://evil.com/data");
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(NetworkGatewayError);
        expect(err.code).toBe("DOMAIN_BLOCKED");
        expect(err.message).toContain("evil.com");
      }
    });

    it("allows exact domain match", async () => {
      const gw = new NetworkGateway({ allowedDomains: ["httpbin.org"] });
      try {
        await gw.fetch("https://httpbin.org/get", { method: "GET" });
      } catch (err: any) {
        expect(err.code).not.toBe("DOMAIN_BLOCKED");
      }
    });

    it("wildcard *.supabase.co matches sub.supabase.co", async () => {
      const gw = new NetworkGateway({ allowedDomains: ["*.supabase.co"] });
      try {
        await gw.fetch("https://abc123.supabase.co/rest/v1/test");
      } catch (err: any) {
        expect(err.code).not.toBe("DOMAIN_BLOCKED");
      }
    });

    it("wildcard *.supabase.co matches bare supabase.co", async () => {
      const gw = new NetworkGateway({ allowedDomains: ["*.supabase.co"] });
      try {
        await gw.fetch("https://supabase.co/test");
      } catch (err: any) {
        expect(err.code).not.toBe("DOMAIN_BLOCKED");
      }
    });

    it("rejects invalid URL", async () => {
      const gw = new NetworkGateway({ allowedDomains: ["example.com"] });
      try {
        await gw.fetch("not-a-url");
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err).toBeInstanceOf(NetworkGatewayError);
        expect(err.code).toBe("DOMAIN_BLOCKED");
        expect(err.message).toContain("Invalid URL");
      }
    });

    it("domain with port number matches base domain", async () => {
      const gw = new NetworkGateway({ allowedDomains: ["api.example.com"] });
      try {
        await gw.fetch("https://api.example.com:8443/data");
      } catch (err: any) {
        expect(err.code).not.toBe("DOMAIN_BLOCKED");
      }
    });
  });

  describe("Rate limiting", () => {
    it("enforces rate limit", async () => {
      const gw = new NetworkGateway({
        allowedDomains: ["example.com"],
        maxRequestsPerMin: 3,
      });
      for (let i = 0; i < 3; i++) {
        try {
          await gw.fetch("https://example.com/test");
        } catch (err: any) {
          if (err.code === "RATE_LIMITED")
            expect.unreachable("rate limited too early");
        }
      }
      try {
        await gw.fetch("https://example.com/test");
        expect.unreachable("should have thrown RATE_LIMITED");
      } catch (err: any) {
        expect(err).toBeInstanceOf(NetworkGatewayError);
        expect(err.code).toBe("RATE_LIMITED");
      }
    });
  });

  describe("Stats tracking", () => {
    it("stats track window requests correctly", () => {
      const gw = new NetworkGateway({
        allowedDomains: ["example.com"],
        maxRequestsPerMin: 100,
      });
      const stats = gw.stats;
      expect(stats.totalRequests).toBe(0);
      expect(stats.totalBytes).toBe(0);
      expect(stats.windowRequests).toBe(0);
    });
  });

  describe("createGatewayFetch helper", () => {
    it("returns gatewayFetch + gateway", () => {
      const { gatewayFetch, gateway } = createGatewayFetch({
        allowedDomains: ["api.openai.com"],
        maxRequestsPerMin: 5,
      });
      expect(typeof gatewayFetch).toBe("function");
      expect(gateway).toBeInstanceOf(NetworkGateway);
      expect(gateway.stats.totalRequests).toBe(0);
    });

    it("inherits domain restrictions", async () => {
      const { gatewayFetch } = createGatewayFetch({
        allowedDomains: ["api.openai.com"],
      });
      try {
        await gatewayFetch("https://evil.com/hack");
        expect.unreachable("should have thrown");
      } catch (err: any) {
        expect(err.code).toBe("DOMAIN_BLOCKED");
      }
    });
  });

  describe("Default config", () => {
    it("has sensible defaults", () => {
      const gw = new NetworkGateway();
      const stats = gw.stats;
      expect(stats.totalRequests).toBe(0);
    });
  });
});
