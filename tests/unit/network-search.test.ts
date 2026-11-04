/**
 * `rotifer network search` and the DHT part of `network announce`
 * (A2 design v2 §9, §10; RFC §5.3 degradation). The daemon boundary is
 * mocked; Rotifer Cloud is a real local HTTP server, so the timeout is real.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/utils/p2p-daemon.js", () => ({
  controlRequest: vi.fn(),
  isDaemonRunning: vi.fn(),
  readDaemonState: vi.fn(),
  runDaemon: vi.fn(),
}));
vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  geneIdV2: vi.fn(),
}));

type Network = typeof import("../../src/commands/network.js");
type Daemon = typeof import("../../src/utils/p2p-daemon.js");
type Display = typeof import("../../src/utils/display.js");
type Binding = typeof import("../../src/utils/binding.js");

const HOME = mkdtempSync(join(tmpdir(), "rotifer-net-search-"));
const V2_ID = `v2:${"ab".repeat(32)}`;
const V2_OTHER = `v2:${"cd".repeat(32)}`;

/** What Rotifer Cloud does with the next search request. */
let cloudMode: "answer" | "hang" | "fail" = "answer";
let cloudRows: Record<string, unknown>[] = [];
const hung: ServerResponse[] = [];
let cloud: Server;
let cloudRequests = 0;

let net: Network;
let daemon: Daemon;
let display: Display;
let binding: Binding;
let printed: string[];

function cloudRow(name: string): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name,
    domain: "text",
    version: "1.2.0",
    fidelity: "Native",
    description: null,
    wasm_size: 1,
    downloads: 0,
    reputation_score: 4.2,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    owner_username: "alice",
    total_count: 1,
  };
}

function hit(over: Partial<import("../../src/utils/binding.js").NetworkSearchHit> = {}) {
  return {
    geneId: V2_ID,
    name: "summarize-lite",
    domain: "text",
    version: "0.3.0",
    fidelity: "Wrapped",
    irSpec: "",
    timestampMs: 1_000,
    publisher: "12D3KooWAbcdefghijklmnop",
    source: "dht" as const,
    ...over,
  };
}

/** The daemon is up and its search answers with `result`. */
function daemonAnswers(result: { hits: ReturnType<typeof hit>[]; timedOut?: boolean; partial?: boolean }) {
  vi.mocked(daemon.readDaemonState).mockReturnValue({ pid: 1, port: 1, token: "t", peerId: "me", startedAt: 0 });
  vi.mocked(daemon.controlRequest).mockResolvedValue({
    ok: true,
    status: 200,
    body: { timedOut: false, partial: false, ...result },
  });
}

function daemonDown() {
  vi.mocked(daemon.readDaemonState).mockReturnValue(null);
}

async function run(...args: string[]) {
  await net.networkCommand.parseAsync(args, { from: "user" });
}

async function runJson(...args: string[]): Promise<import("../../src/commands/network.js").NetworkSearchOutput> {
  display.setOutputMode("json");
  const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    await run(...args);
    return JSON.parse(String(out.mock.calls.map((c) => c[0]).join("")));
  } finally {
    out.mockRestore();
    display.setOutputMode("human");
  }
}

const text = () => printed.join("\n");

beforeAll(async () => {
  cloud = createServer((req, res) => {
    cloudRequests += 1;
    req.resume();
    if (cloudMode === "hang") {
      hung.push(res);
      return;
    }
    if (cloudMode === "fail") {
      res.writeHead(500, { "content-type": "application/json" }).end('{"message":"boom"}');
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(cloudRows));
  });
  await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
  process.env.HOME = HOME;
  process.env.ROTIFER_CLOUD_ENDPOINT = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
  net = await import("../../src/commands/network.js");
  daemon = await import("../../src/utils/p2p-daemon.js");
  display = await import("../../src/utils/display.js");
  binding = await import("../../src/utils/binding.js");
});

