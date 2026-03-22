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

describe("Edge: duplicate arguments", () => {
  const fakeId = "00000000-0000-0000-0000-000000000001";

  it("compare with same ID twice does not crash", () => {
    const result = run(`compare ${fakeId} ${fakeId}`);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("compare with 6 IDs exceeds maximum", () => {
    const ids = Array(6).fill(fakeId).join(" ");
    const result = run(`compare ${ids}`);
    expect(result.exitCode).not.toBe(0);
  });

  it("compare with exactly 5 IDs is accepted (max boundary)", () => {
    const ids = Array(5).fill(0).map((_, i) =>
      `00000000-0000-0000-0000-00000000000${i + 1}`
    ).join(" ");
    const result = run(`compare ${ids}`);
    expect(result.stdout).not.toContain("too many");
  });

  it("search with empty string does not crash", () => {
    const result = run('search ""');
    expect(result.stdout).not.toContain("TypeError");
  });
});
