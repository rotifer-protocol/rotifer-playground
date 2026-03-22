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
  testDir = join(tmpdir(), `rotifer-res-cfg-${randomUUID()}`);
  mkdirSync(join(testDir, "genes"), { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Resilience: config corruption", () => {
  it("scan still works with invalid JSON (only needs dir detection)", () => {
    writeFileSync(join(testDir, "rotifer.json"), "{broken json!!!");
    const result = run("scan", testDir);
    expect(result.exitCode).toBe(0);
  });

  it("missing rotifer.json gives clear error message", () => {
    const emptyDir = join(testDir, "no-config");
    mkdirSync(emptyDir, { recursive: true });
    const result = run("scan", emptyDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/rotifer\.json|not found|init/i);
  });

  it("rotifer.json with wrong type for genes_dir does not crash with unhandled error", () => {
    writeFileSync(join(testDir, "rotifer.json"), JSON.stringify({
      name: "test", version: "0.1.0", author: "test", genes_dir: 12345,
    }));
    const result = run("scan", testDir);
    expect(result.stdout).not.toContain("Cannot read properties of undefined");
  });

  it("scan with empty genes directory completes successfully", () => {
    writeFileSync(join(testDir, "rotifer.json"), JSON.stringify({
      name: "test", version: "0.1.0", author: "test", genes_dir: "genes",
    }));
    const result = run("scan", testDir);
    expect(result.exitCode).toBe(0);
  });
});