afterAll(async () => {
  for (const res of hung) res.destroy();
  cloud.closeAllConnections();
  await new Promise((r) => cloud.close(r));
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  cloudMode = "answer";
  cloudRows = [];
  cloudRequests = 0;
  process.exitCode = 0;
  printed = [];
  const keep = (...a: unknown[]) => void printed.push(a.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe("network search: modes (§10.1)", () => {
  it("looks a v2 ID up in the DHT and skips Cloud, saying why", async () => {
    daemonAnswers({ hits: [hit()] });
    await run("search", V2_ID);
    expect(daemon.controlRequest).toHaveBeenCalledWith("POST", "/search", { geneId: V2_ID });
    expect(cloudRequests).toBe(0);
    expect(text()).toContain("Rotifer Cloud skipped: it cannot look up v2 gene IDs");
    expect(process.exitCode).toBe(0);
  });

  it("sends anything else to the daemon as a keyword, never as a gene ID, and asks Cloud too", async () => {
    daemonAnswers({ hits: [] });
    await run("search", "summarize");
    expect(daemon.controlRequest).toHaveBeenCalledWith("POST", "/search", { keyword: "summarize" });
    expect(cloudRequests).toBe(1);
  });

  it("treats an almost-v2 query as a keyword", async () => {
    daemonAnswers({ hits: [] });
    await run("search", `v2:${"AB".repeat(32)}`);
    expect(daemon.controlRequest).toHaveBeenCalledWith("POST", "/search", { keyword: `v2:${"AB".repeat(32)}` });
  });
});

describe("network search: the two lists are not merged (§9, T17)", () => {
  it("T17: a gene named alike in Cloud and on P2P stays in both lists", async () => {
    cloudRows = [cloudRow("summarize-lite")];
    daemonAnswers({ hits: [hit({ name: "summarize-lite" })] });
    const out = await runJson("search", "summarize");
    expect(out.merged).toBe(false);
    expect(out.cloud.genes.map((g) => g.name)).toEqual(["summarize-lite"]);
    expect(out.p2p.genes).toHaveLength(1);
    expect(out.p2p.genes[0]).toMatchObject({ geneId: V2_ID, cloudMatch: "unknown" });
  });

  it("T17: the human view prints both lists and says they are not merged", async () => {
    cloudRows = [cloudRow("summarize-lite")];
    daemonAnswers({ hits: [hit({ name: "summarize-lite" })] });
    await run("search", "summarize");
    expect(text()).toContain("Rotifer Cloud (1)");
    expect(text()).toContain("P2P network (1)");
    expect(text()).toContain("The two lists are not merged");
    expect(text()).not.toMatch(/Cloud-verified|P2P-only/);
  });

  it("T17b: publishers that disagree are each shown, with a warning", async () => {
    daemonAnswers({
      hits: [
        hit({ publisher: "12D3KooWAaaaaaaaaaaaaaaa", name: "summarize-lite", fidelity: "Wrapped" }),
        hit({ publisher: "12D3KooWBbbbbbbbbbbbbbbb", name: "sumz", fidelity: "Native" }),
      ],
    });
    const out = await runJson("search", V2_ID);
    expect(out.p2p.genes).toHaveLength(1);
    expect(out.p2p.genes[0].labelsAgree).toBe(false);
    expect(out.p2p.genes[0].publishers.map((p) => p.name).sort()).toEqual(["summarize-lite", "sumz"]);
    expect(Object.keys(out.p2p.genes[0])).not.toContain("name");
    await run("search", V2_ID);
    expect(text()).toContain("summarize-lite@0.3.0");
    expect(text()).toContain("sumz@0.3.0");
    expect(text()).toContain("! publishers disagree on name and fidelity");
  });

  it("ranks genes by distinct registered accounts, then by newest", () => {
    const groups = net.groupP2pHits([
      hit({ geneId: V2_OTHER, publisher: "p1", timestampMs: 9_000 }),
      hit({ geneId: V2_ID, publisher: "p2", account: "iss a", timestampMs: 1_000 }),
      hit({ geneId: V2_ID, publisher: "p3", account: "iss a", timestampMs: 2_000 }),
      hit({ geneId: V2_ID, publisher: "p4", timestampMs: 3_000 }),
    ]);
    expect(groups.map((g) => g.geneId)).toEqual([V2_ID, V2_OTHER]);
    // Two nodes of one account count once; the unregistered one is listed, not counted.
    expect(groups[0].registeredAccounts).toBe(1);
    expect(groups[0].publishers.map((p) => [p.peerId, p.registered])).toEqual([
      ["p3", true],
      ["p2", true],
      ["p4", false],
    ]);
    const tie = net.groupP2pHits([
      hit({ geneId: V2_ID, publisher: "p1", timestampMs: 1_000 }),
      hit({ geneId: V2_OTHER, publisher: "p2", timestampMs: 2_000 }),
    ]);
    expect(tie.map((g) => g.geneId)).toEqual([V2_OTHER, V2_ID]);
  });
});

describe("network search: JSON shape (§10.1)", () => {
  it("has one meaning per field: status says how it ended, partial whether results may be incomplete", async () => {
    cloudRows = [cloudRow("summarizer")];
    daemonAnswers({ hits: [hit({ account: "iss a", source: "both" })], timedOut: false, partial: true });
    const out = await runJson("search", "summarize");
    expect(Object.keys(out).sort()).toEqual(["cloud", "merged", "mode", "p2p", "query"]);
    expect(out).toMatchObject({ query: "summarize", mode: "keyword", merged: false });
    expect(out.cloud.status).toBe("ok");
    expect(out.p2p).toMatchObject({ status: "ok", partial: true });
    expect(Object.keys(out.p2p.genes[0]).sort()).toEqual(
      ["cloudMatch", "geneId", "labelsAgree", "publishers", "registeredAccounts"],
    );
    expect(Object.keys(out.p2p.genes[0].publishers[0]).sort()).toEqual(
      ["domain", "fidelity", "irSpec", "name", "peerId", "registered", "source", "timestampMs", "version"],
    );
    expect(out.p2p.genes[0].publishers[0]).toMatchObject({ registered: true, source: "both", timestampMs: 1_000 });
  });

  it("reports a P2P search that hit its deadline as timeout, with what it had", async () => {
    daemonAnswers({ hits: [hit()], timedOut: true, partial: true });
    const out = await runJson("search", V2_ID);
    expect(out.p2p).toMatchObject({ status: "timeout", partial: true });
    expect(out.p2p.genes).toHaveLength(1);
    expect(out.cloud.status).toBe("skipped");
    expect(process.exitCode).toBe(0);
  });

  // Design v1 §4: P2P times out with the daemon up → whatever it had by 3 s,
  // marked partial, exit 0. Zero results is still an answer.
  const deadlineHint = "P2P results may be incomplete: the 3 s search deadline or a candidate limit was hit.";

  it("a v2 ID search that hits its deadline with nothing is an empty, partial answer, exit 0", async () => {
    daemonAnswers({ hits: [], timedOut: true, partial: true });
    await run("search", V2_ID);
    expect(process.exitCode).toBe(0);
    expect(text()).toContain("P2P network (0)");
    expect(text()).toContain(deadlineHint);
    expect(text()).not.toContain("did not answer");
    expect(text()).not.toContain("not searched");
  });

  it("a keyword search that hits its deadline with nothing is an empty, partial answer, exit 0", async () => {
    cloudRows = [cloudRow("summarizer")];
    daemonAnswers({ hits: [], timedOut: true, partial: true });
    await run("search", "summarize");
    expect(process.exitCode).toBe(0);
    expect(text()).toContain("Rotifer Cloud (1)");
    expect(text()).toContain("P2P network (0)");
    expect(text()).toContain(deadlineHint);
    expect(text()).not.toContain("did not answer");
    expect(text()).not.toContain("not searched");
  });
});

describe("network search: when a side fails (RFC §5.3)", () => {
  it(
    "T18: Cloud that never answers is given up after 5 s; P2P results are shown and the command exits 0",
    async () => {
      cloudMode = "hang";
      daemonAnswers({ hits: [hit()] });
      const started = Date.now();
      await run("search", "summarize");
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(net.CLOUD_TIMEOUT_MS - 50);
      expect(took).toBeLessThan(8_000);
      expect(text()).toContain("Rotifer Cloud unreachable — showing P2P results only");
      expect(text()).toContain("P2P network (1)");
      expect(process.exitCode).toBe(0);
    },
    15_000,
  );

  it("T18: the JSON says Cloud timed out", async () => {
    cloudMode = "hang";
    daemonAnswers({ hits: [hit()] });
    const out = await runJson("search", "summarize");
    expect(out.cloud).toEqual({ status: "timeout", genes: [] });
    expect(out.p2p.status).toBe("ok");
  }, 15_000);

  it("a Cloud error falls back to P2P alone", async () => {
    cloudMode = "fail";
    daemonAnswers({ hits: [hit()] });
    const out = await runJson("search", "summarize");
    expect(out.cloud.status).toBe("error");
    await run("search", "summarize");
    expect(text()).toContain("Rotifer Cloud unreachable — showing P2P results only");
    expect(process.exitCode).toBe(0);
  });

  it("with no daemon, shows Cloud and suggests starting one", async () => {
    cloudRows = [cloudRow("summarizer")];
    daemonDown();
    await run("search", "summarize");
    expect(daemon.controlRequest).not.toHaveBeenCalled();
    expect(text()).toContain("Rotifer Cloud (1)");
    expect(text()).toContain("rotifer network start");
    expect(process.exitCode).toBe(0);
  });

  it("a daemon that leaves its state file behind counts as not running", async () => {
    cloudRows = [cloudRow("summarizer")];
    vi.mocked(daemon.readDaemonState).mockReturnValue({ pid: 1, port: 1, token: "t", peerId: "me", startedAt: 0 });
    vi.mocked(daemon.controlRequest).mockResolvedValue(null);
    const out = await runJson("search", "summarize");
    expect(out.p2p.status).toBe("daemon_not_running");
  });

  // Acceptance observation A: a daemon that never answers the control request
  // is not a search that hit its 3 s deadline.
  function daemonSilent() {
    const realNow = Date.now.bind(Date);
    let skipped = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skipped);
    vi.mocked(daemon.readDaemonState).mockReturnValue({ pid: 1, port: 1, token: "t", peerId: "me", startedAt: 0 });
    vi.mocked(daemon.controlRequest).mockImplementation(async () => {
      skipped += 4_000; // the request ran into its 4 s timeout
      return null;
    });
  }

  it("a daemon that does not answer the control request 'did not answer in time', with no P2P list", async () => {
    cloudRows = [cloudRow("summarizer")];
    daemonSilent();
    await run("search", "summarize");
    expect(process.exitCode).toBe(0);
    expect(text()).toContain("P2P network not searched: the P2P daemon did not answer in time.");
    expect(text()).not.toContain("P2P network (");
    const out = await runJson("search", "summarize");
    expect(out.p2p).toEqual({ status: "timeout", partial: false, genes: [] });
  });

  it("with a v2 ID and a silent daemon, the command fails naming the daemon", async () => {
    daemonSilent();
    await run("search", V2_ID);
    expect(process.exitCode).toBe(1);
    expect(text()).toContain("the P2P daemon did not answer in time");
    expect(text()).not.toContain("P2P network (");
  });

  it("an addon that cannot search is an error on the P2P side", async () => {
    cloudRows = [cloudRow("summarizer")];
    vi.mocked(daemon.readDaemonState).mockReturnValue({ pid: 1, port: 1, token: "t", peerId: "me", startedAt: 0 });
    vi.mocked(daemon.controlRequest).mockResolvedValue({ ok: false, status: 501, body: { error: "update" } });
    const out = await runJson("search", "summarize");
    expect(out.p2p.status).toBe("error");
    expect(process.exitCode).toBe(0);
  });

  it("when both sides fail it names both causes and exits 1", async () => {
    cloudMode = "fail";
    daemonDown();
    await run("search", "summarize");
    expect(text()).toContain("Rotifer Cloud is unreachable or returned an error; the P2P daemon is not running.");
    expect(process.exitCode).toBe(1);
  });

  it("a v2 ID with no daemon fails: Cloud cannot look it up either", async () => {
    daemonDown();
    const out = await runJson("search", V2_ID);
    expect(out.cloud.status).toBe("skipped");
    expect(out.p2p.status).toBe("daemon_not_running");
    expect(process.exitCode).toBe(1);
  });
});

describe("terminal control characters in claimed text (T25)", () => {
  const evil = "evil\x1b[2J\x07name‮";

  it("escapes them in search results", async () => {
    cloudRows = [{ ...cloudRow(evil), owner_username: "o\x1b]0;x\x07" }];
    daemonAnswers({ hits: [hit({ name: evil, domain: "d\x1b[1A", fidelity: "F\r", version: "1\x00" })] });
    await run("search", "evil");
    expect(text()).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f‮]/);
    expect(text()).toContain("evil\\u{1b}[2J\\u{7}name\\u{202e}");
  });

  it("escapes them in `network received`", async () => {
    vi.mocked(daemon.controlRequest).mockResolvedValue({
      ok: true,
      status: 200,
      body: { announcements: [{ ...hit({ name: evil }), publisher: "12D3KooWAbc" }] },
    });
    await run("received");
    expect(text()).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f‮]/);
    expect(text()).toContain("evil\\u{1b}[2J");
  });

  it("leaves ordinary text alone", () => {
    expect(net.escapeTerminal("summarize-lite · 文本 ✓")).toBe("summarize-lite · 文本 ✓");
  });
});

