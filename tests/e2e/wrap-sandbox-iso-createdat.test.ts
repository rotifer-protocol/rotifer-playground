/**
 * A gene made with `rotifer wrap` must run in the WASM sandbox.
 *
 * `wrap` writes `createdAt` as an ISO 8601 string; rotifer-core reads it as
 * epoch milliseconds. `compile` converts it (toRustPhenotype), but `test`,
 * `arena submit` and `run` handed the raw phenotype to `executeGene`, so the
 * sandbox answered `invalid phenotype JSON: invalid type: string "...",
 * expected u64` and every wrapped gene scored 0/3 and was refused admission.
 * That is the README's own custom-gene walk-through (wrap -> compile -> arena
 * submit), found when a clean install was run end to end on 0.35.0.
 *
 * This runs the real CLI against the real sandbox. Needs `npm run build`, the
 * native module, and esbuild + javy-cli on PATH (a missing precondition shows
 * as skipped, not passed: see toolchain.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hasJavyToolchain, hasSandbox } from "./toolchain.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const GENE = "iso-search";
const ready = hasJavyToolchain && hasSandbox && existsSync(CLI);

describe.runIf(ready)("wrapped gene runs in the sandbox (ISO createdAt in phenotype.json)", () => {
  let project = "";

  const run = (args: string[], timeout = 120_000): { code: number; out: string } => {
    const r = spawnSync("node", [CLI, ...args], {
      cwd: project,
      encoding: "utf-8",
      timeout,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        ROTIFER_TELEMETRY: "off",
        ROTIFER_NO_UPDATE_CHECK: "1",
      },
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "rotifer-wrap-sandbox-"));
    mkdirSync(join(project, "genes", GENE), { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "wrap-sandbox", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
    );
    // The README's example gene.
    writeFileSync(
      join(project, "genes", GENE, "index.ts"),
      "export function express(input: { query: string }) {\n  return { results: [`Found: ${input.query}`], total: 1 };\n}\n",
    );
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("`rotifer test` and `rotifer arena submit` execute a freshly wrapped, compiled gene", () => {
    const wrapped = run(["wrap", GENE, "--domain", "search"]);
    expect(wrapped.code, wrapped.out).toBe(0);
    const phenotype = JSON.parse(readFileSync(join(project, "genes", GENE, "phenotype.json"), "utf-8"));
    // The premise of the bug: wrap really does write a string timestamp.
    expect(typeof phenotype.createdAt).toBe("string");

    const compiled = run(["compile", GENE], 240_000);
    expect(compiled.code, compiled.out).toBe(0);

    const tested = run(["test", GENE]);
    expect(tested.out).not.toMatch(/invalid phenotype JSON/);
    expect(tested.out).toMatch(/executeGene\(\) succeeded/);

    const submitted = run(["arena", "submit", GENE]);
    expect(submitted.out).not.toMatch(/invalid phenotype JSON/);
    expect(submitted.out).toMatch(/Sandbox execution: 3\/3 passed/);
    expect(submitted.out).not.toMatch(/does not meet admission threshold/);
  }, 400_000);
});

/**
 * The same conversion, at the call sites the first test cannot see: a broken
 * `run` or `publish` or `agent run` leaves `test` and `arena submit` green.
 *
 * Each of these fails differently without the conversion, and `run` fails
 * quietly: the sandbox error is swallowed and the gene runs under Node with the
 * host's full privileges, exit code 0, correct-looking output. So the gene
 * reports where it ran (`process` exists under Node, not in the sandbox) and
 * the assertions read that, rather than the exit code.
 *
 * Everything but `compile` (javy-cli caches its binary under the real home)
 * runs with HOME in a scratch directory, so a signed-in developer machine lends
 * this suite neither its session nor its Cloud endpoint.
 */
