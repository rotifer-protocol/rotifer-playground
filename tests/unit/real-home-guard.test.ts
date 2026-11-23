/**
 * The real-home guard's pieces (tests/setup/, T-237): the snapshot sees
 * every kind of change, and a test file starts with a temporary HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { changes, realHome, snapshot, watchedDirs } from "../setup/real-home.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "guard-stand-in-"));
  mkdirSync(join(home, ".rotifer", "p2p"), { recursive: true });
  writeFileSync(join(home, ".rotifer", "network.json"), "{}");
  writeFileSync(join(home, ".rotifer", "p2p", "consent.json"), "{}");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const snap = () => snapshot(watchedDirs(home));

describe("snapshot and changes", () => {
  it("report nothing when nothing changed", () => {
    expect(changes(snap(), snap(), home)).toEqual([]);
  });

  it("report a rewritten file, even at the same size", () => {
    const before = snap();
    const file = join(home, ".rotifer", "network.json");
    writeFileSync(file, "[]");
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(changes(before, snap(), home)).toEqual(["changed .rotifer/network.json"]);
  });

  it("report a removed and an added file, in nested directories too", () => {
    const before = snap();
    unlinkSync(join(home, ".rotifer", "p2p", "consent.json"));
    writeFileSync(join(home, ".rotifer", "p2p", "other.json"), "{}");
    expect(changes(before, snap(), home)).toEqual(["added .rotifer/p2p/other.json", "removed .rotifer/p2p/consent.json"]);
  });

  it("report a state directory that appears", () => {
    const before = snap();
    mkdirSync(join(home, ".config", "rotifer"), { recursive: true });
    expect(changes(before, snap(), home)).toEqual(["changed .config/rotifer"]);
  });

  it("never read contents: a snapshot entry holds only kind, size and mtime", () => {
    for (const v of snap().values()) expect(v).toMatch(/^(dir|absent|(file|link) \d+ [\d.]+)$/);
  });
});

describe("temporary HOME", () => {
  it("is set before this file ran, and is not the real home", () => {
    expect(process.env.HOME).toBeTruthy();
    expect(process.env.HOME).not.toBe(userInfo().homedir);
    expect(process.env.HOME?.startsWith(tmpdir())).toBe(true);
    expect(realHome()).not.toBe(process.env.HOME);
  });
});
