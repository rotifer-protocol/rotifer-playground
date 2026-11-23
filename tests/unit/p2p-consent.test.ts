/**
 * First-run P2P consent (T-237): the record, the notice and its version pin
 * (design §4, T8), and the paths through `network start` and
 * `network consent` with the native module and the daemon replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../src/utils/display.js", () => ({
  header: vi.fn(),
  kv: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  hint: vi.fn(),
  isJsonMode: vi.fn(() => false),
}));
vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  loadP2pNode: vi.fn(),
  loadNodeIdentity: vi.fn(),
}));
vi.mock("../../src/utils/p2p-daemon.js", () => ({
  cliVersion: vi.fn(() => "9.9.9"),
  controlRequest: vi.fn(),
  isDaemonRunning: vi.fn(),
  readDaemonState: vi.fn(),
  runDaemon: vi.fn(),
}));

import {
  NOTICE_QUESTION,
  NOTICE_TEMPLATE,
  NOTICE_VERSION,
  PEER_ID_NOT_YET,
  canAsk,
  consentPath,
  isYes,
  readConsent,
  rememberedPeerCount,
  renderNotice,
  writeConsent,
} from "../../src/utils/p2p-consent.js";
import { networkCommand } from "../../src/commands/network.js";
import { loadNodeIdentity, loadP2pNode } from "../../src/utils/binding.js";
import { controlRequest, isDaemonRunning, runDaemon } from "../../src/utils/p2p-daemon.js";
import * as display from "../../src/utils/display.js";

/**
 * SHA-256 of each notice text, by NOTICE_VERSION. Changing the text without
 * raising the version (and adding its hash here) turns this red: everyone
 * who agreed to the old text would otherwise count as agreeing to the new.
 */
const NOTICE_SHA256: Record<number, string> = {
  1: "2606cdcacbf9a4fc744074ee43c60e0b471e15e1d830270961589918304c7084",
};

let home: string;
let rotifer: string;
let stderr: string[];
let stdout: string[];

function fakeIdentity(peerId = "12D3KooWShown", onDisk = false) {
  return { peerId, onDisk, persist: vi.fn(() => peerId) };
}

function record(): Record<string, unknown> {
  return JSON.parse(readFileSync(consentPath(rotifer), "utf-8")) as Record<string, unknown>;
}

async function run(...args: string[]) {
  await networkCommand.parseAsync(args, { from: "user" });
}

beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), "rotifer-consent-"));
  rotifer = join(home, ".rotifer");
  vi.stubEnv("HOME", home);
  stderr = [];
  stdout = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => (stderr.push(String(chunk)), true)) as never);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void stdout.push(a.join(" ")));
  vi.mocked(isDaemonRunning).mockResolvedValue(false);
  vi.mocked(loadP2pNode).mockReturnValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});

describe("the notice (T8)", () => {
  it("is pinned to its version", () => {
    expect(createHash("sha256").update(NOTICE_TEMPLATE).digest("hex")).toBe(NOTICE_SHA256[NOTICE_VERSION]);
  });

  it("fills in the counts and the node ID, and says what peers see", () => {
    const text = renderNotice({ bootstrapPeers: 2, rememberedPeers: 5, peerId: "12D3KooWXyz" });
    expect(text).toContain("~/.rotifer/network.json   (now: 2)");
    expect(text).toContain("~/.rotifer/peers.json   (now: 5)");
    expect(text).toContain("this node's ID, 12D3KooWXyz, kept in ~/.rotifer/identity.pem");
    expect(text).toContain("There is no public Rotifer network yet.");
    expect(text).not.toMatch(/\{[A-Z_]+\}/);
    expect(NOTICE_QUESTION).toBe("Allow P2P networking for this account? [y/N] ");
  });

  it("counts distinct remembered peers, and none for a missing or broken store", () => {
    expect(rememberedPeerCount(rotifer)).toBe(0);
    mkdirSync(rotifer, { recursive: true });
    writeFileSync(join(rotifer, "peers.json"), "{oops");
    expect(rememberedPeerCount(rotifer)).toBe(0);
    writeFileSync(join(rotifer, "peers.json"), JSON.stringify(["/a", "/b", "/a", 7]));
    expect(rememberedPeerCount(rotifer)).toBe(2);
  });
});

