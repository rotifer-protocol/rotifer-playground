// ============================================================
// A.7 — network CLI E2E tests for v0.9 (real libp2p backend).
// ============================================================
//
// The v0.5 stub-era CLI tests live in `network.test.ts` and verify the
// placeholder behaviour ("not yet available" messages). Those stay green to
// preserve backward compatibility.
//
// This file (`network-v09.test.ts`) targets the **real** v0.9 implementation
// (libp2p Swarm + Ed25519 identity + ADR-190 display system). All assertions
// here are expected to **fail** during stage 1 — the CLI still routes to the
// stub and only prints "not yet available". Stage 2 swaps the CLI to the real
// libp2p-backed backend and these tests turn green.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `rotifer-net-v09-test-${Date.now()}`);
const CLI = join(__dirname, "..", "..", "dist", "index.js");

interface RunResult {
  stdout: string;
  exitCode: number;
}

function run(args: string, opts: { cwd?: string; env?: Record<string, string> } = {}): RunResult {
  try {
    const stdout = execSync(`node "${CLI}" ${args}`, {
      cwd: opts.cwd ?? TEST_DIR,
      env: { ...process.env, HOME: TEST_DIR, ...(opts.env ?? {}) },
      timeout: 30_000,
      encoding: "utf-8",
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? "") + (err.stderr ?? ""),
      exitCode: err.status ?? 1,
    };
  }
}

// Stage 1 TDD baseline — skipped in CI. Stage 2 removes `.skip` once the CLI
// switches to the real libp2p backend; running locally use `vitest --reporter=verbose`
// and remove `.skip` to observe the red baseline.
describe.skip("A.7 — rotifer network (v0.9 real libp2p backend)", () => {
  beforeAll(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Reset config between tests so each starts from a clean slate.
    const dotRotifer = join(TEST_DIR, ".rotifer");
    if (existsSync(dotRotifer)) rmSync(dotRotifer, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  // A.7.1 — `network start` connects + prints real libp2p PeerId
  // ---------------------------------------------------------------
  it("A.7.1 — `network start` connects bootstrap and prints a real PeerId", () => {
    const result = run("network start");
    expect(result.exitCode).toBe(0);
    // Real libp2p PeerIds begin with `12D3KooW` (Ed25519 multihash prefix).
    expect(result.stdout).toMatch(/PeerId:\s+12D3KooW[A-Za-z0-9]+/);
    expect(result.stdout).toContain("Listening on");
    expect(result.stdout).not.toContain("not yet available");
  });

  it("A.7.1 — `network start --port` listens on the requested port", () => {
    const result = run("network start --port 9888");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Listening on\s+\/.*\/9888/);
  });

  it("A.7.1 — duplicate `network start` on busy port surfaces a friendly error", () => {
    run("network start --port 9889");
    const result = run("network start --port 9889");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/already in use|address in use|port.*busy/i);
  });

  // ---------------------------------------------------------------
  // A.7.2 — `network peers` lists ≥1 peer once active
  // ---------------------------------------------------------------
  it("A.7.2 — `network peers` shows ≥1 peer including a bootstrap entry", () => {
    // Bootstrap peers are supplied explicitly: there is no default any more.
    // The old `/dns4/bootstrap.rotifer.dev` default never resolved (NXDOMAIN)
    // and `/dns4/` needs a DNS transport this build omits, so asserting on it
    // tested a placeholder. Use an `/ip4/` address, which is what a real
    // deployment will use, and which also covers the `-b` flag.
    const bootstrap = "/ip4/127.0.0.1/tcp/9878";
    run(`network start -b ${bootstrap}`);
    const result = run("network peers");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(bootstrap);
    expect(result.stdout).toMatch(/\d+ peer/i);
    // ADR-190 display system: peers must be rendered as a table.
    expect(result.stdout).toMatch(/PeerId.+Address|Address.+PeerId/);
  });

  // ---------------------------------------------------------------
  // A.7.3 — `network search` hybrid (Cloud + P2P) merge
  // ---------------------------------------------------------------
  it("A.7.3 — `network search` returns a hybrid Cloud+P2P result set", () => {
    run("network start");
    const result = run('network search "math sort"');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Cloud:\s+\d+ result/i);
    expect(result.stdout).toMatch(/P2P:\s+\d+ result/i);
  });

  // ---------------------------------------------------------------
  // A.7.4 — `network announce` triggers GossipSub publish
  // ---------------------------------------------------------------
  it("A.7.4 — `network announce <gene>` triggers GossipSub publish", () => {
    run("network start");
    const result = run("network announce hello@1.0.0");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Broadcast.*hello@1\.0\.0|Announcement published/i);
    expect(result.stdout).toContain("/rotifer/gene/announce/1.0.0");
  });

  it("A.7.4 — `network announce` on a non-existent gene errors gracefully", () => {
    run("network start");
    const result = run("network announce does-not-exist-gene");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toMatch(/not found|unknown gene/i);
  });

  // ---------------------------------------------------------------
  // A.7.5 — `network stop` releases the port
  // ---------------------------------------------------------------
  it("A.7.5 — `network stop` releases the port for a subsequent start", () => {
    run("network start --port 9890");
    const stop = run("network stop");
    expect(stop.exitCode).toBe(0);
    const restart = run("network start --port 9890");
    expect(restart.exitCode).toBe(0);
    expect(restart.stdout).toMatch(/Listening on\s+\/.*\/9890/);
  });

  // ---------------------------------------------------------------
  // A.7.6 — CLI output conforms to ADR-190 design system
  // ---------------------------------------------------------------
  it("A.7.6 — `network status` output uses ADR-190 key/value + table layout", () => {
    run("network start");
    const result = run("network status");
    expect(result.exitCode).toBe(0);
    // ADR-190 key/value style: aligned colon-separated fields.
    expect(result.stdout).toMatch(/Node ID\s*:/);
    expect(result.stdout).toMatch(/Listen Port\s*:/);
    expect(result.stdout).toMatch(/Bootstrap Peers\s*:/);
    // ADR-190 should not raw-print plain JSON to stdout.
    expect(result.stdout).not.toMatch(/^\{/m);
  });

  // ---------------------------------------------------------------
  // A.7.7 — identity.pem permissions are 0600 on POSIX
  // ---------------------------------------------------------------
  const isWindows = process.platform === "win32";
  it.skipIf(isWindows)("A.7.7 — identity.pem is created with mode 0600", () => {
    run("network start");
    const identityPath = join(TEST_DIR, ".rotifer", "identity.pem");
    expect(existsSync(identityPath)).toBe(true);
    const mode = statSync(identityPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // ---------------------------------------------------------------
  // A.7.8 — Corrupted network.json recovers without panicking
  // ---------------------------------------------------------------
  it("A.7.8 — corrupted network.json triggers regeneration, not a crash", () => {
    run("network start");
    const cfg = join(TEST_DIR, ".rotifer", "network.json");
    expect(existsSync(cfg)).toBe(true);
    writeFileSync(cfg, "{ this is not valid json", "utf-8");

    const result = run("network start");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/regenerated|reset|invalid.*config/i);

    const restored = JSON.parse(readFileSync(cfg, "utf-8"));
    expect(restored.enabled).toBe(true);
  });
});
