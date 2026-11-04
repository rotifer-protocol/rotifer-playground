/**
 * The republish table and schedule (A2 design v2 §7.2–§7.3). The clock and
 * timers are vitest's fake ones, so no test waits 12 h.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  REPUBLISH_INTERVAL_MS,
  REPUBLISH_JITTER_MS,
  RESTORE_WAIT_MS,
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
