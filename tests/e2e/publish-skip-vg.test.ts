import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const CLI = "node dist/index.js";

function cliOut(args: string): string {
  try {
    return execSync(`${CLI} ${args}`, {
      cwd: ROOT,
      encoding: "utf-8",
      timeout: 15_000,
      env: { ...process.env, NODE_ENV: "test" },
    });
  } catch (err: any) {
    return (err.stderr || "") + (err.stdout || "");
  }
}

describe("publish --skip-vg flag (v0.9 §3.8 Phase 1)", () => {
  it("--skip-vg flag is documented in publish --help", () => {
    const out = cliOut("publish --help");
    expect(out).toContain("--skip-vg");
    expect(out.toLowerCase()).toContain("v(g)");
  });

  it("--skip-vg flag is accepted by commander (no 'unknown option' error)", () => {
    const out = cliOut("publish nonexistent-gene-skip-vg-test --skip-vg");
    expect(out).not.toContain("unknown option");
    expect(out).not.toContain("error: unknown");
  });

  it("--skip-vg combined with --skip-security accepted (no flag-conflict error)", () => {
    const out = cliOut("publish nonexistent-gene-combo-test --skip-vg --skip-security");
    expect(out).not.toContain("unknown option");
    expect(out).not.toContain("conflicting");
  });

  it("--skip-vg combined with --skip-arena accepted", () => {
    const out = cliOut("publish nonexistent-gene-arena-test --skip-vg --skip-arena");
    expect(out).not.toContain("unknown option");
  });
});
