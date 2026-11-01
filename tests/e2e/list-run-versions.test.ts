import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startRecordedCloud, type RecordedCloud } from "./recorded-cloud.js";

const PROJECT_ROOT = resolve(__dirname, "../..");
const CLI = `node ${resolve(PROJECT_ROOT, "dist/index.js")}`;
const HOME = mkdtempSync(join(tmpdir(), "rotifer-list-run-versions-home-"));
// `versions` reads the registry: the recorded one (tests/fixtures/cloud/).
let cloud: RecordedCloud;
const run = (cmd: string, cwd?: string) =>
  execSync(`${CLI} ${cmd}`, {
    cwd: cwd || PROJECT_ROOT,
    encoding: "utf-8",
    timeout: 15000,
    env: { ...process.env, HOME, NO_COLOR: "1", ROTIFER_CLOUD_ENDPOINT: cloud.endpoint },
  });

const tryRun = (cmd: string, cwd?: string) => {
  try {
    return run(cmd, cwd);
  } catch (err: any) {
    return err.stderr || err.stdout || err.message;
  }
};

beforeAll(async () => {
  cloud = await startRecordedCloud();
});

afterAll(async () => {
  // Stop the server first, so a failed check cannot leave it running.
  const unrecorded = await cloud.unrecorded();
  await cloud.close();
  expect(unrecorded).toEqual([]);
  rmSync(HOME, { recursive: true, force: true });
});

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
    expect(out).toMatch(/not.*rotifer agent workspace|not found|error/i);
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
    expect(out).toContain("No published versions found for nobody/nonexistent-gene-xyz");
  });

  it("shows a gene's version chain, oldest first", () => {
    const out = run("versions @fixture-owner/fixture-gene");
    expect(out).toContain("Cloud Version History: fixture-owner/fixture-gene");
    expect(out.indexOf("0.1.0")).toBeGreaterThan(-1);
    expect(out.indexOf("0.2.0")).toBeGreaterThan(out.indexOf("0.1.0"));
    expect(out).toContain("Adds a second output field");
    expect(out).toContain("← 6f1c2a40-0000-4000-8000-000000000001");
    expect(out).toContain("2 version(s) found in Rotifer Cloud");
    expect(out).toContain("Latest: 0.2.0");
  });

  it("only lists the named owner's versions", () => {
    const out = tryRun("versions @someone-else/fixture-gene");
    expect(out).toContain("No published versions found for someone-else/fixture-gene");
  });
});
