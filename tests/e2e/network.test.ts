import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `rotifer-net-test-${Date.now()}`);
const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, opts: { cwd?: string } = {}): {
  stdout: string;
  exitCode: number;
} {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd: opts.cwd || TEST_DIR,
      env: { ...process.env, HOME: TEST_DIR },
      timeout: 15_000,
      encoding: "utf-8",
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "") + (err.stderr || ""),
      exitCode: err.status ?? 1,
    };
  }
}

// These checks exercise the degraded paths, which is what a fresh environment
// hits: no daemon is running, and in CI the installed platform package predates
// the native P2P addon (rebuilt + republished at release). So `start` reports
// "unavailable" and the daemon-backed commands report "not running" — cleanly,
// no hang, no crash. The real daemon path is covered by the Rust two-node
// integration tests + manual end-to-end runs.
describe("rotifer network commands", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("network --help lists the public subcommands and hides __daemon", () => {
    const result = run("network --help");
    expect(result.exitCode).toBe(0);
    for (const sub of ["status", "start", "stop", "peers", "received", "search", "announce"]) {
      expect(result.stdout).toContain(sub);
    }
    expect(result.stdout).not.toContain("__daemon");
  });

  it("network status reports not-running when no daemon is up", () => {
    const result = run("network status");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Not running");
    expect(result.stdout).toContain("Listen Port");
    expect(result.stdout).toContain("Bootstrap Peers");
    expect(result.stdout).toContain("rotifer network start");
  });

  it("network status persists a stable node id in its config", () => {
    run("network status");
    const configPath = join(TEST_DIR, ".rotifer", "network.json");
    const id1 = JSON.parse(readFileSync(configPath, "utf-8")).node_id;
    run("network status");
    const id2 = JSON.parse(readFileSync(configPath, "utf-8")).node_id;
    expect(id1).toBeTruthy();
    expect(id2).toBe(id1);
  });

  it("network start degrades gracefully without the native addon", () => {
    const result = run("network start");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Starting P2P Daemon");
    expect(result.stdout.toLowerCase()).toContain("unavailable");
  });

  it("network stop reports not-running when no daemon is up", () => {
    const result = run("network stop");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("not running");
  });

  it("network peers reports not-running when no daemon is up", () => {
    const result = run("network peers");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("not running");
    expect(result.stdout).toContain("rotifer network start");
  });

  it("network received reports not-running when no daemon is up", () => {
    const result = run("network received");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("not running");
    expect(result.stdout).toContain("rotifer network start");
  });

  it("network search falls back to Cloud search when no daemon is up", () => {
    const result = run("network search test-query");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("not running");
    expect(result.stdout).toContain("not yet available");
    expect(result.stdout).toContain("rotifer search");
  });

  it("network announce errors on a missing gene", () => {
    const result = run("network announce no-such-gene");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not found");
  });

  it("network announce reports not-running when no daemon is up", () => {
    const geneDir = join(TEST_DIR, "genes", "e2e-net-gene");
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ name: "e2e-net-gene", domain: "test", version: "0.1.0", fidelity: "Native" })
    );
    const result = run("network announce e2e-net-gene");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("not running");
  });
});
