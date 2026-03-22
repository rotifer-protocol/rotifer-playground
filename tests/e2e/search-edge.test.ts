import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe("rotifer search edge cases", () => {
  it("shows help with search options", () => {
    const result = run("search --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Search genes on Rotifer Cloud");
    expect(result.stdout).toContain("--domain");
    expect(result.stdout).toContain("--sort");
  });

  it("searches with keyword and returns results or empty", () => {
    const result = run("search web");
    // Should succeed regardless of whether genes are found
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cloud Gene Search");
  });

  it("searches with domain filter", () => {
    const result = run("search --domain search.web");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Cloud Gene Search");
  });
});
