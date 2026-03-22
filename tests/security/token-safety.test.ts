import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, env?: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: join(__dirname, "..", ".."),
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0", ...env },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      exitCode: err.status ?? 1,
    };
  }
}

describe("Security: token safety", () => {
  const fakeToken = "npm_FAKESECRETTOKEN1234567890abcdef";

  it("publish error output does not leak NPM_TOKEN", () => {
    const result = run("publish nonexistent-gene", { NPM_TOKEN: fakeToken });
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(fakeToken);
  });

  it("logout output does not leak credentials", () => {
    const result = run("logout", { ROTIFER_API_KEY: fakeToken });
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(fakeToken);
  });

  it("--help output does not contain any token patterns", () => {
    const result = run("--help");
    expect(result.stdout).not.toMatch(/npm_[A-Za-z0-9]{20,}/);
    expect(result.stdout).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
  });

  it("error messages use generic descriptions instead of raw values", () => {
    const result = run("publish nonexistent-gene");
    const combined = result.stdout + result.stderr;
    expect(combined).not.toMatch(/Bearer [A-Za-z0-9_.+-]{20,}/);
  });
});
