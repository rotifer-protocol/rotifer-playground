import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

const PROJECT_ROOT = resolve(__dirname, "../..");
const CLI = `node ${resolve(PROJECT_ROOT, "dist/index.js")}`;
const run = (cmd: string, cwd?: string) =>
  execSync(`${CLI} ${cmd}`, {
    cwd: cwd || PROJECT_ROOT,
    encoding: "utf-8",
    timeout: 15000,
    env: { ...process.env, HOME: "/tmp/rotifer-test-home" },
  });

const tryRun = (cmd: string, cwd?: string) => {
  try {
    return run(cmd, cwd);
  } catch (err: any) {
    return err.stderr || err.stdout || err.message;
  }
};

describe("rotifer list", () => {
  let projectDir: string;

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-list-"));
    writeFileSync(join(projectDir, "rotifer.json"), JSON.stringify({ genes_dir: "genes" }));
    const geneDir = join(projectDir, "genes", "test-gene");
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ domain: "test.unit", fidelity: "Wrapped", version: "0.1.0" })
    );
  });

  afterAll(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("lists genes in a project", () => {
    const out = run("list", projectDir);
    expect(out).toContain("test-gene");
    expect(out).toContain("test.unit");
    expect(out).toContain("1 gene");
  });

  it("filters by domain", () => {
    const out = run("list --domain nonexistent", projectDir);
    expect(out).toMatch(/no genes found/i);
  });

  it("shows help with --help", () => {
    const out = run("list --help");
    expect(out).toContain("local genes");
  });
});

describe("rotifer run", () => {
  it("shows help with --help", () => {
    const out = run("run --help");
    expect(out).toContain("Execute a single gene");
    expect(out).toContain("--input");
  });

  it("fails when not in a project", () => {
    const out = tryRun("run nonexistent-gene", "/tmp");
    expect(out).toMatch(/not.*rotifer project|not found|error/i);
  });
});

describe("rotifer versions", () => {
  it("shows help with --help", () => {
    const out = run("versions --help");
    expect(out).toContain("owner");
    expect(out).toContain("version history");
  });

  it("handles nonexistent owner/name gracefully", () => {
    const out = tryRun("versions nobody nonexistent-gene-xyz");
    expect(out).toMatch(/no.*version|0 version|error/i);
  });
});
