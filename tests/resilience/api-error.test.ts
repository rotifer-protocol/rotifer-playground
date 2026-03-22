import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const PROJECT_ROOT = join(__dirname, "..", "..");

function run(args: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe("Resilience: API error handling", () => {
  it("search with non-existent domain returns empty or error, not crash", () => {
    const result = run("search zzz-nonexistent-query-12345 --domain nonexistent-domain-xyz");
    expect(result.stdout).not.toContain("TypeError");
    expect(result.stdout).not.toContain("Cannot read properties");
  });

  it("info with malformed UUID does not crash", () => {
    const result = run("info not-a-uuid");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("versions with nonexistent owner/name returns graceful message", () => {
    const result = run("versions nonexistent-owner-xyz nonexistent-name-xyz");
    expect(result.stdout).not.toContain("TypeError");
    expect(result.stdout).not.toContain("Cannot read properties");
  });

  it("compare with single ID returns argument error", () => {
    const result = run("compare 00000000-0000-0000-0000-000000000001");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/at least 2|minimum|two/i);
  });
});
