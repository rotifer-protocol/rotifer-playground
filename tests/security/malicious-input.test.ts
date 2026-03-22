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

function makeProject(dir: string): void {
  mkdirSync(join(dir, "genes", "evil"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" })
  );
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `rotifer-sec-input-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Security: malicious input", () => {
  it("handles oversized phenotype.json without crashing", () => {
    makeProject(testDir);
    const bigJson = JSON.stringify({
      name: "evil",
      version: "0.1.0",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      padding: "x".repeat(10 * 1024 * 1024),
    });
    writeFileSync(join(testDir, "genes", "evil", "phenotype.json"), bigJson);
    const result = run("test evil", testDir);
    expect(result.exitCode).not.toBe(0);
  });

  it("handles phenotype.json with deeply nested objects", () => {
    makeProject(testDir);
    let nested: any = { value: "leaf" };
    for (let i = 0; i < 100; i++) {
      nested = { child: nested };
    }
    const json = JSON.stringify({
      name: "evil",
      version: "0.1.0",
      inputSchema: nested,
      outputSchema: { type: "object" },
    });
    writeFileSync(join(testDir, "genes", "evil", "phenotype.json"), json);
    const result = run("test evil", testDir);
    expect(result.exitCode).not.toBe(0);
  });

  it("handles phenotype.json with invalid JSON gracefully", () => {
    makeProject(testDir);
    writeFileSync(join(testDir, "genes", "evil", "phenotype.json"), "{not valid json");
    const result = run("test evil", testDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("Unexpected token");
  });

  it("handles empty phenotype.json gracefully", () => {
    makeProject(testDir);
    writeFileSync(join(testDir, "genes", "evil", "phenotype.json"), "");
    const result = run("test evil", testDir);
    expect(result.exitCode).not.toBe(0);
  });
});
