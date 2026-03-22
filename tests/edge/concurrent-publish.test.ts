import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
  testDir = join(tmpdir(), `rotifer-edge-conc-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Edge: concurrent operations", () => {
  it("two init commands to same name — second should fail", () => {
    run("init my-proj --no-genesis", testDir);
    const result = run("init my-proj --no-genesis", testDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/already exists/i);
  });

  it("rotifer.json is not corrupted after rapid sequential writes", () => {
    const projDir = join(testDir, "rapid");
    run("init rapid --no-genesis", testDir);

    const config = JSON.parse(readFileSync(join(projDir, "rotifer.json"), "utf-8"));
    expect(config.name).toBe("rapid");
    expect(config.version).toBe("0.1.0");
  });

  it("scan after init returns valid output", () => {
    run("init scanproj --no-genesis", testDir);
    const projDir = join(testDir, "scanproj");
    const result = run("scan", projDir);
    expect(result.exitCode).toBe(0);
  });
});
