import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NetworkGateway, NetworkGatewayError, createGatewayFetch } from "../../src/runtime/network-gateway.js";

/**
 * SSRF hardening for the Node.js gateway, matching what the WASM path already
 * does (crates/rotifer-core/src/sandbox/hybrid.rs check_url / perform_fetch)
 * and Hybrid Binding API §2.1: https only, no IP literals, redirects followed
 * only while every hop stays in the whitelist, at most 5 hops.
 *
 * Real local HTTP servers, not a mocked fetch: the redirect behaviour under
 * test is fetch's own. Plain http to loopback needs the test-only switch,
 * which phenotype config cannot set.
 */

interface Local {
  server: Server;
  port: number;
  hits: string[];
}

function serve(handler: (path: string, res: import("node:http").ServerResponse, port: number) => void): Promise<Local> {
  return new Promise((resolve) => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      handler(req.url ?? "", res, (server.address() as AddressInfo).port);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, hits }));
  });
}

const redirect = (res: import("node:http").ServerResponse, location: string) => {
  res.writeHead(302, { location });
  res.end();
};

let target: Local; // never whitelisted: reached only by a redirect that escaped
let origin: Local; // whitelisted as "localhost"

beforeAll(async () => {
  target = await serve((_p, res) => {
    res.writeHead(200);
    res.end("escaped");
  });
  origin = await serve((path, res, port) => {
    if (path === "/out") return redirect(res, `http://127.0.0.1:${target.port}/internal`);
    if (path === "/in") return redirect(res, "/final");
    if (path === "/final") {
      res.writeHead(200);
      return res.end("final");
    }
    const hop = /^\/loop\/(\d+)$/.exec(path);
    if (hop) return redirect(res, `http://localhost:${port}/loop/${Number(hop[1]) + 1}`);
    res.writeHead(200);
    res.end("ok");
  });
});

afterAll(() => {
  target.server.close();
  origin.server.close();
});

const loopbackGateway = () =>
  new NetworkGateway({ allowedDomains: ["localhost"], maxRequestsPerMin: 100 }, { allowInsecureLoopbackForTests: true });

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    expect(e).toBeInstanceOf(NetworkGatewayError);
    return (e as NetworkGatewayError).code;
  }
}

describe("redirects are checked against the whitelist, hop by hop", () => {
  it("refuses a whitelisted host's redirect to a host outside the whitelist, and never reaches it", async () => {
    const before = target.hits.length;
    expect(await codeOf(loopbackGateway().fetch(`http://localhost:${origin.port}/out`, { method: "GET" }))).toBe(
      "DOMAIN_BLOCKED",
    );
    expect(target.hits.length).toBe(before);
  });

  it("follows a redirect that stays inside the whitelist", async () => {
    const res = await loopbackGateway().fetch(`http://localhost:${origin.port}/in`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("final");
  });

  it("gives up after 5 redirects", async () => {
    const start = origin.hits.length;
    expect(await codeOf(loopbackGateway().fetch(`http://localhost:${origin.port}/loop/0`, { method: "GET" }))).toBe(
      "NETWORK_ERROR",
    );
    // The first request plus 5 followed hops; the 6th redirect is not followed.
    expect(origin.hits.length - start).toBe(6);
  });
});

describe("https only", () => {
  it("refuses http:// in the production configuration, before anything is sent", async () => {
    const before = origin.hits.length;
    const gw = new NetworkGateway({ allowedDomains: ["localhost"] });
    expect(await codeOf(gw.fetch(`http://localhost:${origin.port}/`, { method: "GET" }))).toBe("INVALID_REQUEST");
    expect(origin.hits.length).toBe(before);
  });

  it("cannot be relaxed from phenotype config", async () => {
    const before = origin.hits.length;
    const { gatewayFetch } = createGatewayFetch({
      allowedDomains: ["localhost"],
      allowInsecureLoopbackForTests: true,
    } as Record<string, unknown>);
    expect(await codeOf(gatewayFetch(`http://localhost:${origin.port}/`, { method: "GET" }))).toBe("INVALID_REQUEST");
    expect(origin.hits.length).toBe(before);
  });
});

describe("no IP literals", () => {
  it("refuses an IPv4 literal even when it is whitelisted, before anything is sent", async () => {
    const before = origin.hits.length;
    const gw = new NetworkGateway({ allowedDomains: ["127.0.0.1"] });
    expect(await codeOf(gw.fetch(`http://127.0.0.1:${origin.port}/`, { method: "GET" }))).toBe("INVALID_REQUEST");
    expect(await codeOf(gw.fetch(`https://127.0.0.1:${origin.port}/`, { method: "GET" }))).toBe("INVALID_REQUEST");
    expect(origin.hits.length).toBe(before);
  });

  it("refuses other spellings of an IPv4 address, which URL parsing turns into dotted form", async () => {
    const gw = new NetworkGateway({ allowedDomains: ["127.0.0.1", "2130706433", "0x7f000001", "127.1"] });
    for (const url of ["https://2130706433/", "https://0x7f000001/", "https://127.1/"]) {
      expect(await codeOf(gw.fetch(url, { method: "GET" })), url).toBe("INVALID_REQUEST");
    }
  });

  it("refuses an IPv6 literal even when it is whitelisted", async () => {
    const gw = new NetworkGateway({ allowedDomains: ["[::1]", "[2001:db8::1]"] });
    expect(await codeOf(gw.fetch("https://[::1]:1/", { method: "GET" }))).toBe("INVALID_REQUEST");
    expect(await codeOf(gw.fetch("https://[2001:db8::1]/", { method: "GET" }))).toBe("INVALID_REQUEST");
  });
});
