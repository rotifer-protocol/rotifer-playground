import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

/**
 * `wrap --from-clawhub` has to say what actually went wrong. It used to turn
 * every failure — a real 404, ClawHub's backend answering 500, a non-JSON
 * page, a timeout — into "not found or API error", which is how a flaky
 * upstream (ClawHub's API fails about one request in six with
 * `[Request ID: …] Server Error`, measured 2026-10-31) looked like a missing
 * skill in CI for weeks. These cases run the real CLI against a local server
 * that answers the way ClawHub does when it fails.
 */

const CLI = join(__dirname, "../../dist/index.js");
const TMP = join(tmpdir(), `rotifer-clawhub-errors-${Date.now()}`);

let server: Server;
let base = "";
const hits = new Map<string, number>();

function run(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [CLI, ...args],
      {
        cwd: TMP,
        timeout: 60_000,
        env: {
          ...process.env,
          NO_COLOR: "1",
          ROTIFER_CLAWHUB_API_URL: `${base}/api/skill`,
          ROTIFER_CLAWHUB_DOWNLOAD_URL: `${base}/api/v1/download`,
        },
      },
      (_err, stdout, stderr) => resolve(`${stdout}${stderr}`),
    );
  });
}

beforeAll(async () => {
  mkdirSync(join(TMP, "genes"), { recursive: true });
  writeFileSync(
    join(TMP, "rotifer.json"),
    JSON.stringify({ name: "clawhub-errors", genes_dir: "genes", default_domain: "general", author: "test" }),
  );
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const slug = url.searchParams.get("slug") ?? "";
    hits.set(slug, (hits.get(slug) ?? 0) + 1);
    if (slug === "missing") {
      res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
    } else if (slug === "broken") {
      res
        .writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ code: "[Request ID: 0123456789abcdef] Server Error" }));
    } else if (slug === "html") {
      res.writeHead(200, { "content-type": "text/html" }).end("<html><body>Just a moment…</body></html>");
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(TMP, { recursive: true, force: true });
});

describe("wrap --from-clawhub reports the real failure", () => {
  it("a missing skill is reported as not found, with the HTTP status, and is not retried", async () => {
    const out = await run(["wrap", "g-missing", "--from-clawhub", "missing"]);
    expect(out).toContain("E0010");
    expect(out).toMatch(/not found/i);
    expect(out).toContain("HTTP 404");
    expect(out).not.toMatch(/API error/i);
    expect(hits.get("missing")).toBe(1);
  });

  it("a server error shows the status and ClawHub's own message, after the retries", async () => {
    const out = await run(["wrap", "g-broken", "--from-clawhub", "broken"]);
    expect(out).toContain("E0010");
    expect(out).toContain("HTTP 500");
    expect(out).toContain("[Request ID: 0123456789abcdef] Server Error");
    expect(out).toMatch(/3 attempts/);
    expect(out).not.toMatch(/not found/i);
    expect(hits.get("broken")).toBe(3);
  }, 30_000);

  it("a response that is not JSON says so instead of claiming the skill is missing", async () => {
    const out = await run(["wrap", "g-html", "--from-clawhub", "html"]);
    expect(out).toContain("E0010");
    expect(out).toMatch(/not JSON/i);
    expect(out).toContain("text/html");
    expect(out).not.toMatch(/not found/i);
  }, 30_000);
});
