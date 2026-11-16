/**
 * A gene whose `express` returns a Promise that never settles, under the real
 * CLI: `rotifer test` (its Test 6 run and the T1 suite), `rotifer run` and
 * `rotifer agent run` each report it as a failure and exit non-zero.
 *
 * Nothing else is left to run once such a gene is waited on, so Node's event
 * loop empties and the process used to exit there — with code 0, having
 * printed nothing about it. That read as a pass.
 *
 * The local http server counts requests to /ping. A gene here declares no
 * network, so any request of its that reaches the server got past the egress
 * guard (egress-guard.ts).
 *
 * Needs `npm run build`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const GENE = "never-settles";
const NEVER = /Gene 'never-settles' never finished/g;

let tmp = "";
let server: Server;
let url = "";
let hits = 0;

beforeAll(async () => {
  expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
  tmp = mkdtempSync(join(tmpdir(), "rotifer-never-settles-"));
  server = createServer((req, res) => {
    if (req.url === "/ping") hits++;
    res.end("pong");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ping`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => {
  hits = 0;
});

interface Result {
  code: number | null;
  out: string;
}

function cli(project: string, args: string[]): Promise<Result> {
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
          ROTIFER_CLOUD_ENDPOINT: "https://127.0.0.1:9",
          ROTIFER_CLOUD_ANON_KEY: "anon-test-key",
          PING_URL: url,
        },
      },
      (_err, stdout, stderr) => done({ code: child.exitCode, out: `${stdout}${stderr}` }),
    );
    child.stdin?.end();
  });
}

/** Never settles, whatever the input: nothing is left that could resolve it. */
const HANGS = [
  "export function express(_input: unknown) {",
  "  return new Promise(() => {});",
  "}",
  "",
].join("\n");

/**
 * Never settles on `{ hang: true }`, and leaves behind a timer that does not
 * keep the process alive but fires later inside the gene's own context and
 * calls the network. On `{ slow: true }` it answers after a while — long
 * enough for those timers to fire. Otherwise it answers at once.
 */
const SOMETIMES_HANGS = [
  "export async function express(input: { q?: unknown; hang?: boolean; slow?: boolean }) {",
  "  if (input?.hang) {",
  "    setTimeout(() => { fetch(process.env.PING_URL as string).catch(() => {}); }, 200).unref();",
  "    return new Promise(() => {});",
  "  }",
  "  if (input?.slow) await new Promise((r) => setTimeout(r, 800));",
  "  return { ok: true };",
  "}",
  "",
].join("\n");

/** A project holding `source` as `name` and `${name}-b` (a TryPool needs two), wrapped, with no `network`. */
async function projectWith(source: string): Promise<string> {
  const project = mkdtempSync(join(tmp, "ws-"));
  mkdirSync(join(project, ".home"), { recursive: true });
  writeFileSync(
    join(project, "rotifer.json"),
    JSON.stringify({ name: "settles", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "general" }),
  );
  for (const gene of [GENE, `${GENE}-b`]) {
    mkdirSync(join(project, "genes", gene), { recursive: true });
    writeFileSync(join(project, "genes", gene, "index.ts"), source);
    const wrapped = await cli(project, ["wrap", gene, "--domain", "tools"]);
    expect(wrapped.code, wrapped.out).toBe(0);
    const phenotypePath = join(project, "genes", gene, "phenotype.json");
    const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
    delete phenotype.network;
    phenotype.inputSchema = { type: "object", properties: { q: { type: "string" } } };
    phenotype.outputSchema = { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } };
    writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2));
  }
  return project;
}

