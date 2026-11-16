/**
 * `rotifer test <gene> --json` prints the T1 results as JSON (spec §47.2
 * TestResult), as its help says.
 *
 * The root command has a `--json` of its own (the output mode), and the
 * option parser gave the flag to it wherever it was written, so `test` never
 * saw it and printed no JSON.
 *
 * Needs `npm run build`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const GENE = "json-probe";
let project = "";

function cli(args: string[]): { code: number | null; stdout: string; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf-8",
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
    },
  });
  return { code: r.status, stdout: r.stdout, out: `${r.stdout}${r.stderr}` };
}

/** The JSON object in `text` that starts with `{` + "requirements", or null. */
function t1Json(text: string): { requirements: unknown; gatePassed: boolean; results: Array<{ testId: string; passed: boolean }> } | null {
  const start = text.indexOf('{\n  "requirements"');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  return null;
}

beforeAll(() => {
  expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
  project = mkdtempSync(join(tmpdir(), "rotifer-test-json-"));
  mkdirSync(join(project, ".home"), { recursive: true });
  mkdirSync(join(project, "genes", GENE), { recursive: true });
  writeFileSync(
    join(project, "rotifer.json"),
    JSON.stringify({ name: "json", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "general" }),
  );
  writeFileSync(
    join(project, "genes", GENE, "index.ts"),
    [
      "export function express(input: { q?: unknown }) {",
      "  if (typeof input?.q !== 'string') return { __rotifer_error: { message: 'q must be a string' } };",
      "  return { echo: input.q };",
      "}",
      "",
    ].join("\n"),
  );
  const wrapped = cli(["wrap", GENE, "--domain", "tools"]);
  expect(wrapped.code, wrapped.out).toBe(0);
  const phenotypePath = join(project, "genes", GENE, "phenotype.json");
  const phenotype = JSON.parse(readFileSync(phenotypePath, "utf-8"));
  phenotype.inputSchema = { type: "object", required: ["q"], properties: { q: { type: "string" } } };
  phenotype.outputSchema = { type: "object", required: ["echo"], properties: { echo: { type: "string" } } };
  writeFileSync(phenotypePath, JSON.stringify(phenotype, null, 2));
  writeFileSync(
    join(project, "genes", GENE, "testsuite.json"),
    JSON.stringify({
      config: { fuzzIterations: 2, seed: 1 },
      testCases: [{ input: { q: "hi" }, expectedOutput: { echo: "hi" } }, { input: { q: 1 } }],
    }),
  );
});
afterAll(() => rmSync(project, { recursive: true, force: true }));

describe("rotifer test --json", () => {
  it.each([
    ["after the gene", ["test", GENE, "--json"]],
    ["before the command", ["--json", "test", GENE]],
  ])("prints the T1 results as JSON, with --json %s", (_where, args) => {
    const r = cli(args);
    expect(r.code, r.out).toBe(0);
    const report = t1Json(r.stdout);
    expect(report, r.out).not.toBeNull();
    expect(report!.gatePassed).toBe(true);
    expect(report!.requirements).toEqual({ positive: true, negative: true, property: true });
    expect(report!.results.map((x) => x.testId)).toEqual(["t1-positive-0", "t1-negative-1", "t1-property-schema-legality"]);
  }, 120_000);

  it("prints no JSON without it", () => {
    const r = cli(["test", GENE]);
    expect(r.code, r.out).toBe(0);
    expect(t1Json(r.stdout)).toBeNull();
  }, 120_000);
});
