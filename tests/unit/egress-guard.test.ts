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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { geneEgress, withGeneEgress } from "../../src/runtime/egress-guard.js";
import { loadNodeRunner } from "../../src/testsuite/gate.js";
import { runT1, type GeneRunner, type RunOutcome } from "../../src/testsuite/run.js";

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

describe("the runner a test suite is run with (rotifer test, rotifer publish)", () => {
  /** A gene directory holding `source` as index.mjs beside a phenotype naming it `name`. */
  const geneWith = (name: string, source: string[], phenotype: Record<string, unknown> = {}): string => {
    const dir = mkdtempSync(join(tmpdir(), "egress-runner-"));
    writeFileSync(join(dir, "phenotype.json"), JSON.stringify({ name, domain: "tools", ...phenotype }));
    writeFileSync(join(dir, "index.mjs"), source.join("\n"));
    return dir;
  };
  const runnerOf = async (dir: string): Promise<GeneRunner> => {
    const loaded = await loadNodeRunner(join(dir, "index.mjs"), { kind: "ok" });
    if (!("runner" in loaded)) throw new Error(loaded.refusal);
    return loaded.runner;
  };
  const probe = (key: string) => (globalThis as Record<string, Promise<string> | undefined>)[key];

  it("checks a request a sync express starts during the call or in a microtask it queued, then restores the globals", async () => {
    const dir = geneWith("sync-probe", [
      "export function express() {",
      `  globalThis.__during = fetch(${JSON.stringify(`${base}/sync`)}).then(() => "sent", (e) => e.message);`,
      `  queueMicrotask(() => { globalThis.__queued = fetch(${JSON.stringify(`${base}/microtask`)}).then(() => "sent", (e) => e.message); });`,
      "  return { ok: true };",
      "}",
    ]);
    try {
      const outcome = await (await runnerOf(dir))({});
      expect(outcome.success).toBe(true);
      expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
      expect(await probe("__during")).toMatch(/Gene 'sync-probe' declares no network access/);
      expect(await probe("__queued")).toMatch(/Gene 'sync-probe' declares no network access/);
      expect(seen).toHaveLength(0);
    } finally {
      delete (globalThis as Record<string, unknown>).__during;
      delete (globalThis as Record<string, unknown>).__queued;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for an async express, and checks the requests it makes after its first await", async () => {
    const dir = geneWith("async-probe", [
      "export async function express() {",
      "  await null;",
      "  await new Promise((r) => setTimeout(r, 20));",
      `  const late = await fetch(${JSON.stringify(`${base}/late`)}).then(() => "sent", (e) => e.message);`,
      "  return { ok: true, late };",
      "}",
    ]);
    try {
      const outcome = await (await runnerOf(dir))({});
      expect(outcome.success).toBe(true);
      // the value it resolved to, not its Promise
      expect((outcome.output as { late: string }).late).toMatch(/Gene 'async-probe' declares no network access/);
      expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
      expect(seen).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restores the globals when express throws, and reports a rejected async express as a crash", async () => {
    const dir = geneWith("broken-probe", [
      "export function express(input) {",
      "  if (input.async) return Promise.reject(new Error('gene broke later'));",
      "  throw new Error('gene broke');",
      "}",
    ]);
    try {
      const run = await runnerOf(dir);
      const thrown: RunOutcome = await run({});
      expect(thrown).toMatchObject({ success: false, crashed: true, errorMessage: "gene broke" });
      expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
      const rejected: RunOutcome = await run({ async: true });
      expect(rejected).toMatchObject({ success: false, crashed: true, errorMessage: "gene broke later" });
      expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T1 judges an async express on what it resolves to", async () => {
    const inputSchema = { type: "object", required: ["q"], properties: { q: { type: "string" } } };
    const outputSchema = { type: "object", required: ["echo"], properties: { echo: { type: "string" } } };
    const dir = geneWith("async-t1", [
      "export async function express(input) {",
      "  await null;",
      "  if (typeof input?.q !== 'string') return { __rotifer_error: { message: 'q must be a string' } };",
      "  return { echo: input.q };",
      "}",
    ], { inputSchema, outputSchema });
    try {
      const report = await runT1(
        {
          config: { fuzzIterations: 3, seed: 1 },
          testCases: [
            { input: { q: "hi" }, expectedOutput: { echo: "hi" } },
            { input: { q: 1 } },
          ],
        },
        { inputSchema, outputSchema, run: await runnerOf(dir) },
      );
      const by = Object.fromEntries(report.results.map((r) => [r.testId, r]));
      // a Promise equals no expectedOutput, is no refusal, and has no `echo`
      expect(by["t1-positive-0"].passed, by["t1-positive-0"].failureReason).toBe(true);
      expect(by["t1-negative-1"].details).toMatch(/Gene refused illegal input: INVALID_INPUT: q must be a string/);
      expect(by["t1-property-schema-legality"].passed, by["t1-property-schema-legality"].failureReason).toBe(true);
      expect(report.gatePassed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadNodeRunner holds the gene to the phenotype.json beside its source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-runner-"));
    try {
      writeFileSync(join(dir, "phenotype.json"), JSON.stringify({ name: "suite-probe", domain: "tools" }));
      writeFileSync(
        join(dir, "index.mjs"),
        [
          "export function express() {",
          `  globalThis.__suiteProbe = fetch(${JSON.stringify(`${base}/suite`)}).then(() => "sent", (e) => e.message);`,
          "  return { ok: true };",
          "}",
        ].join("\n"),
      );
      const loaded = await loadNodeRunner(join(dir, "index.mjs"), { kind: "ok" });
      expect("runner" in loaded).toBe(true);
      const outcome = await (loaded as { runner: GeneRunner }).runner({});
      expect(outcome.success).toBe(true);
      const g = globalThis as { __suiteProbe?: Promise<string> };
      expect(await g.__suiteProbe).toMatch(/Gene 'suite-probe' declares no network access/);
      expect(seen).toHaveLength(0);
      delete g.__suiteProbe;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadNodeRunner holds the gene's top-level code (run on import, as under publish) to it too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-runner-"));
    try {
      writeFileSync(join(dir, "phenotype.json"), JSON.stringify({ name: "import-probe", domain: "tools" }));
      writeFileSync(
        join(dir, "index.mjs"),
        [
          `globalThis.__importProbe = fetch(${JSON.stringify(`${base}/import`)}).then(() => "sent", (e) => e.message);`,
          "export function express() { return { ok: true }; }",
        ].join("\n"),
      );
      await loadNodeRunner(join(dir, "index.mjs"), { kind: "ok" });
      const g = globalThis as { __importProbe?: Promise<string> };
      expect(await g.__importProbe).toMatch(/Gene 'import-probe' declares no network access/);
      expect(seen).toHaveLength(0);
      delete g.__importProbe;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
