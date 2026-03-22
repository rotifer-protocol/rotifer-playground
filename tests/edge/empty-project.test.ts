import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  testDir = join(tmpdir(), `rotifer-edge-empty-${randomUUID()}`);
  mkdirSync(join(testDir, "genes"), { recursive: true });
  writeFileSync(join(testDir, "rotifer.json"), JSON.stringify({
    name: "empty-project", version: "0.1.0", author: "test", genes_dir: "genes",
  }));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Edge: empty project", () => {
  it("scan in empty project returns zero genes", () => {
    const result = run("scan", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/0|no genes|empty/i);
  });

  it("list in empty project returns zero genes", () => {
    const result = run("list", testDir);
    expect(result.exitCode).toBe(0);
  });

  it("test nonexistent gene gives clear error", () => {
    const result = run("test ghost-gene", testDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/not found|does not exist/i);
  });

  it("compile nonexistent gene gives clear error", () => {
    const result = run("compile ghost-gene", testDir);
    expect(result.exitCode).not.toBe(0);
  });

  it("run nonexistent gene gives clear error", () => {
    const result = run("run ghost-gene", testDir);
    expect(result.exitCode).not.toBe(0);
  });
});
