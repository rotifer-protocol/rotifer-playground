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

const tryRun = (cmd: string) => {
  try {
    return run(cmd);
  } catch (err: any) {
    return err.stderr || err.stdout || err.message;
  }
};

describe("rotifer info", () => {
  it("shows help with --help", () => {
    const out = run("info --help");
    expect(out).toContain("<gene-ref>");
    expect(out).toContain("gene details");
  });

  it("fails gracefully with invalid gene ID", () => {
    const out = tryRun("info nonexistent-id-12345");
    expect(out).toMatch(/not found|error|failed/i);
  });
});

describe("rotifer stats", () => {
  it("shows help with --help", () => {
    const out = run("stats --help");
    expect(out).toContain("<gene-ref>");
    expect(out).toContain("download statistics");
  });

  it("fails gracefully with invalid gene ID", () => {
    const out = tryRun("stats nonexistent-id-12345");
    expect(out).toMatch(/not found|error|failed/i);
  });
});

describe("rotifer compare", () => {
  it("shows help with --help", () => {
    const out = run("compare --help");
    expect(out).toContain("genes");
    expect(out).toContain("Compare");
  });

  it("rejects fewer than 2 IDs", () => {
    const out = tryRun("compare single-id");
    expect(out).toMatch(/provide between 2 and 5 gene refs|error/i);
  });
});
