/**
 * `/status` same-IP counters on real daemons (A6 design v3 §3.4).
 *
 * `colocation` carries rotifer-core's cumulative counters: distinct IPs ever
 * over P6's threshold, the most peers ever seen on one IP, and IPs over the
 * threshold with a registered peer. Two daemons on 127.0.0.1 cannot reach the
 * threshold (over 10 peers on one IP), so this checks the one counter they
 * can move: A's most-peers-on-one-IP goes 0 → 1 when B connects and stays 1
 * after B leaves. A constant, or a reading of the current connection count,
 * turns this test red. Rust tests (`attack_a6`, `colocation_tests`) cover
 * the threshold counters.
 *
 * The daemons need a native addon with `colocationStats`; an older one is
 * skipped and says so. `ROTIFER_E2E_CLI` points it at another CLI build.
 */
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const CLI = process.env.ROTIFER_E2E_CLI ?? join(__dirname, "..", "..", "dist", "index.js");
const ROOT = mkdtempSync(join(tmpdir(), "rotifer-status-colocation-"));

interface Colocation {
  ipsOverThreshold: number;
  maxPeersOnOneIp: number;
  ipsOverThresholdWithRegisteredPeer: number;
}

interface Status {
  peerId: string;
  listenAddrs: string[];
  connectedPeers?: number;
  colocation?: Colocation;
}

function cli(home: string, ...args: string[]): string {
  try {
    return execFileSync("node", [CLI, ...args], {
      env: { ...process.env, HOME: home, ROTIFER_CLOUD_ENDPOINT: "http://127.0.0.1:9" },
      timeout: 20_000,
      encoding: "utf-8",
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

async function status(home: string): Promise<Status> {
  const state = JSON.parse(readFileSync(join(home, ".rotifer", "daemon.json"), "utf-8")) as {
    port: number;
    token: string;
  };
  const res = await fetch(`http://127.0.0.1:${state.port}/status`, {
    headers: { "x-rotifer-token": state.token },
  });
  return (await res.json()) as Status;
}

async function until(secs: number, check: () => Promise<boolean>): Promise<boolean> {
  for (const end = Date.now() + secs * 1000; Date.now() < end; ) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function addonHasColocationStats(): boolean {
  const binding = pathToFileURL(join(dirname(CLI), "utils", "binding.js")).href;
  const probe = [
    `const { loadP2pNode } = await import(${JSON.stringify(binding)});`,
    `const node = loadP2pNode("127.0.0.1", 0, [], false);`,
    `console.log(typeof node?.colocationStats === "function" ? "yes" : "no");`,
    `process.exit(0);`,
  ].join("\n");
  try {
    const out = execFileSync("node", ["--input-type=module", "-e", probe], {
      env: { ...process.env, HOME: join(ROOT, "probe") },
      timeout: 20_000,
      encoding: "utf-8",
    });
    return out.trim().endsWith("yes");
  } catch {
    return false;
  }
}

const HAS_COLOCATION = addonHasColocationStats();
if (!HAS_COLOCATION) console.warn("skipped: no native addon, or it predates colocationStats");

const homeA = join(ROOT, "a");
const homeB = join(ROOT, "b");
const NONE: Colocation = { ipsOverThreshold: 0, maxPeersOnOneIp: 0, ipsOverThresholdWithRegisteredPeer: 0 };
const ONE: Colocation = { ...NONE, maxPeersOnOneIp: 1 };

describe("network /status same-IP counters on real daemons", () => {
  afterAll(() => {
    cli(homeA, "network", "stop");
    cli(homeB, "network", "stop");
    rmSync(ROOT, { recursive: true, force: true });
  });

  it.skipIf(!HAS_COLOCATION)("reads rotifer-core's cumulative counters, not the live connections", async () => {
    cli(homeA, "network", "start", "--port", "0", "--no-mdns");
    const a = await status(homeA);
    expect(a.colocation).toEqual(NONE);

    const addr = `${a.listenAddrs.find((x) => x.startsWith("/ip4/127.0.0.1/"))}/p2p/${a.peerId}`;
    cli(homeB, "network", "start", "--port", "0", "--no-mdns", "--bootstrap", addr);
    expect(await until(15, async () => (await status(homeA)).colocation?.maxPeersOnOneIp === 1)).toBe(true);
    expect((await status(homeA)).colocation).toEqual(ONE);

    cli(homeB, "network", "stop");
    const gone = await until(15, async () => (await status(homeA)).connectedPeers === 0);
    const after = await status(homeA);
    expect(gone, JSON.stringify(after)).toBe(true);
    expect(after.colocation).toEqual(ONE);
  }, 60_000);
});
