/**
 * Gap #7: DNS rebinding / SSRF test expansion
 * Extends NetworkGateway tests with adversarial domain bypass vectors
 */
import { describe, it, expect } from "vitest";
import {
  NetworkGateway,
  NetworkGatewayError,
} from "../../src/runtime/network-gateway.js";

// ─── SSRF: Private IP Blocking ────────────────────────────────

describe("SSRF: private/reserved IP addresses", () => {
  const gw = new NetworkGateway({ allowedDomains: ["api.example.com"] });

  const privateUrls = [
    "http://127.0.0.1/admin",
    "http://localhost/admin",
    "http://0.0.0.0/admin",
    "http://[::1]/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://192.168.1.1/admin",
    "http://10.0.0.1/internal",
    "http://172.16.0.1/secret",
  ];

  for (const url of privateUrls) {
    it(`blocks private IP: ${url}`, async () => {
      try {
        await gw.fetch(url);
        expect.unreachable(`should block ${url}`);
      } catch (err: any) {
        expect(err).toBeInstanceOf(NetworkGatewayError);
        expect(err.code).toBe("DOMAIN_BLOCKED");
      }
    });
  }
});

// ─── SSRF: DNS Rebinding Vectors ──────────────────────────────

describe("SSRF: DNS rebinding and domain evasion", () => {
  const gw = new NetworkGateway({ allowedDomains: ["api.example.com"] });

  it("blocks domain with trailing dot (DNS absolute)", async () => {
    try {
      await gw.fetch("https://evil.com./data");
      expect.unreachable("should block");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
      expect(err.code).toBe("DOMAIN_BLOCKED");
    }
  });

  it("blocks IP-in-URL when domain expected", async () => {
    try {
      await gw.fetch("http://2130706433/admin");
      expect.unreachable("should block decimal IP");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
      expect(err.code).toBe("DOMAIN_BLOCKED");
    }
  });

  it("blocks hex-encoded IP", async () => {
    try {
      await gw.fetch("http://0x7f000001/admin");
      expect.unreachable("should block hex IP");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
      expect(err.code).toBe("DOMAIN_BLOCKED");
    }
  });

  it("blocks URL with credentials (user:pass@host)", async () => {
    try {
      await gw.fetch("https://admin:password@evil.com/data");
      expect.unreachable("should block credentials in URL");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
      expect(err.code).toBe("DOMAIN_BLOCKED");
    }
  });
});

// ─── Unicode Domain Evasion ───────────────────────────────────

describe("SSRF: Unicode domain evasion", () => {
  const gw = new NetworkGateway({ allowedDomains: ["example.com"] });

  it("blocks Unicode lookalike domain (homograph)", async () => {
    try {
      await gw.fetch("https://exаmple.com/data");
      expect.unreachable("should block homograph");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
      expect(err.code).toBe("DOMAIN_BLOCKED");
    }
  });

  it("fullwidth domains are not in whitelist (blocked or network error)", async () => {
    try {
      await gw.fetch("https://ｅｘａｍｐｌｅ.com/data");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
    }
  });

  it("blocks URL with null bytes", async () => {
    try {
      await gw.fetch("https://example.com%00.evil.com/data");
      expect.unreachable("should block null byte");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
    }
  });
});

// ─── Protocol Smuggling ───────────────────────────────────────

describe("SSRF: protocol smuggling", () => {
  const gw = new NetworkGateway({ allowedDomains: ["api.example.com"] });

  it("blocks file:// protocol", async () => {
    try {
      await gw.fetch("file:///etc/passwd");
      expect.unreachable("should block file://");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
    }
  });

  it("blocks data: URI", async () => {
    try {
      await gw.fetch("data:text/html,<script>alert(1)</script>");
      expect.unreachable("should block data:");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
    }
  });

  it("blocks gopher: protocol", async () => {
    try {
      await gw.fetch("gopher://evil.com:25/1");
      expect.unreachable("should block gopher:");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
    }
  });
});

// ─── Subdomain Bypass ─────────────────────────────────────────

describe("SSRF: subdomain bypass", () => {
  const gw = new NetworkGateway({ allowedDomains: ["api.example.com"] });

  it("blocks evil-api.example.com (prefix attack)", async () => {
    try {
      await gw.fetch("https://evil-api.example.com/data");
      expect.unreachable("should block prefix attack");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
      expect(err.code).toBe("DOMAIN_BLOCKED");
    }
  });

  it("blocks api.example.com.evil.com (suffix attack)", async () => {
    try {
      await gw.fetch("https://api.example.com.evil.com/data");
      expect.unreachable("should block suffix attack");
    } catch (err: any) {
      expect(err).toBeInstanceOf(NetworkGatewayError);
      expect(err.code).toBe("DOMAIN_BLOCKED");
    }
  });
});
