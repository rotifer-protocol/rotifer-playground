import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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

// Most checks exercise the no-daemon paths a fresh environment hits (commands
// report "not running" cleanly). `network start` is addon-aware: with the native
// addon present (the published platform package, v0.9.0+) it brings up a real
// libp2p daemon; without it (a pure-TS build) it degrades gracefully. The afterEach
// hook stops any daemon a test started so the no-daemon assertions stay valid. The
// deep daemon/P2P path is covered by the Rust two-node integration tests.
describe("rotifer network commands", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // `network start` (with the native addon present) launches a detached daemon
    // keyed by HOME=TEST_DIR; stop it so the next test sees a clean "no daemon"
    // state — the "not running" assertions below depend on it.
    run("network stop");
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

  it("network start brings up a daemon (addon present) or degrades gracefully (no addon)", () => {
    // Custom port so this doesn't collide with the default 9878 a parallel test
    // file (or a leaked daemon) might hold. afterEach stops whatever started.
    const result = run("network start --port 19878");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Starting P2P Daemon");
    const out = result.stdout.toLowerCase();
    if (out.includes("unavailable")) {
      // No native addon (a pure-TS build): warns + exits 0 cleanly, no daemon.
      expect(out).toContain("unavailable");
    } else {
      // Native addon present (published platform package, v0.9.0+): a real libp2p
      // daemon comes up in the background.
      expect(result.stdout).toContain("PeerId");
      expect(out).toContain("running in the background");
    }
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
