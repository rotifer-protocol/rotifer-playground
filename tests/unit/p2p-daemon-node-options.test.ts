/**
 * The daemon with `--relay` and the other node options on an addon that
 * predates them (T-231 PR-②): such an addon ignores the options, so the
 * daemon must refuse to start rather than run without the relay settings.
 * A fake native node stands in for the old addon.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loadP2pNode = vi.fn();
vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  loadP2pNode,
}));

let home: string;
let started: number;

function oldNode() {
  return {
    start: () => void started++,
    stop: () => {},
    peerId: () => "12D3KooWOld",
    listenAddrs: () => [],
    discoveredPeers: () => [],
    receivedAnnouncements: () => [],
  };
}

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "rotifer-daemon-options-"));
  vi.stubEnv("HOME", home);
  started = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("runDaemon on an addon without node options", () => {
  it("refuses relay settings instead of dropping them", async () => {
    loadP2pNode.mockReturnValue(oldNode());
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const daemon = await import("../../src/utils/p2p-daemon.js");
    await expect(
      daemon.runDaemon("127.0.0.1", 0, [], false, { node: { relays: ["/ip4/203.0.113.7/tcp/9878/p2p/12D3KooWRelay"] } }),
    ).rejects.toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(started).toBe(0);
    expect(err.mock.calls.flat().join("")).toContain("predates --relay");
    // The settings reach the addon as its sixth argument all the same.
    expect(loadP2pNode.mock.calls[0][4]).toEqual({ relays: ["/ip4/203.0.113.7/tcp/9878/p2p/12D3KooWRelay"] });
  });
});
