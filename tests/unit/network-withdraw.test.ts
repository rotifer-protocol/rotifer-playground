/**
 * `rotifer network withdraw` and the daemon's republish table (A2 design v2
 * §7.2–§7.3). The daemon runs for real in this process, on a fake native
 * node, so the CLI goes through the real `/withdraw` route.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  loadP2pNode: vi.fn(),
}));

const HOME = mkdtempSync(join(tmpdir(), "rotifer-net-withdraw-"));
const TABLE = join(HOME, ".rotifer", "p2p", "announced.json");
const ID_A = `v2:${"aa".repeat(32)}`;
const ID_B = `v2:${"bb".repeat(32)}`;
const ID_OLD = `v2:${"0f".repeat(32)}`;
const ROOT = "/project/genes";

const node = {
  start: vi.fn(),
  peerId: () => "12D3KooWfake",
  listenAddrs: () => [],
  discoveredPeers: () => ["12D3KooWpeer"],
  dhtPeers: () => ["12D3KooWpeer"],
  connectedPeers: () => ["12D3KooWpeer"],
  receivedAnnouncements: () => [],
  announceLocalGene: () => ID_A,
  announceLocalGeneReport: vi.fn(async (_root: string, name: string) => ({
    geneId: name === "alpha" ? ID_A : ID_B,
    gossipPeers: 1,
    recordSent: 1,
    recordAcked: 1,
    readableFrom: 1,
  })),
  republishLocalGene: vi.fn(async (_root: string, _name: string, geneId: string) => ({
    outcome: "republished",
    geneId,
    recordSent: 1,
    recordAcked: 1,
  })),
  withdrawGene: vi.fn(),
  stop: vi.fn(),
};

type Network = typeof import("../../src/commands/network.js");
type Daemon = typeof import("../../src/utils/p2p-daemon.js");
type Display = typeof import("../../src/utils/display.js");
type Table = typeof import("../../src/utils/announce-table.js");
let net: Network;
let daemon: Daemon;
let display: Display;
let table: Table;
let printed: string[];

const text = () => printed.join("\n");
const saved = () => JSON.parse(readFileSync(TABLE, "utf-8")) as { genesRoot: string; name: string; geneId: string }[];

async function withdraw(arg: string): Promise<void> {
  await net.networkCommand.parseAsync(["withdraw", arg], { from: "user" });
}

beforeAll(async () => {
  process.env.HOME = HOME;
  net = await import("../../src/commands/network.js");
  daemon = await import("../../src/utils/p2p-daemon.js");
  display = await import("../../src/utils/display.js");
  table = await import("../../src/utils/announce-table.js");
  const binding = await import("../../src/utils/binding.js");
  vi.mocked(binding.loadP2pNode).mockReturnValue(node as never);
});

afterAll(async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  await daemon.controlRequest("POST", "/stop");
  exit.mockRestore();
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  process.exitCode = 0;
  printed = [];
  const keep = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  vi.spyOn(console, "warn").mockImplementation(keep);
  display.setOutputMode("human");
});

describe("with no daemon running", () => {
  it("removes the gene from the table only, and says so", async () => {
    table.writeAnnouncedTable(TABLE, [
      { genesRoot: ROOT, name: "old", geneId: ID_OLD },
      { genesRoot: ROOT, name: "beta", geneId: ID_B },
    ]);
    await withdraw("old");
    expect(process.exitCode).toBe(0);
    expect(text()).toContain("Stopped announcing 'old'");
    expect(text()).toContain("the gene was only removed from the republish table");
    expect(saved()).toEqual([{ genesRoot: ROOT, name: "beta", geneId: ID_B }]);
    expect(statSync(TABLE).mode & 0o777).toBe(0o600);
  });

  it("fails for a gene that is not in the table", async () => {
    await withdraw("nothing-here");
    expect(process.exitCode).toBe(1);
    expect(text()).toContain("is not announced from this node");
  });
});

describe("with the daemon running", () => {
  beforeAll(async () => {
    await daemon.runDaemon("127.0.0.1", 0, [], false);
    // The restored entry (beta, left by the tests above) is republished at
    // start, since the node already has a DHT peer.
    await vi.waitFor(() => expect(node.republishLocalGene).toHaveBeenCalledWith(ROOT, "beta", ID_B));
  });

  it("restores the table at start and republishes what it holds", () => {
    expect(node.republishLocalGene).toHaveBeenCalledTimes(1);
  });

  it("records an announced gene in the table", async () => {
    const result = await daemon.controlRequest("POST", "/announce", { genesRoot: ROOT, name: "alpha" });
    expect(result?.ok).toBe(true);
    expect(saved()).toEqual([
      { genesRoot: ROOT, name: "beta", geneId: ID_B },
      { genesRoot: ROOT, name: "alpha", geneId: ID_A },
    ]);
    expect(statSync(TABLE).mode & 0o777).toBe(0o600);
  });

  it("withdraw by v2 ID stops serving the gene and drops it from the table", async () => {
    await withdraw(ID_A);
    expect(process.exitCode).toBe(0);
    expect(node.withdrawGene).toHaveBeenCalledWith(ID_A);
    expect(text()).toContain("Stopped announcing 'alpha'");
    expect(text()).toContain(ID_A);
    expect(saved()).toEqual([{ genesRoot: ROOT, name: "beta", geneId: ID_B }]);
  });

  it("states the real limits: 24 h for stored copies, 48 h for nodes that heard the gossip", async () => {
    await withdraw("beta");
    expect(node.withdrawGene).toHaveBeenCalledWith(ID_B);
    expect(text()).toContain("copies they stored expire within 24 h of arriving");
    expect(text()).toContain("can still list it for up to 48 h");
    expect(text()).not.toContain("stop listing it within 24 h");
    expect(saved()).toEqual([]);
  });

  it("fails for a gene this node does not announce", async () => {
    node.withdrawGene.mockClear();
    await withdraw("never-announced");
    expect(process.exitCode).toBe(1);
    expect(text()).toContain("is not announced from this node");
    expect(node.withdrawGene).not.toHaveBeenCalled();
  });

  it("the daemon refuses a request that names no gene", async () => {
    const result = await daemon.controlRequest("POST", "/withdraw", {});
    expect(result?.status).toBe(400);
  });
});

describe("withdraw --help", () => {
  it("carries the limits and the node-key line (§7.3)", () => {
    const cmd = net.networkCommand.commands.find((c) => c.name() === "withdraw")!;
    let out = "";
    const write = vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
    try {
      cmd.outputHelp();
    } finally {
      write.mockRestore();
    }
    expect(out).toContain("<gene>");
    expect(out).toContain("up to 48 h");
    expect(out).toContain("It does not bound a stolen node key");
  });
});
