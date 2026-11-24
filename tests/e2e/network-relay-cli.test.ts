/**
 * Relay server, relay clients and `/status` on real CLI processes over
 * loopback (T-231 B2 design §8.1 PR-②, items 1, 2, 4 and 5; item 3 is the
 * other `network-status-*` E2E tests, unchanged).
 *
 * R is `network start --foreground --relay-server --announce` (loopback
 * announce allowed by the test-only environment variable). A and B are
 * background daemons with `--relay R`; B also dials A through R
 * (`R/p2p-circuit/p2p/A`), so the circuit goes through R's relay code.
 *
 * The daemons need a native addon with `networkStats` (T-231 PR-②). An older
 * one is skipped and says so; with ROTIFER_REQUIRE_NATIVE_P2P=1 it fails
 * instead, and so it does with ROTIFER_REQUIRE_NATIVE_MEMORY=1, which CI's
 * "freshly built napi" step sets for every test it runs. `ROTIFER_E2E_CLI`
 * points it at another CLI build.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { grantP2pConsent } from "../helpers/p2p-consent.js";

const CLI = process.env.ROTIFER_E2E_CLI ?? join(__dirname, "..", "..", "dist", "index.js");
const ROOT = mkdtempSync(join(tmpdir(), "rotifer-relay-cli-"));
const VERSION = (JSON.parse(readFileSync(join(dirname(CLI), "..", "package.json"), "utf-8")) as { version: string })
  .version;

/** The update check would write a cache under HOME; servers and these tests turn it off. */
const BASE_ENV = { ...process.env, ROTIFER_CLOUD_ENDPOINT: "http://127.0.0.1:9", ROTIFER_NO_UPDATE_CHECK: "1" };

/** Design §4.2's fields, which `status --json` prints (plus `running`). */
const JSON_FIELDS = [
  "version", "roles", "announcedAddrs", "eventLoop", "connections", "limits", "denials",
  "foreignPeersDropped", "colocation", "nat", "relay", "gossip", "dht",
];

interface Status {
  peerId: string;
  listenAddrs: string[];
  connectedPeers?: number;
  version?: string;
  roles?: { relayServer: boolean };
  announcedAddrs?: string[];
  eventLoop?: { lastTickAt: number | null; running: boolean };
  limits?: { inbound: number; outbound: number; pending: number };
  nat?: { relayReservations: number };
  relay?: { advertising: boolean; reservationsAccepted: number; reservationsActive: number; circuitsAccepted: number };
}

