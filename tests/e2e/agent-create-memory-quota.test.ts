/**
 * `rotifer agent create --memory-quota`.
 *
 * The deployer MUST configure a memory quota (spec §38.1): default 10 MB,
 * KB / MB / GB accepted, zero, negative and unit-less sizes refused. The
 * agent record carries the quota and the §30.2 DataPolicy the memory checks
 * against. The example in --help has to run as printed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
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
      timeout: 30000,
      env: { ...process.env, FORCE_COLOR: "0", ROTIFER_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe.runIf(existsSync(CLI))("rotifer agent create --memory-quota", () => {
  let projectDir: string;

  const agents = () =>
    readdirSync(join(projectDir, ".rotifer", "agents")).map((f) =>
      JSON.parse(readFileSync(join(projectDir, ".rotifer", "agents", f), "utf-8")),
    );

  beforeEach(() => {
    projectDir = join(tmpdir(), "rotifer-memquota-" + randomUUID());
    mkdirSync(join(projectDir, "genes", "g"), { recursive: true });
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "q", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "general" }),
    );
    writeFileSync(
      join(projectDir, "genes", "g", "phenotype.json"),
      JSON.stringify({ domain: "general", inputSchema: { type: "object" }, outputSchema: { type: "object" }, version: "0.1.0", fidelity: "Wrapped" }),
    );
  });

  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  it("defaults to 10 MB and records a DataPolicy", () => {
    const { stdout, exitCode } = run("agent create a --genes g", projectDir);
    expect(exitCode, stdout).toBe(0);
    const [agent] = agents();
    expect(agent.memoryQuota).toBe(10 * 1024 * 1024);
    expect(agent.dataPolicy).toMatchObject({
      learningDataOwnership: "AGENT",
      retentionPolicy: { maxRetentionDays: null, anonymizationSupported: false },
      deletionSupport: true,
    });
    expect(stdout).toContain("10 MB");
  });

  it.each([
    ["512KB", 512 * 1024],
    ["50MB", 50 * 1024 * 1024],
    ["1.5GB", Math.floor(1.5 * 1024 ** 3)],
    ["2mb", 2 * 1024 * 1024],
  ])("accepts --memory-quota=%s", (size, bytes) => {
    const { stdout, exitCode } = run(`agent create a --genes g --memory-quota=${size}`, projectDir);
    expect(exitCode, stdout).toBe(0);
    expect(agents()[0].memoryQuota).toBe(bytes);
  });

  it.each(["0MB", "-5MB", "10", "10TB", "lots"])("refuses --memory-quota=%s and creates nothing", (size) => {
    const { stdout, exitCode } = run(`agent create a --genes g --memory-quota=${size}`, projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toMatch(/memory quota/i);
    expect(stdout).toContain("KB, MB or GB");
    expect(existsSync(join(projectDir, ".rotifer", "agents")) ? agents() : []).toHaveLength(0);
    // Nor any memory for it in the native store.
    expect(existsSync(join(projectDir, ".rotifer", "playground.db"))).toBe(false);
  });

  it("the --help example runs as printed in a fresh workspace", () => {
    const help = run("agent create --help", projectDir).stdout;
    const example = help.split("\n").map((l) => l.trim()).find((l) => l.startsWith("$ rotifer agent create") && l.includes("--memory-quota"));
    expect(example, help).toBeDefined();

    const ws = join(tmpdir(), "rotifer-memquota-ws-" + randomUUID());
    mkdirSync(ws, { recursive: true });
    try {
      expect(run("init demo", ws).exitCode).toBe(0);
      const cwd = join(ws, "demo");
      const { stdout, exitCode } = run(example!.replace(/^\$ rotifer /, ""), cwd);
      expect(exitCode, stdout).toBe(0);
      const files = readdirSync(join(cwd, ".rotifer", "agents"));
      expect(files).toHaveLength(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);
});