describe("the consent record (§4)", () => {
  it("is written 0600 with only the notice version, time, CLI version and source", () => {
    writeConsent("flag", "1.2.3", rotifer);
    expect(statSync(consentPath(rotifer)).mode & 0o777).toBe(0o600);
    expect(statSync(join(rotifer, "p2p")).mode & 0o777).toBe(0o700);
    const r = record();
    expect(Object.keys(r).sort()).toEqual(["acceptedAt", "cliVersion", "noticeVersion", "source", "version"]);
    expect(r).toMatchObject({ version: 1, noticeVersion: NOTICE_VERSION, cliVersion: "1.2.3", source: "flag" });
    expect(readConsent(rotifer)?.source).toBe("flag");
  });

  it("counts as no consent when missing, broken, incomplete or for an older notice", () => {
    expect(readConsent(rotifer)).toBeNull();
    mkdirSync(join(rotifer, "p2p"), { recursive: true });
    const good = { version: 1, noticeVersion: NOTICE_VERSION, acceptedAt: "2026-12-01T08:00:00.000Z", source: "prompt" };
    const cases: unknown[] = [
      "{not json",
      null,
      [],
      { ...good, version: 2 },
      { ...good, noticeVersion: NOTICE_VERSION - 1 },
      { ...good, noticeVersion: NOTICE_VERSION + 0.5 },
      { ...good, noticeVersion: String(NOTICE_VERSION) },
      { ...good, acceptedAt: undefined },
      { ...good, acceptedAt: "yesterday" },
      { ...good, source: "env" },
      { ...good, cliVersion: 3 },
    ];
    for (const c of cases) {
      writeFileSync(consentPath(rotifer), typeof c === "string" ? c : JSON.stringify(c));
      expect(readConsent(rotifer), JSON.stringify(c)).toBeNull();
    }
    writeFileSync(consentPath(rotifer), JSON.stringify(good));
    expect(readConsent(rotifer)).not.toBeNull();
  });

  it("only y or yes agrees; Enter alone does not", () => {
    for (const no of ["", " ", "n", "no", "Y es", "sure"]) expect(isYes(no)).toBe(false);
    for (const yes of ["y", "Y", "yes", " YES "]) expect(isYes(yes)).toBe(true);
  });

  it("never asks under --json", () => {
    expect(canAsk(true)).toBe(false);
  });
});

describe("network start without consent, not on a terminal (G1)", () => {
  it("refuses before the native module is touched and makes no node key", async () => {
    await run("start", "-b", "/ip4/127.0.0.1/tcp/1/p2p/12D3KooWBoot");
    expect(process.exitCode).toBe(1);
    expect(display.error).toHaveBeenCalledWith("P2P networking needs your consent first", expect.stringContaining("--accept-p2p"));
    expect(loadNodeIdentity).not.toHaveBeenCalled();
    expect(loadP2pNode).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
    expect(existsSync(consentPath(rotifer))).toBe(false);
  });

  it("prints the §2.2 JSON under --json", async () => {
    vi.mocked(display.isJsonMode).mockReturnValue(true);
    await run("start");
    expect(process.exitCode).toBe(1);
    const out = JSON.parse(stdout.join("\n")) as { ok: boolean; error: { code: string } };
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe("P2P_CONSENT_REQUIRED");
    expect(loadNodeIdentity).not.toHaveBeenCalled();
  });
});

describe("network start --accept-p2p", () => {
  it("writes the key it showed, records source=flag, and leaves the notice on stderr", async () => {
    const identity = fakeIdentity();
    vi.mocked(loadNodeIdentity).mockReturnValue(identity);
    await run("start", "--accept-p2p", "-b", "/ip4/127.0.0.1/tcp/1/p2p/12D3KooWBoot");
    expect(identity.persist).toHaveBeenCalledTimes(1);
    expect(record()).toMatchObject({ source: "flag", cliVersion: "9.9.9" });
    const err = stderr.join("");
    expect(err).toContain("this node's ID, 12D3KooWShown, kept in");
    expect(err).toContain("(now: 1)");
    expect(err).not.toContain(NOTICE_QUESTION.trim());
    // Then it goes on to start: the probe runs.
    expect(loadP2pNode).toHaveBeenCalled();
  });

  it("with a native module older than NodeIdentity: says to upgrade, exits 1, starts nothing", async () => {
    vi.mocked(loadNodeIdentity).mockReturnValue("outdated");
    await run("start", "--accept-p2p");
    expect(process.exitCode).toBe(1);
    expect(display.error).toHaveBeenCalledWith(
      "The native P2P module is older than this CLI",
      expect.stringContaining("needs upgrading to @rotifer/playground 9.9.9"),
    );
    expect(loadP2pNode).not.toHaveBeenCalled();
    expect(runDaemon).not.toHaveBeenCalled();
    expect(existsSync(consentPath(rotifer))).toBe(false);
  });
});