describe.runIf(ready)("wrapped gene stays in the sandbox: run, agent run, publish", () => {
  const BUG = /invalid phenotype JSON/;
  const IN_SANDBOX = /"node": false/;
  const FIRST = "iso-first";
  const SECOND = "iso-second";
  const SOURCE = [
    "export function express(input: { query: string }) {",
    '  if (typeof input?.query === "number") return { __rotifer_error: { code: "INVALID_INPUT", message: "query must be a string" } };',
    '  return { results: [`Found: ${input.query}`], total: 1, node: typeof process !== "undefined" };',
    "}",
    "",
  ].join("\n");

  let root = "";
  let project = "";
  let home = "";

  const envFor = (userHome: string): NodeJS.ProcessEnv => ({
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    ROTIFER_CONFIG_DIR: join(home, ".config", "rotifer"),
    FORCE_COLOR: "0",
    ROTIFER_TELEMETRY: "off",
    ROTIFER_NO_UPDATE_CHECK: "1",
  });

  const cli = (args: string[], userHome = home, timeout = 120_000): { code: number; out: string } => {
    const r = spawnSync("node", [CLI, ...args], { cwd: project, encoding: "utf-8", timeout, env: envFor(userHome) });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  /** `cli`, without blocking the event loop the stand-in Cloud answers on. */
  const cliAsync = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn("node", [CLI, ...args], { cwd: project, env: envFor(home), stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, out });
      });
    });

  const phenotypeOf = (gene: string): string => join(project, "genes", gene, "phenotype.json");

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-wrap-call-sites-"));
    project = join(root, "project");
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "wrap-call-sites", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
    );

    for (const gene of [FIRST, SECOND]) {
      mkdirSync(join(project, "genes", gene), { recursive: true });
      writeFileSync(join(project, "genes", gene, "index.ts"), SOURCE);
      const wrapped = cli(["wrap", gene, "--domain", "search"]);
      expect(wrapped.code, wrapped.out).toBe(0);

      // A pool needs schemas it can compare, and T1 needs an input to refuse.
      const phenotype = JSON.parse(readFileSync(phenotypeOf(gene), "utf-8"));
      phenotype.inputSchema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
      phenotype.outputSchema = { type: "object" };
      writeFileSync(phenotypeOf(gene), JSON.stringify(phenotype, null, 2));
      writeFileSync(
        join(project, "genes", gene, "testsuite.json"),
        JSON.stringify({ config: { fuzzIterations: 5, seed: 1 }, testCases: [{ input: { query: "a" } }, { input: { query: 1 } }] }),
      );

      const compiled = cli(["compile", gene], process.env.HOME ?? home, 240_000);
      expect(compiled.code, compiled.out).toBe(0);

      // Read after compile, because this is the file every test below hands to
      // the sandbox. If compile ever normalised it, these tests would pass
      // without exercising anything.
      expect(typeof JSON.parse(readFileSync(phenotypeOf(gene), "utf-8")).createdAt).toBe("string");
    }
  }, 500_000);

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("`rotifer run` answers from the sandbox instead of falling back to Node", () => {
    const ran = cli(["run", FIRST, "--input", JSON.stringify({ query: "abc" })]);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).not.toMatch(/falling back to Node/);
    expect(ran.out).toContain("Found: abc");
    expect(ran.out).toMatch(IN_SANDBOX);
  }, 150_000);

  it("`rotifer agent run` executes a single-gene genome in the sandbox", () => {
    const created = cli(["agent", "create", "single", "--genes", FIRST]);
    expect(created.code, created.out).toBe(0);

    const ran = cli(["agent", "run", "single", "--input", JSON.stringify({ query: "def" }), "--verbose"]);
    expect(ran.out).not.toMatch(BUG);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toMatch(/completed via WASM sandbox/);
    expect(ran.out).toContain("Found: def");
  }, 150_000);

  it("`rotifer agent run` executes a TryPool genome in the sandbox", () => {
    const created = cli(["agent", "create", "pool", "--genes", FIRST, SECOND, "--composition", "TryPool"]);
    expect(created.code, created.out).toBe(0);

    const ran = cli(["agent", "run", "pool", "--input", JSON.stringify({ query: "ghi" }), "--verbose"]);
    expect(ran.out).not.toMatch(BUG);
    expect(ran.code, ran.out).toBe(0);
    expect(ran.out).toMatch(/Succeeded: 1\/1/);
    expect(ran.out).toContain("Found: ghi");
    expect(ran.out).toMatch(IN_SANDBOX);
  }, 150_000);

  it("`rotifer publish` clears the T1 gate in the sandbox, against a stand-in Cloud", async () => {
    // The stand-in refuses every call, so nothing is accepted anywhere; the
    // token is fake and HOME is scratch, so nothing could be accepted elsewhere
    // either. The gate runs before the first request, so a request arriving
    // here is also proof the gate let the gene through.
    const seen: string[] = [];
    const standIn = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push(`${req.method} ${req.url}`);
        res.writeHead(418, { "content-type": "application/json" }).end('{"message":"stand-in refuses"}');
      });
    });
    await new Promise<void>((resolve) => standIn.listen(0, "127.0.0.1", resolve));

    try {
      const { port } = standIn.address() as AddressInfo;
      mkdirSync(join(home, ".rotifer"), { recursive: true });
      writeFileSync(
        join(home, ".rotifer", "cloud.json"),
        JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, anonKey: "stand-in-anon" }),
      );
      writeFileSync(
        join(home, ".rotifer", "credentials.json"),
        JSON.stringify({
          access_token: "stand-in-not-a-real-session",
          refresh_token: "stand-in-not-a-real-session",
          expires_at: Date.now() + 3_600_000,
          provider: "github",
          user: { id: "00000000-0000-4000-8000-000000000000", email: "stand-in@example.invalid" },
        }),
      );

      const published = await cliAsync(["publish", FIRST, "--skip-arena"]);
      expect(published.out).not.toMatch(BUG);
      expect(published.out).toMatch(/T1 publishing gate: T1 satisfied/);
      expect(seen.length, published.out).toBeGreaterThan(0);
      expect(existsSync(join(project, "genes", FIRST, ".cloud-manifest.json"))).toBe(false);
    } finally {
      standIn.closeAllConnections();
      standIn.close();
    }
  }, 150_000);
});
