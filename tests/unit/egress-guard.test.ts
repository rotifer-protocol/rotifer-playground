/**
 * The egress guard: while the CLI runs a gene under Node, the gene's global
 * `fetch` and `WebSocket` answer to its phenotype's `network` declaration.
 *
 * Spec, Phenotype `NetworkConfig`: a Hybrid or Wrapped gene that makes HTTP
 * requests SHOULD declare NetworkConfig "so the sandbox can enforce a domain
 * whitelist, timeouts and rate limits", and a gene that declares none "is
 * treated as having no network access". Before this, only `ctx.gatewayFetch`
 * was checked; a gene calling the global `fetch` reached any host.
 *
 * A loopback stand-in answers the requests that get through. The gateway's
 * loopback test hook is on (as in network-gateway-ssrf.test.ts); the
 * production path is covered by tests/e2e/gene-egress-guard.test.ts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { geneEgress, withGeneEgress } from "../../src/runtime/egress-guard.js";

let server: Server;
let base = "";
const seen: Array<{ method: string; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", body });
      res.end(req.url === "/big" ? "x".repeat(64) : "hi");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
});

const LOOPBACK = { allowInsecureLoopbackForTests: true };
const allowing = (domains: string[], extra: Record<string, number> = {}) =>
  geneEgress("probe", { network: { allowedDomains: domains, ...extra } }, LOOPBACK);

describe("a gene's global fetch while the CLI runs it", () => {
  it("is refused when the gene declares no network, naming the host and how to declare it", async () => {
    const egress = geneEgress("probe", {}, LOOPBACK);
    expect(egress.gatewayFetch).toBeUndefined();

    const err = await withGeneEgress(egress, () => fetch(`${base}/x`)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Gene 'probe' declares no network access/);
    expect(err?.message).toContain("127.0.0.1");
    expect(err?.message).toMatch(/"network"/);
    expect(err?.message).toMatch(/allowedDomains/);
    expect(seen).toHaveLength(0);
  });

  it("is refused for a host off the allow-list, with how to allow it", async () => {
    const err = await withGeneEgress(allowing(["api.example.com"]), () => fetch(`${base}/x`)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/"127\.0\.0\.1" is not in the allowed list: \[api\.example\.com\]/);
    expect(err?.message).toMatch(/allowedDomains/);
    expect(seen).toHaveLength(0);
  });

  it("is refused with an empty allow-list too", async () => {
    const err = await withGeneEgress(allowing([]), () => fetch(`${base}/x`)).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/not in the allowed list: \[\]/);
    expect(seen).toHaveLength(0);
  });

  it("goes through the gene's gateway for an allowed host: a real Response, counted with gatewayFetch", async () => {
    const egress = allowing(["127.0.0.1"]);
    const res = await withGeneEgress(egress, () => fetch(`${base}/x`));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hi");
    expect(egress.gateway!.stats.totalRequests).toBe(1);

    // ctx.gatewayFetch is the same gateway: one count, one rate limit.
    await withGeneEgress(egress, () => egress.gatewayFetch!(`${base}/y`, { method: "GET" }));
    expect(egress.gateway!.stats.totalRequests).toBe(2);
    expect(seen).toHaveLength(2);
  });

  it("keeps fetch's own defaults: GET without init, the body and method when given", async () => {
    const egress = allowing(["127.0.0.1"]);
    await withGeneEgress(egress, async () => {
      await fetch(`${base}/x`);
      await fetch(new Request(`${base}/x`, { method: "PUT", body: JSON.stringify({ a: 1 }) }));
    });
    expect(seen).toEqual([
      { method: "GET", body: "" },
      { method: "PUT", body: '{"a":1}' },
    ]);
  });

  it("shares the gateway's rate limit", async () => {
    const egress = allowing(["127.0.0.1"], { maxRequestsPerMin: 1 });
    await withGeneEgress(egress, () => fetch(`${base}/x`));
    await expect(withGeneEgress(egress, () => fetch(`${base}/x`))).rejects.toThrow(/Rate limit/);
    expect(seen).toHaveLength(1);
  });

  it("fails a response over maxResponseBytes instead of handing back a cut-off body", async () => {
    const egress = allowing(["127.0.0.1"], { maxResponseBytes: 8 });
    await expect(withGeneEgress(egress, () => fetch(`${base}/big`))).rejects.toThrow(/maxResponseBytes|too large/i);
  });

  it("keeps each gene's own rules when two genes run at once", async () => {
    const [allowed, refused] = await Promise.allSettled([
      withGeneEgress(allowing(["127.0.0.1"]), async () => {
        await new Promise((r) => setTimeout(r, 20));
        return (await fetch(`${base}/a`)).status;
      }),
      withGeneEgress(geneEgress("other", {}, LOOPBACK), async () => {
        await new Promise((r) => setTimeout(r, 10));
        return (await fetch(`${base}/b`)).status;
      }),
    ]);
    expect(allowed).toEqual({ status: "fulfilled", value: 200 });
    expect(refused.status).toBe("rejected");
    expect((refused as PromiseRejectedResult).reason.message).toMatch(/Gene 'other' declares no network access/);
    expect(seen).toHaveLength(1);
  });

  it("leaves a fetch that is not the gene's alone (the CLI's own requests)", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const window = withGeneEgress(geneEgress("probe", {}, LOOPBACK), () => held);

    // The guard is installed, but this call does not come from the gene.
    expect(globalThis.fetch).not.toBe(ORIGINAL_FETCH);
    const res = await fetch(`${base}/cli`);
    expect(res.status).toBe(200);

    release();
    await window;
    expect(seen).toHaveLength(1);
  });

  it("refuses a WebSocket: the gateway carries HTTP requests only", async () => {
    expect(typeof globalThis.WebSocket).toBe("function");
    const err = await withGeneEgress(allowing(["127.0.0.1"]), () => {
      new WebSocket(`ws://127.0.0.1:1/`);
    }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/Gene 'probe' opened a WebSocket/);
    expect(err?.message).toContain("127.0.0.1");
  });
});

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_WEBSOCKET = globalThis.WebSocket;

describe("after the gene has run", () => {
  it("the global fetch and WebSocket are the very objects they were before", async () => {
    let inside: typeof fetch | undefined;
    await withGeneEgress(allowing(["127.0.0.1"]), () => {
      inside = globalThis.fetch;
    });
    expect(inside).not.toBe(ORIGINAL_FETCH);
    expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
    expect(globalThis.WebSocket).toBe(ORIGINAL_WEBSOCKET);
  });

  it("are restored when the gene throws", async () => {
    await expect(
      withGeneEgress(allowing([]), () => {
        throw new Error("gene broke");
      }),
    ).rejects.toThrow("gene broke");
    expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
    expect(globalThis.WebSocket).toBe(ORIGINAL_WEBSOCKET);
  });

  it("are restored only when the last of several overlapping runs ends", async () => {
    let releaseA!: () => void;
    const a = withGeneEgress(allowing([]), () => new Promise<void>((r) => (releaseA = r)));
    const b = withGeneEgress(allowing([]), async () => {
      // nested inside b, too
      await withGeneEgress(geneEgress("inner", {}, LOOPBACK), () => undefined);
      expect(globalThis.fetch).not.toBe(ORIGINAL_FETCH);
    });
    await b;
    expect(globalThis.fetch).not.toBe(ORIGINAL_FETCH);
    releaseA();
    await a;
    expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
    expect(globalThis.WebSocket).toBe(ORIGINAL_WEBSOCKET);
  });
});
