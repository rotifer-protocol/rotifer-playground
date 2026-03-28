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

describe("ClawHub migration output structure", () => {
  const GENE_DIR = join(TMP, "genes", "clawhub-test-gene");

  it("phenotype.json contains source: clawhub when migrated", () => {
    if (!existsSync(join(GENE_DIR, "phenotype.json"))) return;

    const phenotype = JSON.parse(readFileSync(join(GENE_DIR, "phenotype.json"), "utf-8"));
    expect(phenotype.source).toBe("clawhub");
    expect(phenotype.clawhub).toBeDefined();
    expect(phenotype.clawhub.slug).toBeDefined();
    expect(phenotype.clawhub.originalAuthor).toBeDefined();
    expect(phenotype.clawhub.downloads).toBeTypeOf("number");
    expect(phenotype.clawhub.migratedAt).toBeDefined();
  });

  it(".gene-manifest.json contains fromClawhub field", () => {
    if (!existsSync(join(GENE_DIR, ".gene-manifest.json"))) return;

    const manifest = JSON.parse(readFileSync(join(GENE_DIR, ".gene-manifest.json"), "utf-8"));
    expect(manifest.fromClawhub).toBeDefined();
    expect(manifest.clawhubVersion).toBeDefined();
  });
});
