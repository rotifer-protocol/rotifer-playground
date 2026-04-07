import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
function run(args: string, cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

function makeProject(): string {
  const dir = join(tmpdir(), "rotifer-arena-edge-" + randomUUID());
  mkdirSync(join(dir, "genes", "test-gene"), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "arena-edge-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    })
  );
  return dir;
}

describe("arena submit edge cases", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("fails when gene does not exist", () => {
    const { stdout, exitCode } = run("arena submit nonexistent", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not found");
  });

  it("fails when phenotype.json is missing", () => {
    mkdirSync(join(projectDir, "genes", "empty-gene"), { recursive: true });
    const { stdout, exitCode } = run("arena submit empty-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not found");
  });

  it("fails when phenotype validation fails (missing fields)", () => {
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({ domain: "general" })
    );
    const { stdout, exitCode } = run("arena submit test-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("validation failed");
  });

  it("--skip-test bypasses validation", () => {
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({
        domain: "general",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        version: "0.1.0",
        fidelity: "Wrapped",
      }, null, 2)
    );
    const { stdout, exitCode } = run("arena submit test-gene --skip-test", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("submitted to Arena");
    expect(stdout).not.toContain("pre-submission");
  });

  it("Wrapped gene uses deterministic fitness estimation", () => {
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({
        domain: "general",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        version: "0.1.0",
        fidelity: "Wrapped",
      }, null, 2)
    );
    const { stdout, exitCode } = run("arena submit test-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Estimated");
    expect(stdout).toContain("Wrapped");
  });

  it("rejects genes with critical security findings", () => {
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({
        domain: "general",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        version: "0.1.0",
        fidelity: "Wrapped",
      }, null, 2)
    );
    writeFileSync(
      join(projectDir, "genes", "test-gene", "index.js"),
      "export function run() { return eval('1 + 1'); }\n",
    );

    const { stdout, exitCode } = run("arena submit test-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Security scan found issues");
    expect(stdout).toContain("V(g)");
    expect(stdout).toContain("does not meet admission threshold");
  });

  it("shows Fidelity in output", () => {
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({
        domain: "general",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        version: "0.1.0",
        fidelity: "Native",
      }, null, 2)
    );
    const { stdout, exitCode } = run("arena submit test-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Native");
  });

  it("submitted gene shows Gene ID and Domain", () => {
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({
        domain: "search",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        version: "0.1.0",
        fidelity: "Wrapped",
      }, null, 2)
    );
    const { stdout, exitCode } = run("arena submit test-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Gene ID");
    expect(stdout).toContain("search");
    expect(stdout).toContain("Admission");
    expect(stdout).toContain("PASSED");
  });

  it("suggests arena list after submission", () => {
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({
        domain: "general",
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        version: "0.1.0",
        fidelity: "Wrapped",
      }, null, 2)
    );
    const { stdout, exitCode } = run("arena submit test-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("rotifer arena list");
  });
});
