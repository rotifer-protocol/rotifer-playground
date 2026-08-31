import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(__dirname, "../../dist/index.js");
const TMP = join(tmpdir(), `rotifer-clawhub-test-${Date.now()}`);

function run(args: string, cwd?: string): string {
  try {
    return execSync(`node "${CLI}" ${args} 2>&1`, {
      cwd: cwd ?? TMP,
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (e: any) {
    const stdout = e.stdout?.toString() ?? "";
    const stderr = e.stderr?.toString() ?? "";
    return stdout + stderr;
  }
}

function initProject(): void {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    join(TMP, "rotifer.json"),
    JSON.stringify({ name: "test-clawhub", genes_dir: "genes", default_domain: "general", author: "test" })
  );
  mkdirSync(join(TMP, "genes"), { recursive: true });
}

describe("rotifer wrap --from-clawhub", () => {
  beforeAll(() => initProject());
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  it("wrap --help lists --from-clawhub option", () => {
    const output = run("wrap --help");
    expect(output).toContain("--from-clawhub");
    expect(output).toContain("ClawHub");
  });

  it("wrap --help lists --from-skill option alongside --from-clawhub", () => {
    const output = run("wrap --help");
    expect(output).toContain("--from-skill");
    expect(output).toContain("--from-clawhub");
  });

  it("--from-clawhub with nonexistent slug fails with E0010", () => {
    const output = run("wrap test-gene --from-clawhub this-slug-does-not-exist-ever-999");
    expect(output).toMatch(/E0010|not found|API error/i);
  });

  it("--from-clawhub without slug value shows usage error", () => {
    const output = run("wrap test-gene --from-clawhub");
    expect(output).toMatch(/error|argument|required/i);
  });
});

/**
 * Real ClawHub, real network — the layer that actually would have caught the
 * 307 regression (2026-08-31: ClawHub's download endpoint moved from 302 to
 * 307, httpsGet() only followed 301/302, every --from-clawhub wrap failed
 * with a generic E0011 that gave no hint the real cause was an unrecognized
 * redirect status). This suite previously never ran a real download at all —
 * both assertions below read `if (!existsSync(...)) return`, which is
 * indistinguishable from "passed" in a CI summary and is exactly how a dead
 * code path stays dead: the fixture has to actually attempt the thing it
 * claims to verify, or a real regression here goes unnoticed the same way
 * this one did.
 *
 * "grilling" (@wufei-png) is a small, stable, real ClawHub listing — same
 * one used to hand-verify the fix this suite is regression-testing for.
 */
describe("ClawHub migration output structure (real download)", () => {
  const GENE_DIR = join(TMP, "genes", "clawhub-real-gene");
  let wrapOutput = "";

  beforeAll(() => {
    // Not guaranteed to run after the first describe block's beforeAll —
    // sibling describes' beforeAll ordering isn't reliable across the two
    // blocks in this file — so this makes its own project directory rather
    // than depending on initProject() having already run.
    if (!existsSync(join(TMP, "rotifer.json"))) initProject();
    wrapOutput = run("wrap clawhub-real-gene --from-clawhub grilling");
  }, 30_000); // real network: metadata fetch + zip download + unzip, matches run()'s own execSync timeout

  it("wrap succeeds against the live ClawHub endpoint", () => {
    expect(wrapOutput, wrapOutput).toContain("Grilling");
    expect(existsSync(join(GENE_DIR, "phenotype.json")), wrapOutput).toBe(true);
  });

  it("phenotype.json contains source: clawhub when migrated", () => {
    const phenotype = JSON.parse(readFileSync(join(GENE_DIR, "phenotype.json"), "utf-8"));
    expect(phenotype.source).toBe("clawhub");
    expect(phenotype.clawhub).toBeDefined();
    expect(phenotype.clawhub.slug).toBeDefined();
    expect(phenotype.clawhub.originalAuthor).toBeDefined();
    expect(phenotype.clawhub.downloads).toBeTypeOf("number");
    expect(phenotype.clawhub.migratedAt).toBeDefined();
  });

  it(".gene-manifest.json contains fromClawhub field", () => {
    const manifest = JSON.parse(readFileSync(join(GENE_DIR, ".gene-manifest.json"), "utf-8"));
    expect(manifest.fromClawhub).toBeDefined();
    expect(manifest.clawhubVersion).toBeDefined();
  });
});
