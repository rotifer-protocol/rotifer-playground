/**
 * The republish table and schedule (A2 design v2 §7.2–§7.3). The clock and
 * timers are vitest's fake ones, so no test waits 12 h.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Republisher,
  announcedTablePath,
  readAnnouncedTable,
  writeAnnouncedTable,
  type AnnouncedGene,
  type RepublishOutcome,
} from "../../src/utils/announce-table.js";

const ID_A = `v2:${"aa".repeat(32)}`;
const ID_B = `v2:${"bb".repeat(32)}`;
const ID_C = `v2:${"cc".repeat(32)}`;
const HOUR = 3600 * 1000;
// The design's numbers, written out: the module's own constants are not used,
// so changing one of them turns these tests red.
const REPUBLISH_INTERVAL_MS = 12 * 3600 * 1000;
const REPUBLISH_JITTER_MS = 3_600_000;
const RESTORE_WAIT_MS = 60_000;

let home: string;
let path: string;

const gene = (name: string, geneId: string, genesRoot = "/p/genes"): AnnouncedGene => ({ genesRoot, name, geneId });

function setup(opts: { random?: () => number; outcome?: (e: AnnouncedGene) => RepublishOutcome; peers?: () => boolean } = {}) {
  const republish = vi.fn(async (e: AnnouncedGene) =>
    opts.outcome ? opts.outcome(e) : { outcome: "republished", geneId: e.geneId, recordSent: 1, recordAcked: 1 },
  );
  const withdraw = vi.fn();
  const log = vi.fn();
  const r = new Republisher({
    path,
    republish,
    withdraw,
    hasDhtPeer: opts.peers ?? (() => true),
    random: opts.random ?? (() => 0),
    log,
  });
  return { r, republish, withdraw, log };
}

const saved = () => JSON.parse(readFileSync(path, "utf-8")) as AnnouncedGene[];

beforeEach(() => {
  vi.useFakeTimers();
  home = mkdtempSync(join(tmpdir(), "rotifer-announced-"));
  path = announcedTablePath(join(home, ".rotifer"));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe("the table file (§7.3)", () => {
  it("lives at ~/.rotifer/p2p/announced.json", () => {
    expect(path).toBe(join(home, ".rotifer", "p2p", "announced.json"));
  });

  it("is written with mode 0600, holding exactly genesRoot, name and geneId", () => {
    writeAnnouncedTable(path, [{ ...gene("a", ID_A), extra: "x" } as AnnouncedGene]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(saved()).toEqual([gene("a", ID_A)]);
    expect(Object.keys(saved()[0]).sort()).toEqual(["geneId", "genesRoot", "name"]);
  });

  it("keeps mode 0600 when the gene list changes", () => {
    const { r } = setup();
    r.added(gene("a", ID_A));
    r.added(gene("b", ID_B));
    r.withdraw({ name: "a" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(saved()).toEqual([gene("b", ID_B)]);
  });

  it("reads a missing file as empty, and reports a damaged one instead of throwing", () => {
    expect(readAnnouncedTable(path)).toEqual({ entries: [] });
    mkdirSync(join(home, ".rotifer", "p2p"), { recursive: true });
    writeFileSync(path, "{not json");
    const bad = readAnnouncedTable(path);
    expect(bad.entries).toEqual([]);
    expect(bad.problem).toContain("not valid JSON");
    writeFileSync(path, JSON.stringify([gene("a", ID_A), { name: 1 }]));
    const partial = readAnnouncedTable(path);
    expect(partial.entries).toEqual([gene("a", ID_A)]);
    expect(partial.problem).toContain("skipped 1");
  });
});

describe("the schedule (§7.2)", () => {
  it("republishes 12 h plus the jitter after the announce, not before", async () => {
    const { r, republish } = setup({ random: () => 0.5 });
    r.added(gene("a", ID_A));
    const due = REPUBLISH_INTERVAL_MS + REPUBLISH_JITTER_MS / 2;
    await vi.advanceTimersByTimeAsync(due - 1);
    expect(republish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(republish).toHaveBeenCalledWith(gene("a", ID_A));
  });

  it("draws the jitter from [0, 60 min)", async () => {
    for (const [random, delay] of [
      [0, REPUBLISH_INTERVAL_MS],
      [0.999_999, REPUBLISH_INTERVAL_MS + Math.floor(0.999_999 * REPUBLISH_JITTER_MS)],
    ] as const) {
      const { r, republish } = setup({ random: () => random });
      r.added(gene("a", ID_A));
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(republish).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(republish).toHaveBeenCalledTimes(1);
      expect(delay).toBeLessThan(REPUBLISH_INTERVAL_MS + REPUBLISH_JITTER_MS);
      r.stop();
    }
  });

  it("keeps each gene on its own schedule, then the next one 12 h after the last", async () => {
    const { r, republish } = setup();
    r.added(gene("a", ID_A));
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    r.added(gene("b", ID_B));
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(republish.mock.calls.map((c) => c[0].name)).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(republish.mock.calls.map((c) => c[0].name)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(9 * HOUR);
    expect(republish.mock.calls.map((c) => c[0].name)).toEqual(["a", "b", "a"]);
  });

  it("keeps the gene after a failed republish and tries again on schedule", async () => {
    const republish = vi.fn().mockRejectedValueOnce(new Error("event loop is not running"));
    republish.mockResolvedValue({ outcome: "republished", geneId: ID_A, recordSent: 0, recordAcked: 0 });
    const r = new Republisher({ path, republish, withdraw: vi.fn(), hasDhtPeer: () => true, random: () => 0 });
    r.added(gene("a", ID_A));
    await vi.advanceTimersByTimeAsync(REPUBLISH_INTERVAL_MS);
    expect(r.list()).toEqual([gene("a", ID_A)]);
    await vi.advanceTimersByTimeAsync(REPUBLISH_INTERVAL_MS);
    expect(republish).toHaveBeenCalledTimes(2);
  });

  for (const outcome of ["gone", "changed"]) {
    it(`drops a gene whose files are ${outcome === "gone" ? "gone" : "now another gene"}, and stops serving it`, async () => {
      const { r, republish, withdraw } = setup({
        outcome: (e) => ({ outcome, geneId: outcome === "gone" ? "" : ID_C, recordSent: 0, recordAcked: 0 }),
      });
      r.added(gene("a", ID_A));
      r.added(gene("b", ID_B));
      await vi.advanceTimersByTimeAsync(REPUBLISH_INTERVAL_MS);
      expect(withdraw.mock.calls).toEqual([[ID_A], [ID_B]]);
      expect(r.list()).toEqual([]);
      expect(saved()).toEqual([]);
      await vi.advanceTimersByTimeAsync(2 * REPUBLISH_INTERVAL_MS);
      expect(republish).toHaveBeenCalledTimes(2);
    });
  }
});

describe("announce and withdraw (§7.3)", () => {
  it("records a gene once, however often it is announced", () => {
    const { r } = setup();
    r.added(gene("a", ID_A));
    r.added(gene("a", ID_A));
    expect(saved()).toEqual([gene("a", ID_A)]);
  });

  it("re-announcing a gene whose files now compute another ID stops serving the old ID", () => {
    const { r, withdraw } = setup();
    r.added(gene("a", ID_A));
    r.added(gene("a", ID_B));
    expect(withdraw).toHaveBeenCalledWith(ID_A);
    expect(saved()).toEqual([gene("a", ID_B)]);
  });

  it("withdraw by name or by v2 ID removes the gene, stops serving it and cancels its republish", async () => {
    const { r, republish, withdraw } = setup();
    r.added(gene("a", ID_A));
    r.added(gene("b", ID_B));
    expect(r.withdraw({ name: "a" })).toEqual([gene("a", ID_A)]);
    expect(r.withdraw({ geneId: ID_B })).toEqual([gene("b", ID_B)]);
    expect(withdraw.mock.calls).toEqual([[ID_A], [ID_B]]);
    expect(saved()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3 * REPUBLISH_INTERVAL_MS);
    expect(republish).not.toHaveBeenCalled();
  });

  it("withdraw of a gene that is not announced changes nothing", () => {
    const { r, withdraw } = setup();
    r.added(gene("a", ID_A));
    expect(r.withdraw({ name: "zzz" })).toEqual([]);
    expect(withdraw).not.toHaveBeenCalled();
    expect(saved()).toEqual([gene("a", ID_A)]);
  });
});

describe("restore after a restart (§7.3, CEO ruling 2)", () => {
  it("republishes every restored gene once a DHT peer is up, then every 12 h", async () => {
    writeAnnouncedTable(path, [gene("a", ID_A), gene("b", ID_B)]);
    let peers = false;
    const { r, republish } = setup({ peers: () => peers });
    r.restore();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(republish).not.toHaveBeenCalled();
    peers = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(republish.mock.calls.map((c) => c[0].name)).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(REPUBLISH_INTERVAL_MS);
    expect(republish).toHaveBeenCalledTimes(4);
  });

  it("republishes anyway after 60 s without a DHT peer", async () => {
    writeAnnouncedTable(path, [gene("a", ID_A)]);
    const { r, republish } = setup({ peers: () => false });
    r.restore();
    await vi.advanceTimersByTimeAsync(RESTORE_WAIT_MS - 1_000);
    expect(republish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(republish).toHaveBeenCalledTimes(1);
  });

  it("a damaged table starts empty and says why", () => {
    mkdirSync(join(home, ".rotifer", "p2p"), { recursive: true });
    writeFileSync(path, "[[[");
    const { r, log } = setup();
    expect(() => r.restore()).not.toThrow();
    expect(r.list()).toEqual([]);
    expect(log.mock.calls[0][0]).toContain("not valid JSON");
  });
});

describe("withdraw while a republish is in flight (acceptance, PR-4 rework)", () => {
  // The node runs the republish's put and start_providing when the promise
  // settles, after the withdraw: the withdraw has to be repeated then.
  function inFlight(settle: "resolve" | "reject") {
    const events: string[] = [];
    let finish!: () => void;
    const republish = vi.fn(
      (e: AnnouncedGene) =>
        new Promise<RepublishOutcome>((resolve, reject) => {
          events.push("republish started");
          finish = () => {
            events.push("republish finished");
            if (settle === "resolve") resolve({ outcome: "republished", geneId: e.geneId, recordSent: 1, recordAcked: 1 });
            else reject(new Error("put timed out"));
          };
        }),
    );
    const withdraw = vi.fn((id: string) => void events.push(`withdraw ${id}`));
    const r = new Republisher({ path, republish, withdraw, hasDhtPeer: () => true, random: () => 0, log: vi.fn() });
    return { r, events, withdraw, republish, finish: () => finish() };
  }

  for (const settle of ["resolve", "reject"] as const) {
    it(`withdraws again after a restored republish that ${settle === "resolve" ? "succeeds" : "fails"}`, async () => {
      writeAnnouncedTable(path, [gene("a", ID_A)]);
      const { r, events, finish } = inFlight(settle);
      r.restore();
      expect(events).toEqual(["republish started"]);
      expect(r.withdraw({ name: "a" })).toEqual([gene("a", ID_A)]);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual(["republish started", `withdraw ${ID_A}`, "republish finished", `withdraw ${ID_A}`]);
      expect(saved()).toEqual([]);
      await vi.advanceTimersByTimeAsync(3 * REPUBLISH_INTERVAL_MS);
      expect(events.filter((e) => e === "republish started")).toHaveLength(1);
    });
  }

  it("does not withdraw again when the same gene was announced again meanwhile", async () => {
    writeAnnouncedTable(path, [gene("a", ID_A)]);
    const { r, withdraw, finish } = inFlight("resolve");
    r.restore();
    r.withdraw({ name: "a" });
    r.added(gene("a", ID_A));
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(withdraw.mock.calls).toEqual([[ID_A]]);
    expect(saved()).toEqual([gene("a", ID_A)]);
  });
});

describe("withdraw changes the file and the schedule together (acceptance O3)", () => {
  it("when the node call throws, the gene is already out of the file and is not restored", async () => {
    const republish = vi.fn(async (e: AnnouncedGene) => ({ outcome: "republished", geneId: e.geneId, recordSent: 1, recordAcked: 1 }));
    const r = new Republisher({
      path,
      republish,
      withdraw: () => {
        throw new Error("event loop is not running");
      },
      hasDhtPeer: () => true,
      random: () => 0,
    });
    r.added(gene("a", ID_A));
    r.added(gene("b", ID_B));
    expect(() => r.withdraw({ name: "a" })).toThrow("event loop is not running");
    expect(saved()).toEqual([gene("b", ID_B)]);
    expect(r.list()).toEqual([gene("b", ID_B)]);
    await vi.advanceTimersByTimeAsync(REPUBLISH_INTERVAL_MS);
    expect(republish.mock.calls.map((c) => c[0].name)).toEqual(["b"]);
    // After a restart the withdrawn gene stays withdrawn.
    const { r: restarted, republish: again } = setup();
    restarted.restore();
    await vi.advanceTimersByTimeAsync(0);
    expect(again.mock.calls.map((c) => c[0].name)).toEqual(["b"]);
  });

  it("when the file cannot be written, nothing changes and the node is not called", () => {
    const { r, withdraw } = setup();
    r.added(gene("a", ID_A));
    // The table is written through a temporary file; a directory in its place makes the write fail.
    const tmp = `${path}.${process.pid}.tmp`;
    mkdirSync(tmp);
    try {
      expect(() => r.withdraw({ name: "a" })).toThrow();
    } finally {
      rmSync(tmp, { recursive: true });
    }
    expect(withdraw).not.toHaveBeenCalled();
    expect(r.list()).toEqual([gene("a", ID_A)]);
    expect(saved()).toEqual([gene("a", ID_A)]);
  });
});

describe("stop (acceptance O3)", () => {
  it("cancels the restore wait: no republish after stop", async () => {
    writeAnnouncedTable(path, [gene("a", ID_A)]);
    let peers = false;
    const { r, republish } = setup({ peers: () => peers });
    r.restore();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(1);
    r.stop();
    expect(vi.getTimerCount()).toBe(0);
    peers = true;
    await vi.advanceTimersByTimeAsync(2 * RESTORE_WAIT_MS);
    expect(republish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
