/**
 * The real CLI running a gene under Node whose source calls the global
 * `fetch`: the request answers to the gene's `network` declaration on every
 * path that runs gene source — `test`, `run`, `agent run` (Single, and TryPool
 * through the shared executor), and `hello`.
 *
 * The allowed host is a local https server with a self-signed certificate for
 * `localhost`, trusted through NODE_EXTRA_CA_CERTS. The gateway admits https
 * to a host name, loopback or not, so this exercises the production path with
 * no test hook switched on. The server runs in this process, so the CLI is
 * started with execFile, never a synchronous spawn.
 *
 * Needs `openssl` on PATH (to make the certificate) and `npm run build`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const GENE = "egress-probe";
// `hello --template code-security` runs the project's own `security-scanner`.
const HELLO_GENE = "security-scanner";

let tmp = "";
let certFile = "";
let server: Server;
let url = "";
let origin = "";
let hits = 0;

beforeAll(async () => {
  expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
  tmp = mkdtempSync(join(tmpdir(), "rotifer-egress-"));
  certFile = join(tmp, "cert.pem");
  const keyFile = join(tmp, "key.pem");
  const made = spawnSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyFile, "-out", certFile, "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"],
    { encoding: "utf-8" },
  );
  expect(made.status, `openssl: ${made.stderr}`).toBe(0);
  server = createServer({ key: readFileSync(keyFile), cert: readFileSync(certFile) }, (req, res) => {
    if (req.url === "/ping") {
      hits++;
      res.end("pong");
      return;
    }
    // Anything else is the CLI's own request to Rotifer Cloud (see the publish
    // test): not the gene's, so not counted. It is answered slowly, so a
    // request the gene let out has time to land before publish gives up.
    setTimeout(() => {
      res.statusCode = 503;
      res.end();
    }, 1500);
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  origin = `https://localhost:${(server.address() as AddressInfo).port}`;
  url = `${origin}/ping`;
});

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  rmSync(tmp, { recursive: true, force: true });
});

interface Result {
  code: number | null;
  out: string;
}

function cli(project: string, args: string[], extraEnv: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd: project,
        timeout: 120_000,
        env: {
          ...process.env,
          HOME: join(project, ".home"),
          FORCE_COLOR: "0",
          NO_COLOR: "1",
          ROTIFER_TELEMETRY: "0",
          DO_NOT_TRACK: "1",
          ROTIFER_NO_UPDATE_CHECK: "1",
          // Nothing listens here: a Cloud lookup fails fast instead of reaching out.
          ROTIFER_CLOUD_ENDPOINT: "https://127.0.0.1:9",
          ROTIFER_CLOUD_ANON_KEY: "anon-test-key",
          NODE_EXTRA_CA_CERTS: certFile,
          EGRESS_URL: url,
          ...extraEnv,
        },
      },
      (_err, stdout, stderr) => done({ code: child.exitCode, out: `${stdout}${stderr}` }),
    );
    child.stdin?.end();
  });
}

/** The probe: one global fetch to EGRESS_URL, nothing caught. */
const PROBE_SOURCE = [
  "export async function express(input: { q?: string }) {",
  "  const res = await fetch(process.env.EGRESS_URL as string);",
  "  return { status: res.status, body: await res.text(), q: input?.q ?? null };",
  "}",
  "",
].join("\n");

/** The same request from the gene's top-level code, which runs when the CLI imports it. */
const TOP_LEVEL_SOURCE = [
  "const res = await fetch(process.env.EGRESS_URL as string);",
  "const body = await res.text();",
  "export function express(input: { q?: string }) {",
  "  return { status: res.status, body, q: input?.q ?? null };",
  "}",
  "",
].join("\n");

/**
 * A synchronous `express` that fires the request and does not wait for it —
 * the shape `rotifer test`'s T1 suite runs (its runner is synchronous). A
 * refusal is caught; a request that gets out is counted by the server.
 */
const FIRE_AND_FORGET_SOURCE = [
  "export function express(input: { q?: unknown }) {",
  "  fetch(process.env.EGRESS_URL as string).catch(() => {});",
  "  return { ok: true, q: input?.q ?? null };",
  "}",
  "",
].join("\n");

/** A suite every case of which FIRE_AND_FORGET_SOURCE passes. */
const PASSING_SUITE = {
  config: { fuzzIterations: 2, seed: 1 },
  testCases: [
    { input: { q: "x" }, expectedSchema: { type: "object", required: ["ok"] } },
    { input: { q: 1 }, expectedSchema: { type: "object", required: ["ok"] } },
  ],
};

