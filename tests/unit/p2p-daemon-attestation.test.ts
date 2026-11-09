/**
 * The daemon's side of certificates, over its real control server with a fake
 * native node: it loads the certificate at start, reports it, picks up what
 * `attest` changes, and copes with an addon that cannot hold one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { porStatePath, removePorState, writePorState } from "../../src/utils/por-keeper.js";

const loadP2pNode = vi.fn();
vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  loadP2pNode,
}));

const PEER = "12D3KooWMe";
const TOKEN = "A.DAEMON.CERTIFICATE";
const NOW_S = Math.floor(Date.now() / 1000);

let home: string;
let carried: (string | null)[];

function plainNode() {
  return {
    start: () => {},
    stop: () => {},
    peerId: () => PEER,
    listenAddrs: () => [],
    discoveredPeers: () => [],
    receivedAnnouncements: () => [],
  };
}

function capableNode() {
  return {
    ...plainNode(),
    signPorChallenge: () => ({ publicKey: "", signature: "" }),
    setAttestation: (t: string | null) => void carried.push(t),
  };
}

async function startDaemon(node: unknown) {
  loadP2pNode.mockReturnValue(node);
  const daemon = await import("../../src/utils/p2p-daemon.js");
  await daemon.runDaemon("127.0.0.1", 0, [], false);
  return daemon;
}

function liveState() {
  return {
    peerId: PEER,
    token: TOKEN,
    iat: NOW_S - 60,
    exp: NOW_S + 6 * 86_400,
    lastRenewalAttemptAt: null,
    lastRenewedAt: null,
    lastFailure: null,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "por-daemon-"));
  carried = [];
  vi.stubEnv("HOME", home);
  vi.resetModules();
  vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
});

afterEach(async () => {
  const daemon = await import("../../src/utils/p2p-daemon.js");
  await daemon.controlRequest("POST", "/stop");
  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("a daemon with a certificate on disk", () => {
  it("carries it from the start and reports it without the token", async () => {
    writePorState(porStatePath(join(home, ".rotifer")), liveState());
    const { controlRequest } = await startDaemon(capableNode());
    expect(carried).toEqual([TOKEN]);
    const status = await controlRequest("GET", "/status");
    const body = status?.body as { attestation: { state: string; peerId: string } };
    expect(body.attestation.state).toBe("active");
    expect(body.attestation.peerId).toBe(PEER);
    expect(JSON.stringify(status?.body)).not.toContain(TOKEN);
  });

  it("drops it when `attest disable` asks", async () => {
    const path = porStatePath(join(home, ".rotifer"));
    writePorState(path, liveState());
    const { controlRequest } = await startDaemon(capableNode());
    removePorState(path);
    const reload = await controlRequest("POST", "/attestation/reload");
    expect(reload?.ok).toBe(true);
    expect(carried).toEqual([TOKEN, null]);
    expect(JSON.stringify(reload?.body)).not.toContain(TOKEN);
  });
});

describe("a daemon with certificates off", () => {
  it("carries nothing and picks one up when `attest enable` asks", async () => {
    const { controlRequest } = await startDaemon(capableNode());
    expect(carried).toEqual([null]);
    expect((await controlRequest("GET", "/status"))?.body).toMatchObject({ attestation: { state: "off" } });
    writePorState(porStatePath(join(home, ".rotifer")), liveState());
    await controlRequest("POST", "/attestation/reload");
    expect(carried).toEqual([null, TOKEN]);
  });
});

describe("a daemon on an older addon", () => {
  it("runs, leaves the field out, and says it cannot load one", async () => {
    const { controlRequest } = await startDaemon(plainNode());
    const status = await controlRequest("GET", "/status");
    expect(status?.ok).toBe(true);
    expect(status?.body).not.toHaveProperty("attestation");
    const reload = await controlRequest("POST", "/attestation/reload");
    expect(reload?.status).toBe(501);
  });
});
