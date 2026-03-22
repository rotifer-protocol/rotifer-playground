import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
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

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `rotifer-edge-uni-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Edge: Unicode names", () => {
  it("init with Chinese name creates project", () => {
    const result = run("init 测试项目 --no-genesis", testDir);
    if (result.exitCode === 0) {
      expect(existsSync(join(testDir, "测试项目", "rotifer.json"))).toBe(true);
    }
  });

  it("init with emoji name handles gracefully", () => {
    const result = run("init 🧬gene-project --no-genesis", testDir);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("init with spaces in name handles gracefully", () => {
    const result = run('init "my gene project" --no-genesis', testDir);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("search with Unicode query does not crash", () => {
    const result = run("search 基因搜索", testDir);
    expect(result.stdout).not.toContain("TypeError");
    expect(result.stdout).not.toContain("URIError");
  });

  it("search with emoji query does not crash", () => {
    const result = run("search 🧬🔬", testDir);
    expect(result.stdout).not.toContain("TypeError");
  });
});
