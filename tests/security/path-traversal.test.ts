import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `rotifer-sec-path-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Security: path traversal", () => {
  it("init rejects name with ../", () => {
    const result = run('init "../../../tmp/pwned"', testDir);
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(join(testDir, "..", "..", "..", "tmp", "pwned"))).toBe(false);
  });

  it("init with absolute path creates project at that path (by design)", () => {
    const absTarget = join(testDir, "abs-project");
    const result = run(`init ${absTarget} --no-genesis`, testDir);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(absTarget, "rotifer.json"))).toBe(true);
  });

  it("init with normal name succeeds", () => {
    const result = run("init safe-project --no-genesis", testDir);
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(testDir, "safe-project", "rotifer.json"))).toBe(true);
  });

  it("wrap rejects gene path with traversal characters", () => {
    const projDir = join(testDir, "proj");
    run("init proj --no-genesis", testDir);
    const result = run("wrap ../../etc/passwd --domain test", projDir);
    expect(result.exitCode).not.toBe(0);
  });

  it("gene names with slashes are rejected or sanitized", () => {
    const projDir = join(testDir, "proj2");
    run("init proj2 --no-genesis", testDir);
    const result = run("wrap foo/bar/baz --domain test", projDir);
    expect(result.exitCode).not.toBe(0);
  });

  it("wrap validation errors are structured and do not leak stack traces or absolute paths (#51)", () => {
    const projDir = join(testDir, "proj3");
    run("init proj3 --no-genesis", testDir);
    const result = run("wrap ../../etc/passwd --domain test", projDir);
    expect(result.exitCode).not.toBe(0);
    // Structured CLI error, not a raw thrown exception
    expect(result.stdout).toContain("error[E0004]");
    // No Node.js stack frames leaked
    expect(result.stdout).not.toMatch(/\n\s+at\s+/);
    expect(result.stdout).not.toContain("node:internal");
    // No absolute install/runtime paths leaked
    expect(result.stdout).not.toContain("/dist/commands/");
    expect(result.stdout).not.toMatch(/\/Users\//);
  });
});