/** `display()` runs after the pipeline; it reaches out, `express` does not. */
const DISPLAY_SOURCE = [
  "export function express(input: { q?: string }) {",
  "  return { q: input?.q ?? null };",
  "}",
  "export function display(_output: unknown) {",
  "  fetch(process.env.EGRESS_URL as string).catch(() => {});",
  "}",
  "",
].join("\n");

type Network = { allowedDomains: string[] } | null;

/**
 * A project holding the probe under `name` and a second copy under
 * `${name}-b` (a TryPool needs two genes in a domain), each wrapped, then
 * given `network` (null: none at all).
 */
async function projectWith(name: string, network: Network, fidelity = "Wrapped", source = PROBE_SOURCE): Promise<string> {
  const project = mkdtempSync(join(tmp, "ws-"));
  mkdirSync(join(project, ".home"), { recursive: true });
  writeFileSync(
    join(project, "rotifer.json"),
    JSON.stringify({ name: "egress", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "general" }),
  );
  for (const gene of [name, `${name}-b`]) {
    mkdirSync(join(project, "genes", gene), { recursive: true });
    writeFileSync(join(project, "genes", gene, "index.ts"), source);
    const wrapped = await cli(project, ["wrap", gene, "--domain", "tools"]);
    expect(wrapped.code, wrapped.out).toBe(0);

    const phenotypePath = join(project, "genes", gene, "phenotype.json");
    const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
    delete phenotype.network;
    if (network) phenotype.network = { ...network, maxTimeoutMs: 10_000, maxResponseBytes: 1_048_576, maxRequestsPerMin: 10 };
    phenotype.fidelity = fidelity;
    writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2));
  }
  return project;
}

const RUNS: Array<[string, (project: string) => Promise<Result>]> = [
  ["test", (p) => cli(p, ["test", GENE, "--verbose"])],
  ["run", (p) => cli(p, ["run", GENE, "--no-sandbox", "--verbose", "--input", '{"q":"x"}'])],
  [
    "agent run",
    async (p) => {
      const created = await cli(p, ["agent", "create", "probe-agent", "--genes", GENE]);
      expect(created.code, created.out).toBe(0);
      return cli(p, ["agent", "run", "probe-agent", "--no-sandbox", "--verbose", "--input", '{"q":"x"}']);
    },
  ],
  [
    "agent run (TryPool)",
    async (p) => {
      const created = await cli(p, ["agent", "create", "probe-pool", "--genes", GENE, `${GENE}-b`, "--composition", "TryPool"]);
      expect(created.code, created.out).toBe(0);
      const ran = await cli(p, ["agent", "run", "probe-pool", "--no-sandbox", "--verbose", "--input", '{"q":"x"}']);
      expect(ran.out).toMatch(/TryPool/);
      // A TryPool prints only that its genes failed; why is in each gene's run log.
      const log = join(p, ".home", ".rotifer", "run-logs", `${GENE}.jsonl`);
      return { ...ran, out: ran.out + (existsSync(log) ? readFileSync(log, "utf-8") : "") };
    },
  ],
];

