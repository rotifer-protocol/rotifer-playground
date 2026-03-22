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
  testDir = join(tmpdir(), `rotifer-edge-ver-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Edge: version handling", () => {
  it("--version returns valid semver", () => {
    const result = run("--version", testDir);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("install with nonexistent UUID gives clear error", () => {
    const projDir = join(testDir, "proj");
    mkdirSync(join(projDir, "genes"), { recursive: true });
    writeFileSync(join(projDir, "rotifer.json"), JSON.stringify({
      name: "test", version: "0.1.0", author: "test", genes_dir: "genes",
    }));
    const result = run("install 00000000-0000-0000-0000-000000000000", projDir);
    expect(result.exitCode).not.toBe(0);
  });

  it("versions with very long owner/name does not crash", () => {
    const longStr = "a".repeat(200);
    const result = run(`versions ${longStr} ${longStr}`, testDir);
    expect(result.stdout).not.toContain("TypeError");
  });
});