function cli(home: string, args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = spawnSync("node", [CLI, ...args], {
    env: { ...BASE_ENV, HOME: home, ...env },
    timeout: 25_000,
    encoding: "utf-8",
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function stateFile(home: string): string {
  return join(home, ".rotifer", "daemon.json");
}

async function status(home: string): Promise<Status> {
  const state = JSON.parse(readFileSync(stateFile(home), "utf-8")) as { port: number; token: string };
  const res = await fetch(`http://127.0.0.1:${state.port}/status`, { headers: { "x-rotifer-token": state.token } });
  return (await res.json()) as Status;
}

async function until(secs: number, check: () => Promise<boolean> | boolean): Promise<boolean> {
  for (const end = Date.now() + secs * 1000; Date.now() < end; ) {
    try {
      if (await check()) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** `network start --foreground …` as a child process, with its output kept. */
function foreground(home: string, args: string[], env: Record<string, string> = {}): { child: ChildProcess; log: () => string } {
  let log = "";
  const child = spawn("node", [CLI, "network", "start", "--foreground", "--no-mdns", ...args], {
    env: { ...BASE_ENV, HOME: home, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => (log += String(d)));
  child.stderr?.on("data", (d) => (log += String(d)));
  return { child, log: () => log };
}

function exited(child: ChildProcess, secs: number): Promise<number | null | "running"> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("running"), secs * 1000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

/** Names and modification times of everything under `dir` (empty when it does not exist). */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      out.push(`${p} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  out.push(`${dir} ${statSync(dir).mtimeMs}`);
  walk(dir);
  return out;
}

/** Every string anywhere in `v`, with the path to it. */
function strings(v: unknown, path = "$"): [string, string][] {
  if (typeof v === "string") return [[path, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => strings(x, `${path}.${k}`));
  return [];
}

function keys(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap(keys);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]);
  return [];
}

function addonHasNetworkStats(): boolean {
  const binding = pathToFileURL(join(dirname(CLI), "utils", "binding.js")).href;
  const probe = [
    `const { loadP2pNode } = await import(${JSON.stringify(binding)});`,
    `const node = loadP2pNode("127.0.0.1", 0, [], false);`,
    `console.log(typeof node?.networkStats === "function" ? "yes" : "no");`,
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

const HAS_STATS = addonHasNetworkStats();
if (!HAS_STATS) {
  const required =
    process.env.ROTIFER_REQUIRE_NATIVE_P2P === "1" || process.env.ROTIFER_REQUIRE_NATIVE_MEMORY === "1";
  if (required) throw new Error("the native addon lacks networkStats (T-231 PR-②)");
  console.warn("skipped: no native addon, or it predates networkStats");
}

const homeR = join(ROOT, "r");
const homeA = join(ROOT, "a");
const homeB = join(ROOT, "b");
let relay: ReturnType<typeof foreground> | null = null;
let announced = "";
let relayAddr = "";

describe.skipIf(!HAS_STATS)("relay server, relay clients and /status on real CLI processes", () => {
  beforeAll(async () => {
    // T-237: every daemon here needs a consent record.
    for (const home of [homeR, homeA, homeB]) grantP2pConsent(home);
    const port = await freePort();
    announced = `/ip4/127.0.0.1/tcp/${port}`;
    relay = foreground(
      homeR,
      ["--port", String(port), "--relay-server", "--announce", announced, "--max-inbound", "77", "--max-pending", "33"],
      { ROTIFER_TEST_ALLOW_LOOPBACK_ANNOUNCE: "1" },
    );
    const up = await until(20, async () => (await status(homeR)).peerId.length > 0);
    expect(up, relay.log()).toBe(true);
    relayAddr = `${announced}/p2p/${(await status(homeR)).peerId}`;
  }, 40_000);

  afterAll(async () => {
    cli(homeA, ["network", "stop"]);
    cli(homeB, ["network", "stop"]);
    if (relay && relay.child.exitCode === null) {
      relay.child.kill("SIGTERM");
      await exited(relay.child, 10);
    }
    rmSync(ROOT, { recursive: true, force: true });
  }, 40_000);

  it("item 1: two --relay clients hold reservations on the --relay-server node and reach each other through it", async () => {
    const r0 = await status(homeR);
    expect(r0.roles).toEqual({ relayServer: true });
    expect(r0.announcedAddrs).toEqual([announced]);
    expect(await until(10, async () => (await status(homeR)).relay?.advertising === true)).toBe(true);

    expect(cli(homeA, ["network", "start", "--port", "0", "--no-mdns", "--relay", relayAddr]).code).toBe(0);
    const a = await status(homeA);
    expect(
      await until(20, async () => (await status(homeA)).nat?.relayReservations === 1),
      JSON.stringify((await status(homeA)).nat),
    ).toBe(true);

    // B reaches A only by A's circuit address on R.
    const viaRelay = `${relayAddr}/p2p-circuit/p2p/${a.peerId}`;
    expect(cli(homeB, ["network", "start", "--port", "0", "--no-mdns", "--relay", relayAddr, "--bootstrap", viaRelay]).code).toBe(0);
    expect(await until(20, async () => (await status(homeB)).nat?.relayReservations === 1)).toBe(true);
    expect(
      await until(20, async () => ((await status(homeR)).relay?.circuitsAccepted ?? 0) >= 1),
      JSON.stringify((await status(homeR)).relay),
    ).toBe(true);
    // A is connected to R and to B.
    expect(await until(20, async () => ((await status(homeA)).connectedPeers ?? 0) >= 2)).toBe(true);

    const r = await status(homeR);
    expect(r.relay?.reservationsAccepted).toBeGreaterThanOrEqual(2);
    expect(r.relay?.reservationsActive).toBeGreaterThanOrEqual(2);
  }, 90_000);

  it("item 2: status --json holds design §4.2's fields, and no address but the announced one, no PeerId, no score", async () => {
    const { code, out } = cli(homeR, ["network", "status", "--json"]);
    expect(code, out).toBe(0);
    const json = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(["running", ...JSON_FIELDS].sort());
    expect(json.running).toBe(true);
    expect(json.version).toBe(VERSION);
    expect(json.limits).toEqual({ inbound: 77, outbound: 50, pending: 33 });
    expect((json.nat as { relayReservations: unknown }).relayReservations).toBeTypeOf("number");
    expect((json.relay as Record<string, unknown>).circuitsDeniedGlobalSources).toBeTypeOf("number");

    // The reverse: only announcedAddrs may hold an IP; nothing looks like a PeerId; no score.
    const ip = /\b\d{1,3}(\.\d{1,3}){3}\b|:[0-9a-f]*:/i;
    const peerId = /\b(12D3Koo[1-9A-HJ-NP-Za-km-z]{40,}|Qm[1-9A-HJ-NP-Za-km-z]{44})\b/;
    const withIp = strings(json).filter(([path, v]) => ip.test(v) && !path.startsWith("$.announcedAddrs"));
    expect(withIp).toEqual([]);
    expect(strings(json).filter(([, v]) => peerId.test(v))).toEqual([]);
    expect(keys(json).filter((k) => /score|peerid|peers$|listenaddrs/i.test(k))).toEqual([]);
  }, 30_000);

  it("the event loop stamps lastTickAt each second while it runs", async () => {
    const t1 = (await status(homeR)).eventLoop?.lastTickAt ?? 0;
    expect(t1).toBeGreaterThan(Date.now() - 5_000);
    await new Promise((r) => setTimeout(r, 2_500));
    const t2 = (await status(homeR)).eventLoop?.lastTickAt ?? 0;
    expect(t2).toBeGreaterThan(t1);
    expect((await status(homeR)).eventLoop?.running).toBe(true);
  }, 20_000);

  it("item 4: status --json --state-file reads a service's daemon without writing anything", () => {
    const stateDir = join(homeR, ".rotifer");
    const noHome = join(ROOT, "no-such-home");
    chmodSync(stateDir, 0o500);
    try {
      const before = snapshot(stateDir);
      const { code, out } = cli(noHome, ["network", "status", "--json", "--state-file", stateFile(homeR)]);
      expect(code, out).toBe(0);
      expect((JSON.parse(out) as { running: boolean }).running).toBe(true);
      expect(snapshot(stateDir)).toEqual(before);
      expect(existsSync(noHome)).toBe(false);
    } finally {
      chmodSync(stateDir, 0o700);
    }
  }, 30_000);

  it("item 4: plain status writes no network.json either", () => {
    const home = join(ROOT, "plain");
    mkdirSync(home);
    const { code, out } = cli(home, ["network", "status"]);
    expect(code, out).toBe(0);
    expect(out).toContain("Not running");
    expect(snapshot(home)).toEqual([`${home} ${statSync(home).mtimeMs}`]);
  }, 30_000);

  it("item 5: --foreground exits non-zero when the native event loop ends", async () => {
    const home = join(ROOT, "crash");
    grantP2pConsent(home); // T-237
    const node = foreground(home, ["--port", "0"], { ROTIFER_TEST_END_EVENT_LOOP_AFTER_MS: "6000" });
    // Up and serving first, so the exit below is the watch, not a failed start.
    expect(await until(6, async () => (await status(home)).eventLoop?.running === true), node.log()).toBe(true);
    const code = await exited(node.child, 20);
    expect(code, node.log()).toBe(1);
    expect(node.log()).toContain("event loop ended");
  }, 30_000);
});
