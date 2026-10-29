/**
 * A malformed rotifer.json is reported, not crashed on (#456).
 *
 * loadConfig parsed the file with a bare JSON.parse, so `rotifer list` in a
 * workspace whose rotifer.json is not JSON ended in an uncaught SyntaxError:
 * a Node stack through Commander internals and absolute install paths.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      timeout: 15_000,
      env: { ...process.env, FORCE_COLOR: "0", ROTIFER_TELEMETRY: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

const VALID = JSON.stringify({ name: "cfg", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" });

describe("malformed rotifer.json (#456)", () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), "rotifer-config-" + randomUUID());
    mkdirSync(join(dir, "genes"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the file and the parse error, without a stack, and leaves the file alone", () => {
    writeFileSync(join(dir, "rotifer.json"), "{broken\n");
    const result = run("list", dir);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("rotifer.json");
    expect(result.stdout).toContain("not valid JSON");
    expect(result.stdout).not.toMatch(/\n\s+at /);
    expect(readFileSync(join(dir, "rotifer.json"), "utf-8")).toBe("{broken\n");
  });

  it("works again once the file is valid", () => {
    writeFileSync(join(dir, "rotifer.json"), VALID);
    expect(run("list", dir).exitCode).toBe(0);
  });
});
