import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ClawHubError,
  clawHubEndpoints,
  fetchClawHubInfo,
  fetchClawHubPackage,
  CLAWHUB_API,
  CLAWHUB_DOWNLOAD,
} from "../../src/utils/clawhub-client.js";

/** A fetch that answers from a script, one entry per call, and counts calls. */
function scripted(answers: Array<Response | Error>): { fetchImpl: typeof fetch; calls: () => number } {
  let n = 0;
  return {
    fetchImpl: (async () => {
      const a = answers[Math.min(n, answers.length - 1)];
      n++;
      if (a instanceof Error) throw a;
      return a.clone();
    }) as typeof fetch,
    calls: () => n,
  };
}

const INFO = JSON.stringify({
  skill: {
    slug: "fixture-skill",
    displayName: "Fixture Skill",
    summary: "A skill used by tests",
    stats: { comments: 0, downloads: 12, installs: 1, stars: 3, versions: 1 },
  },
  latestVersion: { version: "1.2.3" },
  owner: { handle: "fixture-owner", displayName: "Fixture Owner" },
});
const json = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });
const serverError = () => json(JSON.stringify({ code: "[Request ID: abc123] Server Error" }), 500);
const fast = { retryDelaysMs: [0], api: "https://clawhub.test/api/skill" };

describe("fetchClawHubInfo", () => {
  it("returns the skill on a 200", async () => {
    const f = scripted([json(INFO)]);
    const info = await fetchClawHubInfo("fixture-skill", { ...fast, fetchImpl: f.fetchImpl });
    expect(info).toMatchObject({ slug: "fixture-skill", version: "1.2.3", owner: { handle: "fixture-owner" } });
    expect(f.calls()).toBe(1);
  });

  it("a 404 is not_found at once — a missing skill is not retried", async () => {
    const f = scripted([new Response("Not found", { status: 404 })]);
    const err = await fetchClawHubInfo("nope", { ...fast, fetchImpl: f.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(ClawHubError);
    expect(err).toMatchObject({ kind: "not_found", status: 404, attempts: 1 });
    expect(err.message).toBe("not found (HTTP 404)");
    expect(f.calls()).toBe(1);
  });

  it("a transient 500 is retried and the next answer wins", async () => {
    const f = scripted([serverError(), json(INFO)]);
    const retries: string[] = [];
    const info = await fetchClawHubInfo("fixture-skill", {
      ...fast,
      fetchImpl: f.fetchImpl,
      onRetry: (attempt, attempts, e) => retries.push(`${attempt}/${attempts} ${e.message}`),
    });
    expect(info.slug).toBe("fixture-skill");
    expect(f.calls()).toBe(2);
    expect(retries).toEqual(["1/3 HTTP 500 — [Request ID: abc123] Server Error (1 attempt)"]);
  });

  it("a 500 on every attempt gives up after three, with ClawHub's message", async () => {
    const f = scripted([serverError()]);
    const err = await fetchClawHubInfo("fixture-skill", { ...fast, fetchImpl: f.fetchImpl }).catch((e) => e);
    expect(err).toMatchObject({ kind: "http", status: 500, attempts: 3 });
    expect(err.message).toBe("HTTP 500 — [Request ID: abc123] Server Error (3 attempts)");
    expect(f.calls()).toBe(3);
  });

  it("429 and 408 are retried; other 4xx are not", async () => {
    const limited = scripted([new Response("slow down", { status: 429 }), json(INFO)]);
    await fetchClawHubInfo("fixture-skill", { ...fast, fetchImpl: limited.fetchImpl });
    expect(limited.calls()).toBe(2);
    const forbidden = scripted([new Response("no", { status: 403 })]);
    const err = await fetchClawHubInfo("fixture-skill", { ...fast, fetchImpl: forbidden.fetchImpl }).catch((e) => e);
    expect(err).toMatchObject({ kind: "http", status: 403, attempts: 1 });
    expect(forbidden.calls()).toBe(1);
  });

  it("a network error names its cause, after the retries", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    const f = scripted([refused]);
    const err = await fetchClawHubInfo("fixture-skill", { ...fast, fetchImpl: f.fetchImpl }).catch((e) => e);
    expect(err).toMatchObject({ kind: "network", attempts: 3 });
    expect(err.message).toBe("network error: ECONNRESET (3 attempts)");
  });

  it("a 200 that is not JSON says so, with its content type", async () => {
    const f = scripted([new Response("<html>Just a moment…</html>", { headers: { "content-type": "text/html" } })]);
    const err = await fetchClawHubInfo("fixture-skill", { ...fast, fetchImpl: f.fetchImpl }).catch((e) => e);
    expect(err).toMatchObject({ kind: "not_json", attempts: 1 });
    expect(err.message).toContain("content-type text/html");
  });

  it("JSON without a skill is not_found", async () => {
    const f = scripted([json("{}")]);
    const err = await fetchClawHubInfo("fixture-skill", { ...fast, fetchImpl: f.fetchImpl }).catch((e) => e);
    expect(err).toMatchObject({ kind: "not_found" });
  });

  it("the slug is URL-encoded", async () => {
    let seen = "";
    const fetchImpl = (async (url: string) => {
      seen = url;
      return json(INFO);
    }) as unknown as typeof fetch;
    await fetchClawHubInfo("a b&c", { ...fast, fetchImpl });
    expect(seen).toBe("https://clawhub.test/api/skill?slug=a%20b%26c");
  });
});

describe("against a real HTTP server", () => {
  let server: Server;
  let base = "";
  let stalls = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/download") {
        // The live download endpoint answers 307 to the package.
        res.writeHead(307, { location: `${base}/pkg?slug=${url.searchParams.get("slug")}` }).end();
      } else if (url.pathname === "/pkg") {
        res.writeHead(200, { "content-type": "application/zip" }).end(Buffer.from("PK-fixture"));
      } else if (url.pathname === "/stall") {
        stalls++; // never answers
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("follows the download endpoint's 307 to the package", async () => {
    const zip = await fetchClawHubPackage("fixture-skill", { download: `${base}/download`, retryDelaysMs: [0] });
    expect(zip.toString()).toBe("PK-fixture");
  });

  it("an answer that never comes is a timeout, retried, then reported", async () => {
    const err = await fetchClawHubInfo("x", { api: `${base}/stall`, timeoutMs: 200, retryDelaysMs: [0] }).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ kind: "timeout", attempts: 3 });
    expect(err.message).toBe("no answer within 200 ms (3 attempts)");
    expect(stalls).toBe(3);
  });
});

describe("clawHubEndpoints", () => {
  it("defaults to ClawHub", () => {
    expect(clawHubEndpoints({})).toEqual({ api: CLAWHUB_API, download: CLAWHUB_DOWNLOAD });
  });

  it("takes https overrides, and http only to loopback", () => {
    expect(
      clawHubEndpoints({
        ROTIFER_CLAWHUB_API_URL: "https://mirror.example/api/skill",
        ROTIFER_CLAWHUB_DOWNLOAD_URL: "http://127.0.0.1:9/dl",
      }),
    ).toEqual({ api: "https://mirror.example/api/skill", download: "http://127.0.0.1:9/dl" });
    expect(() => clawHubEndpoints({ ROTIFER_CLAWHUB_API_URL: "http://mirror.example/api" })).toThrow(/https/);
    expect(() => clawHubEndpoints({ ROTIFER_CLAWHUB_DOWNLOAD_URL: "not a url" })).toThrow(/not a URL/);
  });
});