describe("network start with consent recorded", () => {
  it("goes straight on, without asking or touching the identity", async () => {
    writeConsent("prompt", "1.0.0", rotifer);
    await run("start");
    expect(loadNodeIdentity).not.toHaveBeenCalled();
    expect(loadP2pNode).toHaveBeenCalled();
  });
});

describe("network consent", () => {
  it("--accept records source=command and prints the notice to stderr", async () => {
    const identity = fakeIdentity("12D3KooWCmd");
    vi.mocked(loadNodeIdentity).mockReturnValue(identity);
    await run("consent", "--accept");
    expect(record()).toMatchObject({ source: "command" });
    expect(identity.persist).toHaveBeenCalledTimes(1);
    expect(stderr.join("")).toContain("this node's ID, 12D3KooWCmd, kept in");
    expect(runDaemon).not.toHaveBeenCalled();
  });

  it("--accept with an outdated native module records nothing and exits 1", async () => {
    vi.mocked(loadNodeIdentity).mockReturnValue("outdated");
    await run("consent", "--accept");
    expect(process.exitCode).toBe(1);
    expect(existsSync(consentPath(rotifer))).toBe(false);
  });

  it("--show prints the notice without the question and makes no key", async () => {
    const identity = fakeIdentity("12D3KooWNotYet", false);
    vi.mocked(loadNodeIdentity).mockReturnValue(identity);
    await run("consent", "--show");
    const out = stdout.join("\n");
    expect(out).toContain(`this node's ID, ${PEER_ID_NOT_YET}, kept in`);
    expect(out).not.toContain("12D3KooWNotYet");
    expect(out).not.toContain(NOTICE_QUESTION.trim());
    expect(identity.persist).not.toHaveBeenCalled();
    expect(existsSync(consentPath(rotifer))).toBe(false);
  });

  it("--show names the key that is already on disk", async () => {
    vi.mocked(loadNodeIdentity).mockReturnValue(fakeIdentity("12D3KooWOnDisk", true));
    await run("consent", "--show");
    expect(stdout.join("\n")).toContain("this node's ID, 12D3KooWOnDisk, kept in");
  });

  it("--revoke deletes the record, stops the daemon, and keeps the node key and peers", async () => {
    writeConsent("prompt", "1.0.0", rotifer);
    const key = join(rotifer, "identity.pem");
    const peers = join(rotifer, "peers.json");
    writeFileSync(key, "KEY");
    writeFileSync(peers, "[]");
    vi.mocked(controlRequest).mockResolvedValue({ ok: true, status: 200, body: {} });
    await run("consent", "--revoke");
    expect(existsSync(consentPath(rotifer))).toBe(false);
    expect(controlRequest).toHaveBeenCalledWith("POST", "/stop");
    expect(readFileSync(key, "utf-8")).toBe("KEY");
    expect(readFileSync(peers, "utf-8")).toBe("[]");
  });

  it("--status --json reports the record's fields", async () => {
    vi.mocked(display.isJsonMode).mockReturnValue(true);
    await run("consent", "--status");
    expect(JSON.parse(stdout.join(""))).toEqual({ consented: false, noticeVersion: null, acceptedAt: null, source: null });
    stdout = [];
    writeConsent("flag", "1.0.0", rotifer);
    await run("consent", "--status");
    expect(JSON.parse(stdout.join(""))).toMatchObject({ consented: true, noticeVersion: NOTICE_VERSION, source: "flag" });
  });

  it("wants exactly one action", async () => {
    await run("consent");
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    await run("consent", "--accept", "--revoke");
    expect(process.exitCode).toBe(1);
    expect(existsSync(consentPath(rotifer))).toBe(false);
  });
});