describe("a gene whose express never settles", () => {
  it("fails rotifer test's Test 6 run, saying why, and exits non-zero", async () => {
    const r = await cli(await projectWith(HANGS), ["test", GENE]);
    expect(r.out).toMatch(/Test 6/);
    expect(r.out.match(NEVER), r.out).toHaveLength(1);
    expect(r.code, r.out).not.toBe(0);
  }, 120_000);

  it("fails each T1 case that never settles, once, runs the rest, and lets nothing out", async () => {
    const project = await projectWith(SOMETIMES_HANGS);
    writeFileSync(
      join(project, "genes", GENE, "testsuite.json"),
      JSON.stringify({
        config: { fuzzIterations: 2, seed: 1 },
        testCases: [
          { input: { q: "a", hang: true }, expectedSchema: { type: "object", required: ["ok"] } },
          { input: { q: "b", hang: true }, expectedSchema: { type: "object", required: ["ok"] } },
          { input: { q: "c", slow: true }, expectedSchema: { type: "object", required: ["ok"] } },
        ],
      }),
    );
    const r = await cli(project, ["test", GENE]);
    expect(r.out).toMatch(/T1 TestSuite/);
    expect(r.out).toMatch(/✗ +t1-positive-0: .*Gene 'never-settles' never finished/);
    expect(r.out).toMatch(/✗ +t1-positive-1: .*Gene 'never-settles' never finished/);
    expect(r.out).toMatch(/✓ +t1-positive-2: output conforms to expectedSchema/);
    expect(r.out).toMatch(/✓ +t1-property-schema-legality/);
    // judged once each: the two hung cases, and nothing else
    expect(r.out.match(NEVER), r.out).toHaveLength(2);
    expect(r.code, r.out).not.toBe(0);
    // the hung cases' timers fired during the slow case, inside the gene's
    // context: the guard was still up for them, so neither request got out
    expect(hits).toBe(0);
  }, 120_000);

  it("keeps a failed call's window open: the gene's later request is still refused, with no other window open", async () => {
    // The window in a process of its own, as the CLI uses it: after the call
    // is failed the process does only its own work (a timer outside any gene
    // context), and the gene's timer fires then, inside the gene's context.
    const script = join(tmp, "window.mjs");
    writeFileSync(
      script,
      [
        `import { geneEgress, withGeneEgress } from ${JSON.stringify(pathToFileURL(join(__dirname, "..", "..", "dist", "runtime", "egress-guard.js")).href)};`,
        "const [, , ping] = process.argv;",
        "withGeneEgress(geneEgress('stuck', {}), () => {",
        "  setTimeout(() => { fetch(ping).then(() => console.log('SENT'), (e) => console.log('REFUSED ' + e.message)); }, 300).unref();",
        "  return new Promise(() => {});",
        "}).catch((e) => {",
        "  console.log('FAILED ' + e.message);",
        "  setTimeout(() => console.log('DONE'), 900);",
        "});",
      ].join("\n"),
    );
    const r = await new Promise<Result>((done) => {
      const child = execFile(process.execPath, [script, url], { timeout: 30_000 }, (_e, stdout, stderr) =>
        done({ code: child.exitCode, out: `${stdout}${stderr}` }),
      );
    });
    expect(r.out).toMatch(/FAILED Gene 'stuck' never finished/);
    expect(r.out).toMatch(/REFUSED Gene 'stuck' declares no network access/);
    expect(r.out).toMatch(/DONE/);
    expect(hits).toBe(0);
  }, 60_000);

  it("fails rotifer run, saying why, and exits non-zero", async () => {
    const r = await cli(await projectWith(HANGS), ["run", GENE, "--no-sandbox", "--input", '{"q":"x"}']);
    expect(r.out.match(NEVER), r.out).toHaveLength(1);
    expect(r.code, r.out).not.toBe(0);
  }, 120_000);

  it("fails rotifer agent run, saying why, and exits non-zero", async () => {
    const project = await projectWith(HANGS);
    const created = await cli(project, ["agent", "create", "hangs", "--genes", GENE]);
    expect(created.code, created.out).toBe(0);
    const r = await cli(project, ["agent", "run", "hangs", "--no-sandbox", "--input", '{"q":"x"}']);
    // agent run prints a failed step's error in its summary and again on exit
    expect(r.out.match(NEVER)?.length ?? 0, r.out).toBeGreaterThan(0);
    expect(r.code, r.out).not.toBe(0);
  }, 120_000);

  it("fails a TryPool of such genes under rotifer agent run, and exits non-zero", async () => {
    const project = await projectWith(HANGS);
    const created = await cli(project, ["agent", "create", "pool", "--genes", GENE, `${GENE}-b`, "--composition", "TryPool"]);
    expect(created.code, created.out).toBe(0);
    const r = await cli(project, ["agent", "run", "pool", "--no-sandbox", "--input", '{"q":"x"}']);
    expect(r.out).toMatch(/TryPool/);
    expect(r.code, r.out).not.toBe(0);
    // A TryPool prints only that its genes failed; why is in each gene's run log.
    const log = join(project, ".home", ".rotifer", "run-logs", `${GENE}.jsonl`);
    expect(existsSync(log) ? readFileSync(log, "utf-8") : "", r.out).toMatch(/Gene 'never-settles' never finished/);
  }, 120_000);
});
