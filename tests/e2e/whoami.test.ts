import { execSync } from "node:child_process";
import { describe, it, expect } from "vitest";

const CLI = "node dist/index.js";
const run = (cmd: string) =>
  execSync(`${CLI} ${cmd}`, {
    cwd: __dirname + "/../..",
    encoding: "utf-8",
    timeout: 15000,
    env: { ...process.env, HOME: "/tmp/rotifer-test-home" },
  });

describe("rotifer whoami", () => {
  it("shows help with --help", () => {
    const out = run("whoami --help");
    expect(out).toContain("authentication status");
  });

  it("shows not-logged-in when no credentials", () => {
    const out = run("whoami");
    expect(out).toMatch(/not logged in/i);
  });
});
