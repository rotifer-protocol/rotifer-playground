import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";

/**
 * javy-cli downloads its binary the first time it runs. Left to the test run,
 * that download happens inside a 10-second probe and several parallel test
 * files at once, and a slow day fails `doctor` and `genome-try-fuel` with
 * "javy: missing". CI fetches it first, with retries, and stops if it can't.
 */

const ROOT = join(__dirname, "../..");
const SCRIPT = join(ROOT, "scripts/ci-fetch-javy.mjs");

describe("scripts/ci-fetch-javy.mjs", () => {
  let dir: string;
  let counter: string;

  /** A stand-in for javy that fails its first `failures` runs. */
  function fakeJavy(failures: number, onFail = "exit 1"): string {
    const path = join(dir, "javy");
    writeFileSync(
      path,
      `#!/bin/bash\nn=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${counter}"\n` +
        `if [ "$n" -le ${failures} ]; then ${onFail}; fi\necho "javy 3.0.1"\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  function run(bin: string, extra: Record<string, string> = {}) {
    return spawnSync("node", [SCRIPT], {
      encoding: "utf-8",
      env: { ...process.env, FETCH_JAVY_BIN: bin, FETCH_JAVY_RETRY_DELAY_MS: "1", ...extra },
    });
  }

  const runs = () => Number(readFileSync(counter, "utf-8").trim());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rotifer-fetch-javy-"));
    counter = join(dir, "count");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("stops at the first success", () => {
    const r = run(fakeJavy(0));
    expect(r.status, r.stderr).toBe(0);
    expect(runs()).toBe(1);
  });

  it("retries a failed download and succeeds", () => {
    const r = run(fakeJavy(2));
    expect(r.status, r.stderr).toBe(0);
    expect(runs()).toBe(3);
  });

  it("survives the leftover of an interrupted download, which takes one run to clear", () => {
    const r = run(fakeJavy(3));
    expect(r.status, r.stderr).toBe(0);
    expect(runs()).toBe(4);
  });

  it("fails the job, saying what is missing, when every attempt fails", () => {
    const r = run(fakeJavy(99), { FETCH_JAVY_ATTEMPTS: "3" });
    expect(r.status).toBe(1);
    expect(runs()).toBe(3);
    expect(r.stdout + r.stderr).toMatch(/::error::.*javy/);
  });

  it("does not wait forever on a stalled download", () => {
    const started = Date.now();
    const r = run(fakeJavy(99, "exec sleep 30"), { FETCH_JAVY_ATTEMPTS: "2", FETCH_JAVY_TIMEOUT_MS: "200" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/attempt 1\/2 failed \(ETIMEDOUT\)/);
    expect(r.stdout).toMatch(/attempt 2\/2 failed \(ETIMEDOUT\)/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("every job that runs the full test suite fetches javy first", () => {
  interface Step { name?: string; run?: string }
  const steps = (file: string, job: string): Step[] => {
    const wf = yaml.load(readFileSync(join(ROOT, ".github/workflows", file), "utf-8")) as {
      jobs: Record<string, { steps: Step[] }>;
    };
    return wf.jobs[job].steps;
  };
  const index = (all: Step[], pattern: RegExp) => all.findIndex((s) => pattern.test(s.run ?? ""));

  it.each([
    ["ci.yml", "test"],
    ["release.yml", "validate"],
    ["release.yml", "cross-platform"],
  ])("%s %s", (file, job) => {
    const all = steps(file, job);
    const fetch = index(all, /scripts\/ci-fetch-javy\.mjs/);
    expect(fetch, "the fetch step is missing").toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(index(all, /^npm ci$/));
    expect(fetch).toBeLessThan(index(all, /npm (run test:coverage|test)\b/));
  });
});
