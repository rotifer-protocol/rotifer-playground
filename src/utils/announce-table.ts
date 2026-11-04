/**
 * The daemon's republish table (A2 design v2 §7.2–§7.3).
 *
 * Every gene this node announced is kept in `~/.rotifer/p2p/announced.json`
 * (mode 0600) as `{genesRoot, name, geneId}`, and republished on its own
 * schedule: 12 h after the last publish plus a uniform jitter in [0, 60 min).
 * The daemon restores the table when it starts, so republishing survives a
 * restart. Timers, clock and randomness are injected so tests need no real
 * 12 h wait.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDir, tightenPrivateFile } from "./private-fs.js";

export interface AnnouncedGene {
  genesRoot: string;
  name: string;
  geneId: string;
}

export const REPUBLISH_INTERVAL_MS = 12 * 3600 * 1000;
export const REPUBLISH_JITTER_MS = 60 * 60 * 1000;
/** After a restart, how long to wait for a first DHT peer before republishing anyway. */
export const RESTORE_WAIT_MS = 60 * 1000;
const RESTORE_POLL_MS = 1000;

export function announcedTablePath(rotiferHome: string): string {
  return join(rotiferHome, "p2p", "announced.json");
}

const isEntry = (e: unknown): e is AnnouncedGene =>
  typeof e === "object" &&
  e !== null &&
  ["genesRoot", "name", "geneId"].every((k) => typeof (e as Record<string, unknown>)[k] === "string");

/** Read the table. A missing file is an empty table; a damaged one is reported, not thrown. */
export function readAnnouncedTable(path: string): { entries: AnnouncedGene[]; problem?: string } {
  if (!existsSync(path)) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return { entries: [], problem: `${path} is not valid JSON (${(err as Error).message})` };
  }
  if (!Array.isArray(parsed)) return { entries: [], problem: `${path} is not a list` };
  const entries = parsed.filter(isEntry);
  const skipped = parsed.length - entries.length;
  return skipped > 0 ? { entries, problem: `${path}: skipped ${skipped} malformed entries` } : { entries };
}

/** Write the table atomically, mode 0600, with exactly the three fields per entry. */
export function writeAnnouncedTable(path: string, entries: readonly AnnouncedGene[]): void {
  ensurePrivateDir(dirname(path));
  const rows = entries.map(({ genesRoot, name, geneId }) => ({ genesRoot, name, geneId }));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2) + "\n", { mode: 0o600 });
  tightenPrivateFile(tmp);
  renameSync(tmp, path);
  tightenPrivateFile(path);
}

/** Which entries a `withdraw` argument names: a v2 ID, or a gene name. */
export type WithdrawMatch = { geneId: string } | { name: string };

export function matches(entry: AnnouncedGene, match: WithdrawMatch): boolean {
  return "geneId" in match ? entry.geneId === match.geneId : entry.name === match.name;
}

/** One scheduled republish, as the native addon reports it. */
export interface RepublishOutcome {
  /** `gone`: the files no longer compute a v2 ID; `changed`: they compute another one. */
  outcome: "republished" | "gone" | "changed" | string;
  geneId: string;
  recordSent: number;
  recordAcked: number;
}

type Timer = ReturnType<typeof setTimeout>;

export interface RepublisherDeps {
  path: string;
  republish(entry: AnnouncedGene): Promise<RepublishOutcome>;
  /** Stop providing `geneId` and drop this node's own copy of its record. */
  withdraw(geneId: string): void;
  hasDhtPeer(): boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
  random?: () => number;
  log?: (line: string) => void;
}

