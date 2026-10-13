import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/utils/display.js", () => ({
  header: vi.fn(),
  kv: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  hint: vi.fn(),
}));
vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  loadP2pNode: vi.fn(),
  geneIdV2: vi.fn(),
}));
// Mock the daemon boundary so the command logic is tested without a real
// daemon / native addon (the real control round-trip is covered by manual runs).
vi.mock("../../src/utils/p2p-daemon.js", () => ({
  controlRequest: vi.fn(),
  isDaemonRunning: vi.fn(),
  readDaemonState: vi.fn(),
  runDaemon: vi.fn(),
}));

import { networkCommand } from "../../src/commands/network.js";
import { geneIdV2, loadP2pNode } from "../../src/utils/binding.js";

const V2_ID = `v2:${"ab".repeat(32)}`;
import {
  controlRequest,
  isDaemonRunning,
} from "../../src/utils/p2p-daemon.js";
import * as display from "../../src/utils/display.js";

const WORK = join(tmpdir(), `rotifer-net2-${Date.now()}`);
let origCwd: string;

const ctrlOk = (body: unknown) => ({ ok: true, status: 200, body });
const kvArgs = () => vi.mocked(display.kv).mock.calls.flat();

beforeEach(() => {
  vi.clearAllMocks();
  origCwd = process.cwd();
  mkdirSync(join(WORK, "genes", "test-gene"), { recursive: true });
  writeFileSync(
    join(WORK, "genes", "test-gene", "phenotype.json"),
    JSON.stringify({ name: "test-gene", domain: "test", version: "1.2.3", fidelity: "Native" })
  );
  process.chdir(WORK);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(WORK, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("network status", () => {
  it("shows the running daemon's info", async () => {
    vi.mocked(controlRequest).mockResolvedValue(
      ctrlOk({ peerId: "PID-1", listenAddrs: ["/ip4/127.0.0.1/tcp/9878"], peers: 2 })
    );
    await networkCommand.parseAsync(["status"], { from: "user" });
    expect(kvArgs()).toContain("PID-1");
  });

  it("shows not-running when there is no daemon", async () => {
    vi.mocked(controlRequest).mockResolvedValue(null);
    await networkCommand.parseAsync(["status"], { from: "user" });
    expect(display.hint).toHaveBeenCalledWith(expect.stringContaining("network start"));
  });
});

describe("network peers", () => {
  it("lists the peers the daemon reports", async () => {
    vi.mocked(controlRequest).mockResolvedValue(ctrlOk({ peers: ["peerA", "peerB"] }));
    await networkCommand.parseAsync(["peers"], { from: "user" });
    expect(kvArgs()).toContain("peerA");
  });

  it("warns when the daemon is not running", async () => {
    vi.mocked(controlRequest).mockResolvedValue(null);
    await networkCommand.parseAsync(["peers"], { from: "user" });
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("not running"));
  });
});

describe("network received", () => {
  it("lists the gene announcements the daemon received", async () => {
    vi.mocked(controlRequest).mockResolvedValue(
      ctrlOk({
        announcements: [
          {
            geneId: V2_ID,
            name: "polymarket-scanner",
            domain: "finance",
            version: "0.3.0",
            fidelity: "Native",
            irSpec: "0.2.0",
            publisher: "12D3KooWabc",
            source: "12D3KooWabc",
          },
        ],
      })
    );
    await networkCommand.parseAsync(["received"], { from: "user" });
    expect(kvArgs()).toContain("polymarket-scanner@0.3.0");
  });

  it("warns when the daemon is not running", async () => {
    vi.mocked(controlRequest).mockResolvedValue(null);
    await networkCommand.parseAsync(["received"], { from: "user" });
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("not running"));
  });

  it("warns when no announcements received yet", async () => {
    vi.mocked(controlRequest).mockResolvedValue(ctrlOk({ announcements: [] }));
    await networkCommand.parseAsync(["received"], { from: "user" });
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("No announcements"));
  });
});

describe("network announce", () => {
  beforeEach(() => {
    vi.mocked(geneIdV2).mockReturnValue({ id: V2_ID });
  });

  it("checks the gene's v2 ID, then asks the daemon to announce it by name", async () => {
    vi.mocked(controlRequest).mockResolvedValue(ctrlOk({ ok: true, geneId: V2_ID }));
    await networkCommand.parseAsync(["announce", "test-gene"], { from: "user" });
    expect(geneIdV2).toHaveBeenCalledWith(expect.stringMatching(/genes$/), "test-gene");
    expect(controlRequest).toHaveBeenCalledWith("POST", "/announce", {
      genesRoot: expect.stringMatching(/genes$/),
      name: "test-gene",
    });
    expect(display.success).toHaveBeenCalled();
    expect(kvArgs()).toContain(V2_ID);
  });

  it("errors (without a control request) when the gene is missing", async () => {
    await networkCommand.parseAsync(["announce", "no-such-gene"], { from: "user" });
    expect(controlRequest).not.toHaveBeenCalled();
    expect(display.error).toHaveBeenCalledWith(
      expect.stringContaining("not found"),
      expect.anything()
    );
    expect(process.exitCode).toBe(1);
  });

  it("refuses a gene with no v2 ID and never sends its directory name", async () => {
    vi.mocked(geneIdV2).mockReturnValue({ reason: "gene.ir.wasm does not exist" });
    await networkCommand.parseAsync(["announce", "test-gene"], { from: "user" });
    expect(controlRequest).not.toHaveBeenCalled();
    expect(display.error).toHaveBeenCalledWith(
      expect.stringContaining("no v2 gene ID"),
      "gene.ir.wasm does not exist"
    );
    expect(process.exitCode).toBe(1);
  });

  it("warns when the daemon is not running", async () => {
    vi.mocked(controlRequest).mockResolvedValue(null);
    await networkCommand.parseAsync(["announce", "test-gene"], { from: "user" });
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("not running"));
  });
});

describe("network stop", () => {
  it("tells a running daemon to stop", async () => {
    vi.mocked(controlRequest).mockResolvedValue(ctrlOk({ ok: true }));
    await networkCommand.parseAsync(["stop"], { from: "user" });
    expect(controlRequest).toHaveBeenCalledWith("POST", "/stop");
    expect(display.success).toHaveBeenCalledWith(expect.stringContaining("stopped"));
  });

  it("warns when no daemon is running", async () => {
    vi.mocked(controlRequest).mockResolvedValue(null);
    await networkCommand.parseAsync(["stop"], { from: "user" });
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("not running"));
  });
});

describe("network start", () => {
  it("reports when a daemon is already running", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue(true);
    await networkCommand.parseAsync(["start"], { from: "user" });
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("already running"));
  });

  it("reports unavailable when the native addon is missing", async () => {
    vi.mocked(isDaemonRunning).mockResolvedValue(false);
    vi.mocked(loadP2pNode).mockReturnValue(null);
    await networkCommand.parseAsync(["start"], { from: "user" });
    expect(display.warn).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
  });
});
