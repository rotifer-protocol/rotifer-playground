import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

const CLI = join(process.cwd(), "dist", "index.js");
const PROJECT_ROOT = process.cwd();

function cliErr(args: string, cwd?: string): string {
  try {
    return execSync(`node ${CLI} ${args}`, {
      cwd: cwd || PROJECT_ROOT,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: "pipe",
    });
  } catch (e: any) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

describe("publish --changelog", () => {
  const geneName = "_test_changelog_ci";
  const genesDir = join(PROJECT_ROOT, "genes", geneName);

  beforeEach(() => {
    mkdirSync(genesDir, { recursive: true });
    writeFileSync(
      join(genesDir, "phenotype.json"),
      JSON.stringify({
        name: geneName,
        domain: "test",
        version: "0.1.0",
        fidelity: "Wrapped",
        description: "Test gene for changelog",
      }),
    );
  });

  afterEach(() => {
    if (existsSync(genesDir)) rmSync(genesDir, { recursive: true });
  });

  it("accepts --changelog flag without error", () => {
    const out = cliErr(
      `publish ${geneName} --changelog "Initial release"`,
    );
    expect(out).not.toMatch(/unknown option.*--changelog/i);
  });

  it("publish without --changelog still works (backward compat)", () => {
    const out = cliErr(`publish ${geneName}`);
    expect(out).not.toMatch(/unknown option/i);
  });
});

describe("domain format validation", () => {
  it("regex validates correct domain formats", () => {
    const domainRegex = /^[a-z0-9]+(\.[a-z0-9]+)*$/;
    expect(domainRegex.test("media.video")).toBe(true);
    expect(domainRegex.test("sim.particle")).toBe(true);
    expect(domainRegex.test("test")).toBe(true);
    expect(domainRegex.test("code.architecture")).toBe(true);
    expect(domainRegex.test("a.b.c")).toBe(true);
  });

  it("regex rejects invalid domain formats", () => {
    const domainRegex = /^[a-z0-9]+(\.[a-z0-9]+)*$/;
    expect(domainRegex.test("UPPER.CASE")).toBe(false);
    expect(domainRegex.test("has spaces")).toBe(false);
    expect(domainRegex.test(".leading.dot")).toBe(false);
    expect(domainRegex.test("trailing.dot.")).toBe(false);
    expect(domainRegex.test("special!chars")).toBe(false);
    expect(domainRegex.test("../path-traversal")).toBe(false);
    expect(domainRegex.test("")).toBe(false);
  });
});
