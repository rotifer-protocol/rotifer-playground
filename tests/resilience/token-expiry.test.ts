import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, cwd: string, env?: Record<string, string>): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0", ...env },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe("Resilience: token expiry", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `rotifer-res-token-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("publish without login gives clear auth error", () => {
    const projDir = join(testDir, "proj");
    mkdirSync(join(projDir, "genes", "test-gene"), { recursive: true });
    writeFileSync(join(projDir, "rotifer.json"), JSON.stringify({
      name: "test", version: "0.1.0", author: "test", genes_dir: "genes",
    }));
    writeFileSync(join(projDir, "genes", "test-gene", "phenotype.json"), JSON.stringify({
      name: "test-gene", version: "0.1.0",
      inputSchema: { type: "object" }, outputSchema: { type: "object" },
    }));

    const fakeHome = join(testDir, "fakehome");
    mkdirSync(fakeHome, { recursive: true });

    const result = run("publish test-gene", projDir, { HOME: fakeHome });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/not logged in|login|auth/i);
  });

  it("reputation --mine without login gives clear auth error", () => {
    // Its two siblings pass an isolated HOME and this one did not, so the
    // assertion below only held while the machine happened to be signed out:
    // it passed alone and failed inside a full run on 2026-08-18.
    const fakeHome = join(testDir, "fakehome3");
    mkdirSync(fakeHome, { recursive: true });

    const result = run("reputation --mine", testDir, { HOME: fakeHome });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/not logged in|login|auth/i);
  });

  it("whoami without credentials shows unauthenticated", () => {
    const fakeHome = join(testDir, "fakehome2");
    mkdirSync(fakeHome, { recursive: true });
    const result = run("whoami", testDir, { HOME: fakeHome });
    expect(result.stdout.toLowerCase()).toMatch(/not logged|unauthenticated|no credentials/i);
  });
});
