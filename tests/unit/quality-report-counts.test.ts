/**
 * What CI reports to the Quality Observatory is what the test gate saw.
 *
 * The report job used to run the whole suite a second time, on its own: npm
 * ci, build, vitest with the JSON reporter. It had none of the Test job's
 * set-up (the napi addon built from the commit), so on a release merge — the
 * bumped platform packages not yet on npm — it reported 7 failures the gate
 * never had (0.33.0, run 41278452533). And it sent total, passed and failed
 * but never `skipped`, which the table has always had, so every skipped or
 * todo test showed up as unaccounted for.
 *
 * Now the Test job's ubuntu lane writes its results and uploads them, the
 * report job downloads them, and scripts/quality-test-counts.mjs turns them
 * into the row.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "quality-test-counts.mjs");

/** The script's KEY=VALUE lines for a results file, as an object. */
function counts(resultsFile: string): Record<string, number> {
  const r = spawnSync(process.execPath, [SCRIPT, resultsFile], { encoding: "utf-8" });
  expect(r.status, r.stderr).toBe(0);
  const out: Record<string, number> = {};
  for (const line of r.stdout.trim().split("\n")) {
    const m = /^([A-Z_]+)=(\d+)$/.exec(line);
    expect(m, `not KEY=integer: ${JSON.stringify(line)}`).not.toBeNull();
    out[m![1]] = Number(m![2]);
  }
  return out;
}

describe("scripts/quality-test-counts.mjs", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rotifer-quality-counts-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("counts skipped and todo tests from real vitest JSON output, and the four add up", () => {
    const project = join(dir, "project");
    spawnSync("mkdir", ["-p", project]);
    writeFileSync(
      join(project, "sample.test.mjs"),
      [
        'import { it, expect } from "vitest";',
        'it("passes", () => expect(1).toBe(1));',
        'it("passes too", () => expect(2).toBe(2));',
        'it("fails", () => expect(1).toBe(2));',
        'it.skip("is skipped", () => {});',
        'it.skipIf(true)("is skipped on a condition", () => {});',
        'it.todo("is a todo");',
        "",
      ].join("\n"),
    );
    const results = join(dir, "real.json");
    spawnSync(
      process.execPath,
      [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--root", project, "--reporter=json", `--outputFile=${results}`],
      { cwd: project, encoding: "utf-8", env: { ...process.env, CI: "1" } },
    );
    const raw = JSON.parse(readFileSync(results, "utf-8"));
    expect(raw.numTotalTests).toBe(6);

    expect(counts(results)).toMatchObject({ TOTAL: 6, PASSED: 2, FAILED: 1, SKIPPED: 3 });
  });

  it("counts a test that never got a result — its worker died — as failed, not as nothing", () => {
    const results = join(dir, "crashed.json");
    writeFileSync(
      results,
      JSON.stringify({
        numTotalTests: 10,
        numPassedTests: 8,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        success: false,
        testResults: [],
      }),
    );
    expect(counts(results)).toMatchObject({ TOTAL: 10, PASSED: 8, FAILED: 2, SKIPPED: 0 });
  });

  it("sums the files' durations", () => {
    const results = join(dir, "durations.json");
    writeFileSync(
      results,
      JSON.stringify({
        numTotalTests: 1,
        numPassedTests: 1,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults: [
          { startTime: 1000, endTime: 1250 },
          { startTime: 5000, endTime: 5100.6 },
        ],
      }),
    );
    expect(counts(results).DURATION_MS).toBe(351);
  });

  it.each([
    ["a missing file", "nope.json", undefined],
    ["a file that is not vitest JSON", "other.json", JSON.stringify({ hello: 1 })],
  ])("refuses %s", (_what, name, content) => {
    const file = join(dir, name);
    if (content !== undefined) writeFileSync(file, content);
    const r = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf-8" });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
});

/** One job of ci.yml, as text. */
function job(name: string): string {
  const text = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf-8");
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `the ${name} job is gone from ci.yml`).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("ci.yml reports the Test job's own results", () => {
  it("the Test job's coverage lane writes JSON results and uploads them with the coverage summary, pass or fail", () => {
    const test = job("test");
    expect(test).toMatch(/npm run test:coverage -- --reporter=default --reporter=json --outputFile\.json=test-results\.json/);
    const uses = test.indexOf("actions/upload-artifact@");
    expect(uses, "no upload-artifact step in the test job").toBeGreaterThanOrEqual(0);
    expect(uses).toBeGreaterThan(test.indexOf("npm run test:coverage"));
    // The whole step: from its `- name:` to the next step or the job's end.
    const next = test.indexOf("\n      - ", uses);
    const upload = test.slice(test.lastIndexOf("      - name:", uses), next < 0 ? undefined : next);
    expect(upload).toMatch(/if: always\(\) && matrix\.os == 'ubuntu-latest'/);
    expect(upload).toContain("name: quality-test-results");
    expect(upload).toContain("test-results.json");
    expect(upload).toContain("coverage/coverage-summary.json");
  });

  it("the report job runs no tests of its own: it downloads them and sends skipped too", () => {
    const report = job("report-quality");
    expect(report).not.toMatch(/vitest|npm (ci|test|run (build|test))/);
    expect(report).toContain("actions/download-artifact@");
    expect(report).toContain("name: quality-test-results");
    expect(report).toContain("node scripts/quality-test-counts.mjs test-results.json");
    for (const field of ["total_tests", "passed", "failed", "skipped", "duration_ms", "coverage_pct"]) {
      expect(report, field).toMatch(new RegExp(`\\\\"${field}\\\\": \\$\\{`));
    }
  });
});
