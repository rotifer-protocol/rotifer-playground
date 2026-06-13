import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string): { stdout: string; exitCode: number } {
  try {
    return { stdout: execSync(`node ${CLI} ${args}`, { encoding: "utf-8", timeout: 30000, env: { ...process.env, FORCE_COLOR: "0" } }), exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe("rotifer doctor (R5)", () => {
  it("reports toolchain sections (esbuild / javy / npx / node)", () => {
    const { stdout } = run("doctor");
    expect(stdout).toMatch(/esbuild:/);
    expect(stdout).toMatch(/javy:/);
    expect(stdout).toMatch(/active npx:/);
    expect(stdout).toMatch(/node:/);
  });

  it("exits 0 when the toolchain is present (esbuild+javy are devDeps)", () => {
    const { stdout, exitCode } = run("doctor");
    expect(stdout).toMatch(/esbuild:\s+ok/);
    expect(stdout).toMatch(/javy:\s+ok/);
    expect(exitCode).toBe(0);
  });
});
