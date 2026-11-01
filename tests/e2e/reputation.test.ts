import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRecordedCloud, type RecordedCloud } from "./recorded-cloud.js";

const TEST_DIR = join(tmpdir(), `rotifer-rep-test-${Date.now()}`);
const CLI = join(__dirname, "..", "..", "dist", "index.js");
// Gene reputation and the leaderboard come from the registry: the recorded
// one (tests/fixtures/cloud/). Like the real API it refuses a request that
// carries no publishable key.
let cloud: RecordedCloud;

function run(args: string, opts: { cwd?: string } = {}): {
  stdout: string;
  exitCode: number;
} {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd: opts.cwd || TEST_DIR,
      env: { ...process.env, HOME: TEST_DIR, NO_COLOR: "1", ROTIFER_CLOUD_ENDPOINT: cloud.endpoint },
      timeout: 15_000,
      encoding: "utf-8",
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "") + (err.stderr || ""),
      exitCode: err.status ?? 1,
    };
  }
}

describe("rotifer reputation command", () => {
  beforeAll(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    cloud = await startRecordedCloud();
  });

  afterAll(async () => {
    // Stop the server first, so a failed check cannot leave it running.
    const unrecorded = await cloud.unrecorded();
    await cloud.close();
    expect(unrecorded).toEqual([]);
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("--help shows usage and options", () => {
    const result = run("reputation --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("View gene and creator reputation scores");
    expect(result.stdout).toContain("--mine");
    expect(result.stdout).toContain("--leaderboard");
    expect(result.stdout).toContain("--top");
  });

  it("fails with usage hint when no argument and no flag", () => {
    const result = run("reputation");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Specify a gene reference");
    expect(result.stdout).toContain("--mine");
    expect(result.stdout).toContain("--leaderboard");
  });

  it("--mine fails when not logged in", () => {
    const result = run("reputation --mine");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Not logged in");
    expect(result.stdout).toContain("rotifer login");
  });

  it("gene-ref argument attempts cloud fetch (fails without endpoint)", () => {
    const result = run("reputation 00000000-0000-0000-0000-000000000000");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/failed|error|fetch/i);
    expect(result.stdout).toContain("Gene '00000000-0000-0000-0000-000000000000' not found");
  });

  // Used to assert this failed "without endpoint". It no longer does: the CLI
  // now ships a publishable key, so the leaderboard works on a fresh install
  // with nothing configured — that was the point of shipping one. Assert the
  // reachable behaviour instead: it renders a leaderboard, or reports a
  // network problem, but never an authentication one. The recorded cloud
  // refuses a request with no key the way the real one does; whether the
  // shipped key is still accepted is checked against the real cloud in
  // tests/live/cloud-live.test.ts.
  it("--leaderboard reaches the cloud without any configuration", () => {
    const result = run("reputation --leaderboard");
    expect(result.stdout).not.toMatch(/No API key found/i);
    expect(result.stdout).not.toMatch(/Legacy API keys are disabled/i);
    expect(result.stdout).toMatch(/leaderboard|reputation|rank|unreachable|network|timed out/i);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Reputation Leaderboard");
    expect(result.stdout).toContain("@fixture-creator-1");
  });

  it("--top flag is accepted alongside --leaderboard", () => {
    const result = run("reputation --leaderboard --top 5");
    // Should attempt to fetch, not throw an unknown option error
    expect(result.stdout).not.toContain("unknown option");
    expect(result.stdout).toContain("@fixture-creator-5");
    expect(result.stdout).not.toContain("@fixture-creator-6");
    expect(result.stdout).toContain("Showing top 5 creators");
  });

  it("--mine takes priority over gene-ref when both provided", () => {
    const result = run("reputation some-gene --mine");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Not logged in");
  });

  it("--leaderboard takes priority over --mine", () => {
    const result = run("reputation --leaderboard --mine");
    // Should attempt leaderboard fetch, not complain about login
    expect(result.stdout).not.toContain("Not logged in");
    expect(result.stdout).toContain("Reputation Leaderboard");
  });
});
