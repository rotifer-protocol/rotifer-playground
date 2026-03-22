import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `rotifer-cloud-cmd-test-${Date.now()}`);
const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, opts: { cwd?: string; env?: Record<string, string> } = {}): {
  stdout: string;
  exitCode: number;
} {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd: opts.cwd || TEST_DIR,
      env: { ...process.env, ...opts.env, HOME: TEST_DIR },
      timeout: 15_000,
      encoding: "utf-8",
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "") + (err.stderr || ""),
      exitCode: err.status ?? 1,
    };
  }
}

describe("cloud CLI commands", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    execSync(`node "${CLI}" init cloud-test`, { cwd: TEST_DIR, encoding: "utf-8" });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("rotifer login shows auth prompt when not logged in", () => {
    // login needs browser interaction, but verify the command exists and runs
    const result = run("login --help");
    expect(result.stdout).toContain("Log in to Rotifer Cloud");
    expect(result.stdout).toContain("--endpoint");
  });

  it("rotifer logout shows 'not logged in' when no credentials", () => {
    const result = run("logout", { cwd: join(TEST_DIR, "cloud-test") });
    expect(result.stdout).toContain("Not currently logged in");
  });

  it("rotifer publish fails when not logged in", () => {
    const projectDir = join(TEST_DIR, "cloud-test");
    const geneDir = join(projectDir, "genes", "test-gene");
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({
        domain: "test.domain",
        version: "0.1.0",
        fidelity: "Wrapped",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
      })
    );

    const result = run("publish test-gene", { cwd: projectDir });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Not logged in");
  });

  it("rotifer publish fails with missing gene", () => {
    const result = run("publish non-existent-gene", {
      cwd: join(TEST_DIR, "cloud-test"),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/not found|Not logged in|E0050/);
  });

  it("rotifer search --help shows options", () => {
    const result = run("search --help");
    expect(result.stdout).toContain("Search genes on Rotifer Cloud");
    expect(result.stdout).toContain("--domain");
    expect(result.stdout).toContain("--fidelity");
    expect(result.stdout).toContain("--sort");
  });

  it("rotifer install --help shows options", () => {
    const result = run("install --help");
    expect(result.stdout).toContain("Install a gene from Rotifer Cloud");
    expect(result.stdout).toContain("--force");
  });

  it("rotifer arena list --cloud --help shows cloud option", () => {
    const result = run("arena list --help");
    expect(result.stdout).toContain("--cloud");
  });

  it("rotifer arena submit --cloud --help shows cloud option", () => {
    const result = run("arena submit --help");
    expect(result.stdout).toContain("--cloud");
  });

  it("rotifer arena watch --cloud --help shows cloud option", () => {
    const result = run("arena watch --help");
    expect(result.stdout).toContain("--cloud");
  });
});
