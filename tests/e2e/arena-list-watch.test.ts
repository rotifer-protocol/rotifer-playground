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

function makeProject(): string {
  const dir = join(tmpdir(), "rotifer-arena-" + randomUUID());
  mkdirSync(join(dir, "genes", "test-gene"), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "arena-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    })
  );
  writeFileSync(
    join(dir, "genes", "test-gene", "phenotype.json"),
    JSON.stringify({
      name: "test-gene",
      domain: "search.web",
      fidelity: "Wrapped",
      version: "0.1.0",
    })
  );
  return dir;
}

let projectDir: string;

beforeEach(() => {
  projectDir = makeProject();
});

afterEach(() => {
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

describe("rotifer arena list / watch", () => {
  it("arena list shows local rankings with genes", () => {
    const result = run("arena list", projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Local Arena Rankings");
    expect(result.stdout).toContain("test-gene");
  });

  it("arena list with non-matching domain shows empty", () => {
    const result = run("arena list --domain nonexistent.domain", projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No genes in Arena");
  });

  it("arena watch --help shows description", () => {
    const result = run("arena watch --help", projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/watch|monitor|arena/);
  });
});