describe("network announce: DHT report and the address notice (§10.2, G18)", () => {
  const flag = join(HOME, ".rotifer", "p2p", "dht-address-notice-shown");
  const notice = "Publishing to the DHT makes this node's network addresses visible";
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    const work = mkdtempSync(join(tmpdir(), "rotifer-announce-"));
    mkdirSync(join(work, "genes", "g"), { recursive: true });
    writeFileSync(join(work, "genes", "g", "phenotype.json"), "{}");
    // Point `announce` at `work` without process.chdir(): Stryker runs tests in
    // worker threads, where chdir throws, and one failure in its dry run aborts
    // the whole mutation pass (#405). announce builds every path from
    // process.cwd(), so this reaches the same files.
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(work);
    rmSync(flag, { force: true });
    vi.mocked(binding.geneIdV2).mockReturnValue({ id: V2_ID });
  });

  afterEach(() => cwdSpy.mockRestore());

  const report = { geneId: V2_ID, gossipPeers: 3, recordSent: 5, recordAcked: 4, readableFrom: 2 };

  it("reports only what was observed, and shows the notice on the first announce only", async () => {
    vi.mocked(daemon.controlRequest).mockResolvedValue({ ok: true, status: 200, body: { ok: true, geneId: V2_ID, report } });
    await run("announce", "g");
    expect(text()).toContain("published (3 connected peers subscribe)");
    expect(text()).toContain("sent to 5 nodes, 4 acknowledged (an acknowledgement does not prove the record was kept)");
    expect(text()).toContain("published (the protocol reports no count and no acknowledgement)");
    expect(text()).toContain("readable from 2 other nodes");
    expect(text()).toContain(notice);
    expect(existsSync(flag)).toBe(true);

    printed = [];
    await run("announce", "g");
    expect(text()).toContain("readable from 2 other nodes");
    expect(text()).not.toContain(notice);
  });

  it("says when there was no DHT peer to send the record to", async () => {
    vi.mocked(daemon.controlRequest).mockResolvedValue({
      ok: true,
      status: 200,
      body: { ok: true, geneId: V2_ID, report: { ...report, recordSent: 0, recordAcked: 0, readableFrom: 0 } },
    });
    await run("announce", "g");
    expect(text()).toContain("not sent: no DHT peers yet");
  });

  it("an older addon announces over gossip only: no DHT lines and no notice", async () => {
    vi.mocked(daemon.controlRequest).mockResolvedValue({ ok: true, status: 200, body: { ok: true, geneId: V2_ID } });
    await run("announce", "g");
    expect(text()).not.toContain("DHT record");
    expect(text()).not.toContain(notice);
    expect(existsSync(flag)).toBe(false);
  });

  it("always carries the notice in --help", () => {
    const announce = net.networkCommand.commands.find((c) => c.name() === "announce")!;
    let help = "";
    announce.configureOutput({ writeOut: (s) => (help += s) });
    announce.outputHelp();
    expect(help).toContain(notice);
  });
});
