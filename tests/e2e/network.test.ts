import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, existsSync, rmSync, readFileSync } from "node:fs";
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

  it("network start writes config and shows active status", () => {
    const result = run("network start");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Node ID");
    expect(result.stdout).toContain("gene-discovery/1.0.0");
    expect(result.stdout).toContain("P2P node initialized");
    expect(result.stdout).toContain("metadata discovery is available");

    const configPath = join(TEST_DIR, ".rotifer", "network.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.enabled).toBe(true);
    expect(config.listen_port).toBe(9878);
  });

  it("network start --port sets custom port", () => {
    const result = run("network start --port 9999");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("9999");

    const configPath = join(TEST_DIR, ".rotifer", "network.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.listen_port).toBe(9999);
  });

  it("network peers shows peers when node is active", () => {
    run("network start");
    const result = run("network peers");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bootstrap");
    expect(result.stdout).toContain("peer(s) known");
  });

  it("network stop sets enabled to false", () => {
    run("network start");
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

  it("network search with active node shows foundation message", () => {
    run("network start");
    const result = run("network search test-query");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test-query");
    expect(result.stdout).toContain("not yet available");
  });

  it("network announce warns when node is inactive", () => {
    run("network stop");
    const result = run("network announce my-gene");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("not active");
  });

  it("network announce with active node shows broadcast info", () => {
    run("network start");
    const result = run("network announce my-gene");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("my-gene");
    expect(result.stdout).toContain("not yet available");
  });
});
