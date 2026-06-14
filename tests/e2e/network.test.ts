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

// `network start` / `announce` drive the real libp2p node through the native
// napi addon. In CI the installed platform package predates that addon (it is
// rebuilt + republished at release time), so these commands degrade gracefully
// to an "unavailable" notice — which is what these E2E checks assert. The real
// node path is covered by the Rust two-node integration tests + manual runs.
describe("rotifer network commands", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("network --help lists all subcommands", () => {
    const result = run("network --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status");
    expect(result.stdout).toContain("start");
    expect(result.stdout).toContain("stop");
    expect(result.stdout).toContain("peers");
    expect(result.stdout).toContain("search");
    expect(result.stdout).toContain("announce");
  });

  it("network status shows node info with inactive state", () => {
    const result = run("network status");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Node ID");
    expect(result.stdout).toContain("Inactive");
    expect(result.stdout).toContain("Listen Port");
    expect(result.stdout).toContain("Bootstrap Peers");
    expect(result.stdout).toContain("rotifer network start");
  });

  it("network status generates a stable node ID across calls", () => {
    const r1 = run("network status");
    const r2 = run("network status");
    const extractId = (out: string) => {
      const match = out.match(/Node ID[:\s]+([0-9a-f-]+)/i);
      return match?.[1]?.trim();
    };
    const id1 = extractId(r1.stdout);
    const id2 = extractId(r2.stdout);
    expect(id1).toBeDefined();
    expect(id1).toBe(id2);
  });

  it("network start degrades gracefully without the native addon", () => {
    // The CI-installed platform package predates the P2P addon, so start
    // reports it is unavailable and returns cleanly (no hang, no crash).
    const result = run("network start");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Starting P2P Node");
    expect(result.stdout.toLowerCase()).toContain("unavailable");
  });

  it("network stop sets enabled to false", () => {
    const result = run("network stop");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("P2P node stopped");

    const configPath = join(TEST_DIR, ".rotifer", "network.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.enabled).toBe(false);
  });

  it("network peers warns when node is inactive", () => {
    run("network stop");
    const result = run("network peers");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not active");
    expect(result.stdout).toContain("rotifer network start");
  });

  it("network search shows fallback message when node is inactive", () => {
    run("network stop");
    const result = run("network search test-query");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not active");
    expect(result.stdout).toContain("P2P search is unavailable");
    expect(result.stdout).toContain("rotifer search");
  });

  it("network announce errors on a missing gene", () => {
    const result = run("network announce no-such-gene");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not found");
  });

  it("network announce degrades gracefully without the native addon", () => {
    // A real local gene exists, but the CI platform package lacks the addon,
    // so announce reports unavailable rather than crashing.
    const geneDir = join(TEST_DIR, "genes", "e2e-net-gene");
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ name: "e2e-net-gene", domain: "test", version: "0.1.0", fidelity: "Native" })
    );
    const result = run("network announce e2e-net-gene");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("unavailable");
  });
});
