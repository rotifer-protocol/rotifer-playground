import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string[], cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args.map(a => JSON.stringify(a)).join(" ")}`, {
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

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `rotifer-sec-inject-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Security: command injection", () => {
  it("init name with pipe character does not crash CLI", () => {
    const result = run(["init", "a|b", "--no-genesis"], testDir);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("init name with semicolon does not crash CLI", () => {
    const result = run(["init", "a;b", "--no-genesis"], testDir);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("init name with angle brackets does not crash CLI", () => {
    const result = run(["init", "a>b<c", "--no-genesis"], testDir);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("search with special characters does not crash", () => {
    const result = run(["search", "'; DROP TABLE genes; --"], testDir);
    expect(result.stdout).not.toContain("TypeError");
    expect(result.stdout).not.toContain("syntax error");
  });

  it("wrap with special characters in domain does not execute shell commands", () => {
    const marker = join(testDir, "SHELL_EXECUTED");
    const projDir = join(testDir, "proj");
    mkdirSync(join(projDir, "genes", "test-gene"), { recursive: true });
    writeFileSync(join(projDir, "rotifer.json"), JSON.stringify({
      name: "test", version: "0.1.0", author: "test", genes_dir: "genes",
    }));
    writeFileSync(join(projDir, "genes", "test-gene", "phenotype.json"), JSON.stringify({
      name: "test-gene", version: "0.1.0",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
    }));
    run(["wrap", "test-gene", "--domain", "test-domain"], projDir);
    expect(existsSync(marker)).toBe(false);
  });
});
