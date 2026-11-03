/**
 * `/status` peer counts on real daemons (A2 design v2 §8.1, #543).
 *
 * `connectedPeers` is the open connections; `dhtPeers` the routing table,
 * which keeps a peer that went away (Kademlia never drops a peer's last
 * address, only evicts from a full bucket). So when B stops, A's connection
 * count falls to 0 and its DHT count stays 1. Reading either field from the
 * other's source turns this test red.
 *
 * `dhtPeers` and `peers` (the discovered set) agree in every state two
 * daemons can reach: they differ only after a bucket eviction (over 20 peers
 * in one bucket). Rust tests ADV-17a–c cover what keeps a peer out of both.
 *
 * The daemons need a native addon with `dhtPeers`. An older installed addon
 * (the platform package) lacks it; the test is then skipped and says so, and
 * runs by itself once a released addon has it. `ROTIFER_E2E_CLI` points it
 * at another CLI build, e.g. one whose platform package is the addon built
 * from this tree.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const CLI = process.env.ROTIFER_E2E_CLI ?? join(__dirname, "..", "..", "dist", "index.js");
const ROOT = mkdtempSync(join(tmpdir(), "rotifer-status-peers-"));

interface Status {
  peerId: string;
  listenAddrs: string[];
  peers: number;
  dhtPeers?: number;
  connectedPeers?: number;
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

/** GET `/status` from the daemon whose state lives under `home`. */
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

/**
 * Whether the CLI's native addon reports `dhtPeers`. Decided before the tests
 * are collected, so `it.skipIf` can use it: a child process loads the CLI's
 * own binding, makes a throwaway node, answers and exits.
 */
function addonHasDhtPeers(): boolean {
  const binding = pathToFileURL(join(dirname(CLI), "utils", "binding.js")).href;
  const probe = [
    `const { loadP2pNode } = await import(${JSON.stringify(binding)});`,
    `const node = loadP2pNode("127.0.0.1", 0, [], false);`,
    `console.log(typeof node?.dhtPeers === "function" ? "yes" : "no");`,
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

const HAS_DHT_PEERS = addonHasDhtPeers();
if (!HAS_DHT_PEERS) console.warn("skipped: no native addon, or it predates dhtPeers/connectedPeers");

const homeA = join(ROOT, "a");
const homeB = join(ROOT, "b");

describe("network /status peer counts on real daemons", () => {
  beforeAll(() => {
    if (HAS_DHT_PEERS) cli(homeA, "network", "start", "--port", "0", "--no-mdns");
  }, 30_000);

  afterAll(() => {
    cli(homeA, "network", "stop");
    cli(homeB, "network", "stop");
    rmSync(ROOT, { recursive: true, force: true });
  });

  it.skipIf(!HAS_DHT_PEERS)("counts a peer as connected only while it is, and keeps it in the DHT count after it leaves", async () => {
    const a = await status(homeA);
    expect(a).toMatchObject({ peers: 0, dhtPeers: 0, connectedPeers: 0 });

    const addr = `${a.listenAddrs.find((x) => x.startsWith("/ip4/127.0.0.1/"))}/p2p/${a.peerId}`;
    cli(homeB, "network", "start", "--port", "0", "--no-mdns", "--bootstrap", addr);
    expect(await until(15, async () => (await status(homeA)).dhtPeers === 1)).toBe(true);
    expect(await status(homeA)).toMatchObject({ peers: 1, dhtPeers: 1, connectedPeers: 1 });

    cli(homeB, "network", "stop");
    const settled = await until(15, async () => (await status(homeA)).connectedPeers === 0);
    const after = await status(homeA);
    expect(settled, JSON.stringify(after)).toBe(true);
    expect(after).toMatchObject({ peers: 1, dhtPeers: 1, connectedPeers: 0 });
  }, 60_000);
});
