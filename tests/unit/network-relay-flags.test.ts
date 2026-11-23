/**
 * The relay and connection-limit flags of `network start` / `__daemon`, and
 * what `network status --json` keeps (T-231 B2 design §8 PR-②, §4.2). Real
 * processes are in tests/e2e/network-relay-cli.test.ts; these pin the parts
 * that need no native addon.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Command } from "commander";

vi.mock("../../src/utils/display.js", () => ({
  header: vi.fn(),
  kv: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  hint: vi.fn(),
}));
vi.mock("../../src/utils/p2p-daemon.js", () => ({
  controlRequest: vi.fn(),
  isDaemonRunning: vi.fn(),
  readDaemonState: vi.fn(),
  runDaemon: vi.fn(),
}));

import { daemonArgs, networkCommand, nodeOptionsFrom, statusJson, STATUS_JSON_FIELDS } from "../../src/commands/network.js";
import { controlRequest, runDaemon } from "../../src/utils/p2p-daemon.js";

const RELAY = "/ip4/203.0.113.7/tcp/9878/p2p/12D3KooWRelay";

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe("nodeOptionsFrom", () => {
  it("maps each flag and leaves unset ones out", () => {
    expect(nodeOptionsFrom({})).toEqual({});
    expect(
      nodeOptionsFrom({
        relay: [RELAY],
        relayServer: true,
        announce: ["/ip4/203.0.113.7/tcp/9878"],
        maxInbound: "500",
        maxPending: "128",
      }),
    ).toEqual({
      relays: [RELAY],
      relayServer: true,
      announce: ["/ip4/203.0.113.7/tcp/9878"],
      maxInbound: 500,
      maxPending: 128,
    });
  });

  it("refuses a limit that is not a whole number of 1 or more", () => {
    for (const bad of ["0", "-1", "1.5", "12abc", "", "99999999999"]) {
      expect(nodeOptionsFrom({ maxPending: bad })).toEqual({ error: expect.stringContaining("--max-pending") });
    }
    expect(nodeOptionsFrom({ maxInbound: "x" })).toEqual({ error: expect.stringContaining("--max-inbound") });
  });
});

describe("daemonArgs with node options", () => {
  it("passes every setting on to __daemon", () => {
    expect(
      daemonArgs("0.0.0.0", 9878, [], false, {
        relays: [RELAY],
        relayServer: true,
        announce: ["/ip4/203.0.113.7/tcp/9878"],
        maxInbound: 500,
        maxPending: 128,
      }),
    ).toEqual([
      "network", "__daemon", "--host", "0.0.0.0", "--port", "9878", "--no-mdns",
      "--relay", RELAY, "--relay-server", "--announce", "/ip4/203.0.113.7/tcp/9878",
      "--max-inbound", "500", "--max-pending", "128",
    ]);
  });

  it("round-trips through __daemon into runDaemon", async () => {
    const args = daemonArgs("127.0.0.1", 0, [], false, { relays: [RELAY], relayServer: true, maxPending: 128 });
    await networkCommand.parseAsync(args.slice(1), { from: "user" });
    expect(runDaemon).toHaveBeenCalledWith("127.0.0.1", 0, [], false, {
      node: { relays: [RELAY], relayServer: true, maxPending: 128 },
    });
  });
});

describe("statusJson", () => {
  it("keeps design §4.2's fields and drops the own PeerId and listen addresses", () => {
    const body: Record<string, unknown> = {
      peerId: "12D3KooWSelf",
      listenAddrs: ["/ip4/10.0.0.2/tcp/9878"],
      peers: 3,
      startedAt: 1,
    };
    for (const f of STATUS_JSON_FIELDS) body[f] = { from: f };
    const json = statusJson(body);
    expect(Object.keys(json).sort()).toEqual(["running", ...STATUS_JSON_FIELDS].sort());
    expect(json.running).toBe(true);
    expect(json.relay).toEqual({ from: "relay" });
  });

  it("leaves out what an older daemon does not report", () => {
    expect(statusJson({ peerId: "p", colocation: { maxPeersOnOneIp: 1 } })).toEqual({
      running: true,
      colocation: { maxPeersOnOneIp: 1 },
    });
  });
});

/** The CLI's root command carries the global `--json` (src/index.ts); mirror it. */
const root = new Command("rotifer").option("--json").addCommand(networkCommand);

describe("network status --json", () => {
  it("prints running: false and fails when no daemon answers", async () => {
    vi.mocked(controlRequest).mockResolvedValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await root.parseAsync(["network", "status", "--json"], { from: "user" });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ running: false }));
    expect(process.exitCode).toBe(1);
    log.mockRestore();
  });

  it("asks the daemon named by --state-file", async () => {
    vi.mocked(controlRequest).mockResolvedValue(null);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await root.parseAsync(["network", "status", "--json", "--state-file", "/var/lib/rotifer/.rotifer/daemon.json"], {
      from: "user",
    });
    expect(controlRequest).toHaveBeenCalledWith("GET", "/status", undefined, undefined, "/var/lib/rotifer/.rotifer/daemon.json");
    log.mockRestore();
  });
});
