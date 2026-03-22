import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `rotifer-rep-test-${Date.now()}`);
const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, opts: { cwd?: string } = {}): {
  stdout: string;
  exitCode: number;
} {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd: opts.cwd || TEST_DIR,
      env: { ...process.env, HOME: TEST_DIR },
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
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("--help shows usage and options", () => {
    const result = run("reputation --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("View gene and developer reputation scores");
    expect(result.stdout).toContain("--mine");
    expect(result.stdout).toContain("--leaderboard");
    expect(result.stdout).toContain("--top");
  });

  it("fails with usage hint when no argument and no flag", () => {
    const result = run("reputation");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Specify a gene ID");
    expect(result.stdout).toContain("--mine");
    expect(result.stdout).toContain("--leaderboard");
  });

  it("--mine fails when not logged in", () => {
    const result = run("reputation --mine");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Not logged in");
    expect(result.stdout).toContain("rotifer login");
  });

  it("gene-id argument attempts cloud fetch (fails without endpoint)", () => {
    const result = run("reputation 00000000-0000-0000-0000-000000000000");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/failed|error|fetch/i);
  });

  it("--leaderboard attempts cloud fetch (fails without endpoint)", () => {
    const result = run("reputation --leaderboard");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/failed|error|fetch/i);
  });

  it("--top flag is accepted alongside --leaderboard", () => {
    const result = run("reputation --leaderboard --top 5");
    // Should attempt to fetch, not throw an unknown option error
    expect(result.stdout).not.toContain("unknown option");
  });

  it("--mine takes priority over gene-id when both provided", () => {
    const result = run("reputation some-gene --mine");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Not logged in");
  });

  it("--leaderboard takes priority over --mine", () => {
    const result = run("reputation --leaderboard --mine");
    // Should attempt leaderboard fetch, not complain about login
    expect(result.stdout).not.toContain("Not logged in");
  });
});