describe.runIf(existsSync(CLI))("a gene's global fetch under the CLI", () => {
  beforeEach(() => {
    hits = 0;
  });

  describe.each(RUNS)("rotifer %s", (_label, runIt) => {
    it("is refused when the gene declares no network, naming the host and how to declare it", async () => {
      const r = await runIt(await projectWith(GENE, null));
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/declares no network access/);
      expect(r.out).toContain("localhost");
      expect(r.out).toMatch(/allowedDomains/);
      expect(hits).toBe(0);
    }, 240_000);

    it("is refused for a host off the allow-list", async () => {
      const r = await runIt(await projectWith(GENE, { allowedDomains: ["api.example.com"] }));
      expect(r.code, r.out).not.toBe(0);
      // (the TryPool's run log is JSON, where the quotes are escaped)
      expect(r.out).toMatch(/\\?"localhost\\?" is not in the allowed list: \[api\.example\.com\]/);
      expect(hits).toBe(0);
    }, 240_000);

    it("holds the gene's top-level code (run on import) to the same declaration", async () => {
      const r = await runIt(await projectWith(GENE, null, "Wrapped", TOP_LEVEL_SOURCE));
      expect(r.code, r.out).not.toBe(0);
      expect(r.out).toMatch(/declares no network access/);
      expect(hits).toBe(0);
    }, 240_000);

    it("reaches an allowed host through the gateway", async () => {
      const r = await runIt(await projectWith(GENE, { allowedDomains: ["localhost"] }));
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("pong");
      expect(hits).toBe(1);
    }, 240_000);
  });

  // The gateway reports what it carried; the paths that print its counts.
  it.each([
    ["test", /Gateway: 1 requests/],
    ["run", /Gateway: 1 requests/],
    ["agent run", /Gateway stats: 1 requests/],
  ])("rotifer %s counts the request in the gateway", async (label, pattern) => {
    const runIt = RUNS.find(([l]) => l === label)![1];
    const r = await runIt(await projectWith(GENE, { allowedDomains: ["localhost"] }));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(pattern);
  }, 240_000);

  it("a Hybrid gene is held to the same declaration", async () => {
    const refused = await cli(await projectWith(GENE, { allowedDomains: ["api.example.com"] }, "Hybrid"), ["test", GENE]);
    expect(refused.code, refused.out).not.toBe(0);
    expect(refused.out).toMatch(/"localhost" is not in the allowed list/);
    expect(hits).toBe(0);
  }, 240_000);

  describe("rotifer test's T1 suite (testsuite.json, run under Node)", () => {
    async function withSuite(network: Network): Promise<string> {
      const project = await projectWith(GENE, network, "Wrapped", FIRE_AND_FORGET_SOURCE);
      writeFileSync(join(project, "genes", GENE, "testsuite.json"), JSON.stringify(PASSING_SUITE));
      // `q` must be a string, so { q: 1 } is the suite's negative case — publish's gate needs one.
      const phenotypePath = join(project, "genes", GENE, "phenotype.json");
      const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
      phenotype.inputSchema = { type: "object", properties: { q: { type: "string" } } };
      phenotype.description = "Egress probe";
      writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2));
      return project;
    }

    it("holds every case the suite runs to the gene's declaration", async () => {
      const r = await cli(await withSuite(null), ["test", GENE]);
      expect(r.out).toMatch(/T1 TestSuite/);
      expect(r.code, r.out).toBe(0);
      // the suite's two cases and its property runs, plus the plain test run: none got out
      expect(hits).toBe(0);
    }, 240_000);

    it("holds them to it under rotifer publish too, which runs the suite before uploading", async () => {
      const project = await withSuite(null);
      // A made-up login that needs no refresh, so publish gets as far as the
      // suite. The upload after it goes to the local server, which answers it
      // slowly with a 503: time for anything the suite let out to land.
      mkdirSync(join(project, ".home", ".rotifer"), { recursive: true });
      writeFileSync(
        join(project, ".home", ".rotifer", "credentials.json"),
        JSON.stringify({
          access_token: "t", refresh_token: "r", expires_at: Date.now() + 3_600_000, provider: "github",
          user: { id: "u", username: "egress", avatar_url: null, provider_id: "" },
        }),
      );
      const r = await cli(project, ["publish", GENE, "--skip-arena"], { ROTIFER_CLOUD_ENDPOINT: origin });
      expect(r.out).toMatch(/T1 publishing gate: T1 satisfied/);
      // the CLI's own request is not the gene's: it reaches the server
      expect(r.out).toMatch(/Cloud API error \(503\)/);
      expect(hits).toBe(0);
    }, 240_000);

    it("lets them reach a host the gene allows", async () => {
      const r = await cli(await withSuite({ allowedDomains: ["localhost"] }), ["test", GENE]);
      expect(r.out).toMatch(/T1 TestSuite/);
      expect(r.code, r.out).toBe(0);
      expect(hits).toBeGreaterThan(1);
    }, 240_000);
  });

  describe("rotifer hello", () => {
    it("holds the template gene's display() to the same declaration", async () => {
      const r = await cli(await projectWith(HELLO_GENE, null, "Wrapped", DISPLAY_SOURCE), ["hello", "--template", "code-security"]);
      expect(r.out).not.toMatch(/not in the allowed list/);
      expect(hits).toBe(0);
    }, 240_000);

    it("is refused when the template's gene declares no network", async () => {
      const r = await cli(await projectWith(HELLO_GENE, null), ["hello", "--template", "code-security"]);
      expect(r.out).toMatch(/declares no network access/);
      expect(hits).toBe(0);
    }, 240_000);

    it("holds the template gene's top-level code to the same declaration", async () => {
      const r = await cli(await projectWith(HELLO_GENE, null, "Wrapped", TOP_LEVEL_SOURCE), ["hello", "--template", "code-security"]);
      expect(r.out).toMatch(/declares no network access/);
      expect(hits).toBe(0);
    }, 240_000);

    it("reaches a host the template's gene allows", async () => {
      const r = await cli(await projectWith(HELLO_GENE, { allowedDomains: ["localhost"] }), ["hello", "--template", "code-security"]);
      expect(r.out).not.toMatch(/declares no network access|not in the allowed list/);
      expect(hits).toBe(1);
    }, 240_000);
  });
});
