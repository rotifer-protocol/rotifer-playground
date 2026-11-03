import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hasNativeGeneIdV2 } from "../../src/utils/binding.js";

const TEST_DIR = join(tmpdir(), `rotifer-net-test-${Date.now()}`);
const CLI = join(__dirname, "..", "..", "dist", "index.js");

// Nothing here may reach the production Cloud: the endpoint is a closed
// local port unless a test starts its own stand-in.
const NO_CLOUD = "http://127.0.0.1:9";

function run(args: string, opts: { cwd?: string; cloud?: string } = {}): {
  stdout: string;
  exitCode: number;
} {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd: opts.cwd || TEST_DIR,
      env: { ...process.env, HOME: TEST_DIR, ROTIFER_CLOUD_ENDPOINT: opts.cloud ?? NO_CLOUD },
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

/**
 * A stand-in Rotifer Cloud in a child process (the CLI runs through the
 * blocking execSync, so an in-process server could not answer). Every
 * search returns `rows`.
 */
async function startCloud(rows: unknown[]): Promise<{ endpoint: string; stop: () => void }> {
  const code = `
    const rows = ${JSON.stringify(JSON.stringify(rows))};
    require("node:http").createServer((q, r) => { q.resume(); r.setHeader("content-type", "application/json"); r.end(rows); })
      .listen(0, "127.0.0.1", function () { console.log(this.address().port); });`;
  const child: ChildProcess = spawn("node", ["-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolve) => child.stdout!.once("data", (d) => resolve(String(d).trim())));
  return { endpoint: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

function cloudGene(name: string) {
  return {
    id: "11111111-1111-1111-1111-111111111111", name, domain: "test", version: "1.0.0", fidelity: "Native",
    description: null, wasm_size: 1, downloads: 0, reputation_score: null,
    created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", owner_username: "e2e", total_count: 1,
  };
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

  it("network search falls back to Cloud search when no daemon is up", async () => {
    const cloud = await startCloud([cloudGene("e2e-unique-cloud-gene")]);
    try {
      const result = run("network search test-query", { cloud: cloud.endpoint });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("e2e-unique-cloud-gene");
      expect(result.stdout).toContain("Rotifer Cloud (1)");
      expect(result.stdout).toContain("rotifer network start");
      expect(result.stdout).not.toContain("not yet available");
    } finally {
      cloud.stop();
    }
  });

  it("network search shows an empty Cloud list when Cloud has no match", async () => {
    const cloud = await startCloud([]);
    try {
      const result = run("network search test-query", { cloud: cloud.endpoint });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Rotifer Cloud (0)");
    } finally {
      cloud.stop();
    }
  });

  it("network search fails, naming both causes, with no daemon and no Cloud", () => {
    const result = run("network search test-query");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Rotifer Cloud is unreachable or returned an error");
    expect(result.stdout).toContain("the P2P daemon is not running");
  });

  it("network announce errors on a missing gene", () => {
    const result = run("network announce no-such-gene");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not found");
  });

  it("network announce refuses a gene with no v2 ID (uncompiled Native)", () => {
    const geneDir = join(TEST_DIR, "genes", "e2e-uncompiled");
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ name: "e2e-uncompiled", domain: "test", version: "0.1.0", fidelity: "Native" })
    );
    const result = run("network announce e2e-uncompiled");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("no v2 gene ID");
  });

  // Computing a v2 ID needs a native addon that has `geneIdV2` (the single
  // implementation); an older installed platform package does not.
  it.skipIf(!hasNativeGeneIdV2())("network announce reports not-running when no daemon is up", () => {
    const geneDir = join(TEST_DIR, "genes", "e2e-net-gene");
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ name: "e2e-net-gene", domain: "test", version: "0.1.0", fidelity: "Wrapped" })
    );
    writeFileSync(join(geneDir, "SKILL.md"), "# e2e net gene\n");
    const result = run("network announce e2e-net-gene");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toLowerCase()).toContain("not running");
  });
});
