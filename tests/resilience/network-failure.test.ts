import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const PROJECT_ROOT = join(__dirname, "..", "..");

// Each command may reach the network, so it gets its own budget, and the test
// gets that budget plus a margin. execSync blocks the event loop, so vitest
// only sees its own timeout once the child returns: an outer timeout below
// the inner one (vitest.config.ts testTimeout is 10 s) failed a command that
// answered in, say, 12 s, as a timeout rather than letting it be judged.
const CLI_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = CLI_TIMEOUT_MS + 5_000;

function run(args: string, cwd?: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd: cwd || PROJECT_ROOT,
      encoding: "utf-8",
      timeout: CLI_TIMEOUT_MS,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe("Resilience: graceful error handling", { timeout: TEST_TIMEOUT_MS }, () => {
  it("search with nonsense query does not crash", () => {
    const result = run("search xyzzy-nonexistent-query-9999");
    expect(result.stdout).not.toContain("TypeError");
    expect(result.stdout).not.toContain("Cannot read properties");
  });

  it("install with all-zero UUID fails gracefully", () => {
    const result = run("install 00000000-0000-0000-0000-000000000000");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("TypeError");
  });

  it("stats with nonexistent gene does not crash", () => {
    const result = run("stats 00000000-0000-0000-0000-000000000000");
    expect(result.stdout).not.toContain("TypeError");
    expect(result.stdout).not.toContain("Cannot read properties");
  });

  it("reputation with bad gene ID fails gracefully", () => {
    const result = run("reputation not-a-uuid");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("TypeError");
  });
});
