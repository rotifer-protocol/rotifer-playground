import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const PROJECT_ROOT = join(__dirname, "..", "..");

function run(args: string, cwd?: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: cwd || PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe("Resilience: graceful error handling", () => {
  it("search with nonsense query does not crash", () => {
    const result = run("search xyzzy-nonexistent-query-9999");
    expect(result.stdout).not.toContain("TypeError");
    expect(result.stdout).not.toContain("Cannot read properties");
  });

  it("install with all-zero UUID fails gracefully", () => {
    const result = run("install 00000000-0000-0000-0000-000000000000");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("stats with nonexistent gene does not crash", () => {
    const result = run("stats 00000000-0000-0000-0000-000000000000");
    expect(result.stdout).not.toContain("TypeError");
    expect(result.stdout).not.toContain("Cannot read properties");
  });

  it("reputation with bad gene ID fails gracefully", () => {
    const result = run("reputation not-a-uuid");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("TypeError");
  });
});
