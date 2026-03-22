import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, cwd: string, env?: Record<string, string>): { stdout: string; exitCode: number } {
  const testHome = join(tmpdir(), "rotifer-install-home-" + randomUUID());
  mkdirSync(join(testHome, ".rotifer"), { recursive: true });
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0", HOME: testHome, ...env },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  } finally {
    if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  }
}

function makeProject(): string {
  const dir = join(tmpdir(), "rotifer-install-edge-" + randomUUID());
  mkdirSync(join(dir, "genes"), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "install-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
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

describe("rotifer install edge cases", () => {
  it("shows help with correct description", () => {
    const result = run("install --help", projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Install a gene from Rotifer Cloud");
    expect(result.stdout).toContain("gene-id");
  });

  it("fails with invalid (non-UUID) gene id", () => {
    const result = run("install not-a-real-gene-id", projectDir);
    expect(result.exitCode).not.toBe(0);
  });

  it("fails when not in a rotifer project directory", () => {
    const emptyDir = join(tmpdir(), "rotifer-empty-" + randomUUID());
    mkdirSync(emptyDir, { recursive: true });
    const result = run("install some-gene-id", emptyDir);
    expect(result.exitCode).not.toBe(0);
    if (existsSync(emptyDir)) rmSync(emptyDir, { recursive: true, force: true });
  });
});
