/**
 * G2 (T-237 design §1.3): `runDaemon` without a consent record stops before
 * it loads the native node at all, whatever started it (`network __daemon`
 * run directly, `start --foreground`).
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

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "rotifer-daemon-consent-"));
  vi.stubEnv("HOME", home);
  loadP2pNode.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("runDaemon without consent", () => {
  it("exits 1 with the §2.4 line before the native node is loaded", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    const daemon = await import("../../src/utils/p2p-daemon.js");
    await expect(daemon.runDaemon("127.0.0.1", 0, [], false, { foreground: true })).rejects.toThrow("exit 1");
    expect(exit).toHaveBeenCalledWith(1);
    expect(loadP2pNode).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => String(c[0])).join("")).toContain(
      "P2P daemon not started: no consent recorded in ~/.rotifer/p2p/consent.json.",
    );
  });

  it("goes on to load the node once consent is recorded", async () => {
    const { writeConsent } = await import("../../src/utils/p2p-consent.js");
    writeConsent("command", "1.0.0", join(home, ".rotifer"));
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    loadP2pNode.mockReturnValue(null); // "unavailable": exits right after the load
    const daemon = await import("../../src/utils/p2p-daemon.js");
    await expect(daemon.runDaemon("127.0.0.1", 0, [], false)).rejects.toThrow("exit 1");
    expect(loadP2pNode).toHaveBeenCalledTimes(1);
  });
});