export class Republisher {
  private entries: AnnouncedGene[] = [];
  private readonly timers = new Map<AnnouncedGene, Timer>();
  private restoreTimer: Timer | undefined;
  private stopped = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly random: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: RepublisherDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
    this.random = deps.random ?? Math.random;
    this.log = deps.log ?? (() => {});
  }

  /** The genes being republished. */
  list(): readonly AnnouncedGene[] {
    return this.entries;
  }

  /**
   * Restore the table at daemon start. Once the node has a DHT peer (or
   * after at most 60 s) each entry is republished, then kept on its own
   * schedule. The table holds no publish time, so the 24 h a record lives
   * elsewhere is counted from this republish.
   */
  restore(): void {
    const { entries, problem } = readAnnouncedTable(this.deps.path);
    if (problem) this.log(`republish table: ${problem}`);
    this.entries = entries;
    if (entries.length === 0) return;
    const startedAt = this.now();
    const poll = (): void => {
      this.restoreTimer = undefined;
      if (this.stopped) return;
      if (this.deps.hasDhtPeer() || this.now() - startedAt >= RESTORE_WAIT_MS) {
        for (const entry of this.entries) void this.run(entry);
      } else {
        this.restoreTimer = this.setTimer(poll, RESTORE_POLL_MS);
      }
    };
    poll();
  }

  /** Record a gene just announced and schedule its next republish. */
  added(entry: AnnouncedGene): void {
    for (const old of this.entries.filter(
      (e) => e.geneId === entry.geneId || (e.genesRoot === entry.genesRoot && e.name === entry.name),
    )) {
      this.forget(old);
      // The same gene files now compute another ID: stop serving the old one.
      if (old.geneId !== entry.geneId) this.deps.withdraw(old.geneId);
    }
    this.entries.push(entry);
    this.save();
    this.schedule(entry);
  }

  /**
   * Stop announcing the genes `match` names. Returns them. The file is
   * written first: if that fails nothing changes, and once it succeeds the
   * gene stays withdrawn across a restart even if the node call throws.
   */
  withdraw(match: WithdrawMatch): AnnouncedGene[] {
    const removed = this.entries.filter((e) => matches(e, match));
    if (removed.length === 0) return removed;
    writeAnnouncedTable(
      this.deps.path,
      this.entries.filter((e) => !removed.includes(e)),
    );
    for (const entry of removed) this.forget(entry);
    for (const entry of removed) this.deps.withdraw(entry.geneId);
    return removed;
  }

  /** Cancel every pending republish and the restore wait (the daemon is stopping). */
  stop(): void {
    this.stopped = true;
    if (this.restoreTimer !== undefined) this.clearTimer(this.restoreTimer);
    this.restoreTimer = undefined;
    for (const t of this.timers.values()) this.clearTimer(t);
    this.timers.clear();
  }

  private schedule(entry: AnnouncedGene): void {
    const delay = REPUBLISH_INTERVAL_MS + Math.floor(this.random() * REPUBLISH_JITTER_MS);
    this.timers.set(
      entry,
      this.setTimer(() => void this.run(entry), delay),
    );
  }

  private forget(entry: AnnouncedGene): void {
    const t = this.timers.get(entry);
    if (t !== undefined) this.clearTimer(t);
    this.timers.delete(entry);
    this.entries = this.entries.filter((e) => e !== entry);
  }

  private save(): void {
    try {
      writeAnnouncedTable(this.deps.path, this.entries);
    } catch (err) {
      this.log(`republish table not saved: ${(err as Error).message}`);
    }
  }

  private async run(entry: AnnouncedGene): Promise<void> {
    this.timers.delete(entry);
    if (!this.entries.includes(entry)) return;
    try {
      const result = await this.deps.republish(entry);
      if (!this.entries.includes(entry)) return this.withdrawnMeanwhile(entry);
      if (result.outcome !== "republished") {
        // §7.2: the files are gone or compute another ID → drop and stop serving.
        this.log(`stopped republishing '${entry.name}' (${entry.geneId}): ${result.outcome}`);
        this.forget(entry);
        this.deps.withdraw(entry.geneId);
        this.save();
        return;
      }
    } catch (err) {
      this.log(`republish of '${entry.name}' failed: ${(err as Error).message}`);
      if (!this.entries.includes(entry)) return this.withdrawnMeanwhile(entry);
    }
    this.schedule(entry);
  }

  /**
   * The gene was withdrawn while its republish was in flight. The withdraw
   * ran first, so the republish may have put the record and started
   * providing again: withdraw once more, unless the same ID was announced
   * again in between.
   */
  private withdrawnMeanwhile(entry: AnnouncedGene): void {
    if (this.entries.some((e) => e.geneId === entry.geneId)) return;
    try {
      this.deps.withdraw(entry.geneId);
    } catch (err) {
      this.log(`withdraw of '${entry.name}' after its republish failed: ${(err as Error).message}`);
    }
  }
}
