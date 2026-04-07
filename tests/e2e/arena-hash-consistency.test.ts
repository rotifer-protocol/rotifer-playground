import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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

function makeProject(phenotype: Record<string, unknown>): string {
  const dir = join(tmpdir(), "rotifer-hash-" + randomUUID());
  mkdirSync(join(dir, "genes", "hash-test-gene"), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "hash-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    })
  );
  writeFileSync(
    join(dir, "genes", "hash-test-gene", "phenotype.json"),
    JSON.stringify(phenotype, null, 2)
  );
  return dir;
}

describe("arena submit ↔ arena list hash consistency", () => {
  let projectDir: string;

  afterEach(() => {
    if (projectDir && existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("Gene ID from arena submit matches Gene ID in arena list", () => {
    const phenotype = {
      domain: "test.hash",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      version: "0.1.0",
      fidelity: "Wrapped",
      name: "hash-test-gene",
    };
    projectDir = makeProject(phenotype);

    const submitResult = run("arena submit hash-test-gene", projectDir);
    expect(submitResult.exitCode).toBe(0);

    const submitIdMatch = submitResult.stdout.match(/Gene ID:\s+([0-9a-f]{12})/);
    expect(submitIdMatch).not.toBeNull();
    const submitGeneId = submitIdMatch![1];

    const submitFgMatch = submitResult.stdout.match(/F\(g\):\s+([\d.]+)/);
    expect(submitFgMatch).not.toBeNull();
    const submitFg = submitFgMatch![1];

    const listResult = run("arena list --domain test.hash", projectDir);
    expect(listResult.exitCode).toBe(0);
    expect(listResult.stdout).toContain("hash-test-gene");
    expect(listResult.stdout).toContain(submitFg);
  });

  it("F(g) is deterministic across multiple submit calls", () => {
    const phenotype = {
      domain: "determinism",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      version: "0.1.0",
      fidelity: "Wrapped",
    };
    projectDir = makeProject(phenotype);

    const run1 = run("arena submit hash-test-gene", projectDir);
    const run2 = run("arena submit hash-test-gene", projectDir);

    const fg1 = run1.stdout.match(/F\(g\):\s+([\d.]+)/)?.[1];
    const fg2 = run2.stdout.match(/F\(g\):\s+([\d.]+)/)?.[1];
    expect(fg1).toBe(fg2);
  });
});
