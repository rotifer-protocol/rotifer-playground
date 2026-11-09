/**
 * `rotifer network attest` (ADR-300 revision 2): off until asked for, what the
 * user is told, what the machine-readable output looks like, and that no
 * secret reaches any output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import {
  askYesNo,
  attestCommand,
  attestDisable,
  attestEnable,
  attestRenew,
  attestStatus,
  defaultDeps,
  reportAttest,
  type AttestDeps,
  type AttestOutcome,
} from "../../src/commands/network-attest.js";
import { isDaemonRunning } from "../../src/utils/p2p-daemon.js";
import { PorError, type PorClientDeps } from "../../src/utils/por-client.js";
import { porStatePath, readPorState, writePorState, type PorState } from "../../src/utils/por-keeper.js";
import * as display from "../../src/utils/display.js";

const FN = "http://127.0.0.1:54321/functions/v1/node-attestation";
const PEER = "12D3KooWMe";
const USER = "00000000-0000-4000-8000-000000000001";
const NOW = 1_800_000_000;
const WEEK = 604_800;
// Stand-ins for what must never be printed.
const JWT = "SECRET.SESSION.JWT";
const SUB = "SECRET-ACCOUNT-PSEUDONYM";
const CERT = `header.${SUB}.signature`;
const PRIVATE = "SECRET-PRIVATE-KEY";

const ADR_NOTICE = "你的节点会和一个账号假名关联公开，Cloud 能反查";
const ENGLISH_NOTICE = "publicly linked to an account pseudonym";
const ENGLISH_LIFETIME = "within 7 days";

let home: string;
let path: string;
let fetchFn: ReturnType<typeof vi.fn>;
let carried: (string | null)[];

function fakeNode(peerId = PEER) {
  return {
    peerId: () => peerId,
    signPorChallenge: () => ({ publicKey: "PUB", signature: "SIG" }),
    setAttestation: (t: string | null) => void carried.push(t),
  };
}

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function goodService(peerId = PEER) {
  return async (input: unknown) =>
    String(input).endsWith("/challenge")
      ? reply(200, { nonce: "AAEC", aud: FN, challengeExp: NOW + 60 })
      : reply(200, { token: CERT, peerId, iat: NOW, exp: NOW + WEEK });
}

function deps(over: Partial<AttestDeps> = {}): AttestDeps {
  const client: PorClientDeps = {
    fetch: fetchFn as unknown as typeof fetch,
    session: async () => ({ jwt: JWT, userId: USER }),
    functionUrl: () => FN,
  };
  return {
    statePath: path,
    loadNode: () => fakeNode(),
    client,
    now: () => NOW * 1000,
    isInteractive: () => false,
    confirm: async () => false,
    notify: () => {},
    reloadDaemon: async () => "not_running",
    isDaemonRunning: async () => false,
    ...over,
  };
}

function state(over: Partial<PorState> = {}): PorState {
  return {
    peerId: PEER,
    token: CERT,
    iat: NOW - 3600,
    exp: NOW - 3600 + WEEK,
    lastRenewalAttemptAt: null,
    lastRenewedAt: null,
    lastFailure: null,
    ...over,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as PorError).code;
  }
  return "no error";
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "por-attest-"));
  path = porStatePath(home);
  carried = [];
  fetchFn = vi.fn(goodService());
});

afterEach(() => {
  display.setOutputMode("human");
  process.exitCode = undefined;
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("off until the user turns it on", () => {
  it("reports off, without touching the node or the network", async () => {
    const loadNode = vi.fn(() => fakeNode());
    const out = await attestStatus(deps({ loadNode }));
    expect(out.attestation.state).toBe("off");
    expect(loadNode).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("non-interactive without the flag: enables nothing and says what is missing", async () => {
    const err = (await attestEnable({ accept: false }, deps()).catch((e: Error) => e)) as PorError;
    expect(err.code).toBe("POR_CONSENT_REQUIRED");
    expect(err.fix).toContain("--accept-public-pseudonym");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("non-interactive with the flag: enables, and still states what was agreed to", async () => {
    const out = await attestEnable({ accept: true }, deps());
    expect(out.attestation.state).toBe("active");
    expect(out.notices.join("\n")).toContain(ADR_NOTICE);
    expect(out.notices.join("\n")).toContain("7 天");
  });

  it("interactive: shows the wording and the 7 days before asking", async () => {
    const order: string[] = [];
    const out = await attestEnable(
      { accept: false },
      deps({
        isInteractive: () => true,
        notify: (notices) => void order.push(`notify:${notices.join(" ")}`),
        confirm: async () => {
          order.push("confirm");
          return true;
        },
      }),
    );
    expect(order).toHaveLength(2);
    expect(order[0]).toContain(ADR_NOTICE);
    expect(order[0]).toContain("7 天");
    expect(order[1]).toBe("confirm");
    expect(out.attestation.state).toBe("active");
    expect(out.notices).toEqual([]); // already shown
  });

  it("says the same thing in English, in the same notices", async () => {
    let shown: string[] = [];
    await attestEnable(
      { accept: false },
      deps({
        isInteractive: () => true,
        notify: (notices) => void (shown = notices),
        confirm: async () => true,
      }),
    );
    const consent = shown.find((n) => n.includes(ADR_NOTICE));
    expect(consent).toContain(ENGLISH_NOTICE);
    const lifetime = shown.find((n) => n.includes("7 天"));
    expect(lifetime).toContain(ENGLISH_LIFETIME);
  });

  it("interactive and declined: enables nothing", async () => {
    const d = deps({ isInteractive: () => true, confirm: async () => false });
    expect(await codeOf(attestEnable({ accept: false }, d))).toBe("POR_CONSENT_DECLINED");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("does not ask for agreement before finding out the user is not signed in", async () => {
    const confirm = vi.fn(async () => true);
    const d = deps({ isInteractive: () => true, confirm });
    d.client.session = async () => {
      throw new PorError("POR_NOT_LOGGED_IN");
    };
    expect(await codeOf(attestEnable({ accept: false }, d))).toBe("POR_NOT_LOGGED_IN");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("enable", () => {
  it("stores the certificate privately, puts it in the node and tells a running daemon", async () => {
    const reloadDaemon = vi.fn(async () => "loaded" as const);
    const out = await attestEnable({ accept: true }, deps({ reloadDaemon }));
    expect(readPorState(path)?.token).toBe(CERT);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(carried).toEqual([CERT]);
    expect(reloadDaemon).toHaveBeenCalledTimes(1);
    expect(out.daemon).toBe("loaded");
  });

  it("does not store a certificate the node refuses", async () => {
    const node = fakeNode();
    node.setAttestation = () => {
      throw new Error("attestation is for another PeerId");
    };
    expect(await codeOf(attestEnable({ accept: true }, deps({ loadNode: () => node })))).toBe("POR_BAD_RESPONSE");
    expect(existsSync(path)).toBe(false);
  });

  it("does nothing when this node already has a live certificate", async () => {
    writePorState(path, state());
    const out = await attestEnable({ accept: false }, deps());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(out.attestation.state).toBe("active");
  });

  it("gets a new one for an expired certificate without asking again", async () => {
    writePorState(path, state({ exp: NOW }));
    const out = await attestEnable({ accept: false }, deps());
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(out.attestation.expiresAt).toBe(NOW + WEEK);
  });
});

describe("status and the daemon", () => {
  it("says running when a daemon answers", async () => {
    const out = await attestStatus(deps({ isDaemonRunning: async () => true }));
    expect(out.daemon).toBe("running");
  });

  it("says not_running when none does", async () => {
    const out = await attestStatus(deps({ isDaemonRunning: async () => false }));
    expect(out.daemon).toBe("not_running");
  });

  it("asks the real daemon, not a fixed answer", () => {
    expect(defaultDeps().isDaemonRunning).toBe(isDaemonRunning);
  });
});

describe("after a key change", () => {
  const newKey = () => fakeNode("12D3KooWNew");

  it("status says so: re-attest, and the old certificate is not voided", async () => {
    writePorState(path, state());
    const out = await attestStatus(deps({ loadNode: newKey }));
    expect(out.attestation.state).toBe("key_changed");
    const text = out.notices.join("\n");
    expect(text).toContain("rotifer network attest enable");
    expect(text).toContain("not voided");
    expect(text).toContain("at most 7 days");
  });

  it("enable asks again, because a new key is a new node to link", async () => {
    writePorState(path, state());
    expect(await codeOf(attestEnable({ accept: false }, deps({ loadNode: newKey })))).toBe("POR_CONSENT_REQUIRED");
    expect(readPorState(path)?.peerId).toBe(PEER);
  });

  it("enable then repeats that the old certificate was not voided", async () => {
    writePorState(path, state());
    fetchFn = vi.fn(goodService("12D3KooWNew"));
    const out = await attestEnable({ accept: true }, deps({ loadNode: newKey }));
    expect(out.notices.join("\n")).toContain("not voided");
    expect(readPorState(path)?.peerId).toBe("12D3KooWNew");
  });

  it("renew refuses and says what to do", async () => {
    writePorState(path, state());
    expect(await codeOf(attestRenew(deps({ loadNode: newKey })))).toBe("POR_KEY_CHANGED");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("renew and disable", () => {
  it("renew needs certificates to be on", async () => {
    expect(await codeOf(attestRenew(deps()))).toBe("POR_NOT_ENABLED");
  });

  it("renew replaces the certificate", async () => {
    writePorState(path, state({ iat: NOW - 6 * 86_400, exp: NOW + 86_400 }));
    const out = await attestRenew(deps());
    expect(out.attestation.expiresAt).toBe(NOW + WEEK);
  });

  it("disable removes it, tells the daemon, and says it is not voided", async () => {
    writePorState(path, state());
    const reloadDaemon = vi.fn(async () => "loaded" as const);
    const out = await attestDisable(deps({ reloadDaemon }));
    expect(existsSync(path)).toBe(false);
    expect(reloadDaemon).toHaveBeenCalledTimes(1);
    expect(out.attestation.state).toBe("off");
    expect(out.notices.join("\n")).toContain("not voided");
    expect(out.notices.join("\n")).toContain("at most 7 days");
  });

  it("disable with nothing on has nothing to warn about", async () => {
    expect((await attestDisable(deps())).notices).toEqual([]);
  });
});

describe("older or missing native addons", () => {
  it.each([
    ["without the methods", () => ({ peerId: () => PEER })],
    ["missing altogether", () => null],
  ])("enable reports an addon %s", async (_what, loadNode) => {
    const err = (await attestEnable({ accept: true }, deps({ loadNode })).catch((e: Error) => e)) as PorError;
    expect(err.code).toBe("POR_CLIENT_NEEDS_UPGRADE");
    expect(err.fix).toContain("self-update");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("renew reports it too", async () => {
    writePorState(path, state());
    expect(await codeOf(attestRenew(deps({ loadNode: () => ({ peerId: () => PEER }) })))).toBe("POR_CLIENT_NEEDS_UPGRADE");
  });

  it("status still works without an addon", async () => {
    writePorState(path, state());
    expect((await attestStatus(deps({ loadNode: () => null }))).attestation.state).toBe("active");
  });
});

describe("failures, as the user sees them", () => {
  function capture() {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void lines.push(a.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    return lines;
  }

  const refuse = (status: number, code: string) => async () => reply(status, { error: { code, message: `leak ${JWT} ${SUB}` } });

  const CASES: [string, () => void, string, string][] = [
    ["not signed in", () => void 0, "POR_NOT_LOGGED_IN", "rotifer login"],
    ["session expired", () => (fetchFn = vi.fn(refuse(401, "POR_UNAUTHENTICATED"))), "POR_SESSION_EXPIRED", "rotifer login"],
    ["quota used up", () => (fetchFn = vi.fn(refuse(409, "POR_QUOTA_EXCEEDED"))), "POR_QUOTA_EXCEEDED", "3 nodes"],
    ["too early", () => (fetchFn = vi.fn(refuse(409, "POR_RENEWAL_TOO_EARLY"))), "POR_RENEWAL_TOO_EARLY", "24 hours"],
    [
      "function missing",
      () => (fetchFn = vi.fn(async () => reply(404, '{"code":"NOT_FOUND","message":"Requested function was not found"}'))),
      "POR_SERVICE_NOT_OPEN",
      "not open yet",
    ],
    ["proxy's 404 page", () => (fetchFn = vi.fn(async () => reply(404, "<html>nope</html>"))), "POR_SERVICE_NOT_OPEN", "not open yet"],
    ["function not configured", () => (fetchFn = vi.fn(refuse(503, "POR_NOT_CONFIGURED"))), "POR_SERVICE_NOT_OPEN", "not open yet"],
  ];

  function failing(name: string): AttestDeps {
    const d = deps();
    if (name === "not signed in") {
      d.client.session = async () => {
        throw new PorError("POR_NOT_LOGGED_IN");
      };
    }
    return d;
  }

  it.each(CASES)("%s: human output is the message and the fix, no stack", async (name, arrange, _code, words) => {
    arrange();
    const lines = capture();
    await reportAttest("enable", () => attestEnable({ accept: true }, failing(name)));
    const out = lines.join("\n");
    expect(out).toContain(words);
    expect(out).not.toMatch(/\n\s+at /);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain(SUB);
    expect(process.exitCode).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it.each(CASES)("%s: --json is { ok, action, error: { code, message, fix } }", async (name, arrange, code) => {
    arrange();
    display.setOutputMode("json");
    const lines = capture();
    await reportAttest("enable", () => attestEnable({ accept: true }, failing(name)));
    const parsed = JSON.parse(lines.join("")) as Record<string, any>;
    expect(Object.keys(parsed).sort()).toEqual(["action", "error", "ok"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.action).toBe("enable");
    expect(Object.keys(parsed.error).sort()).toEqual(["code", "fix", "message"]);
    expect(parsed.error.code).toBe(code);
    expect(parsed.error.fix.length).toBeGreaterThan(0);
  });

  it("an unexpected exception becomes fixed text", async () => {
    const lines = capture();
    await reportAttest("status", async () => {
      throw new Error(`boom ${JWT} ${PRIVATE}`);
    });
    expect(lines.join("\n")).not.toContain(JWT);
    expect(lines.join("\n")).not.toContain(PRIVATE);
    expect(process.exitCode).toBe(1);
  });
});

describe("what is printed on success", () => {
  function run(arrange: () => Promise<AttestOutcome>, json: boolean) {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void lines.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void lines.push(a.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    if (json) display.setOutputMode("json");
    return reportAttest("enable", arrange).then(() => lines);
  }

  it.each([false, true])("never includes the certificate, the pseudonym or the session (json: %s)", async (json) => {
    const lines = await run(() => attestEnable({ accept: true }, deps()), json);
    const out = lines.join("\n");
    expect(out).not.toContain(CERT);
    expect(out).not.toContain(SUB);
    expect(out).not.toContain(JWT);
    expect(out).not.toContain(USER);
  });

  it("--json has one stable shape", async () => {
    const lines = await run(() => attestEnable({ accept: true }, deps()), true);
    const parsed = JSON.parse(lines.join("")) as Record<string, any>;
    expect(Object.keys(parsed).sort()).toEqual(["action", "attestation", "daemon", "notices", "ok"]);
    expect(Object.keys(parsed.attestation).sort()).toEqual([
      "autoRenew",
      "expiresAt",
      "expiresInSeconds",
      "issuedAt",
      "lastFailure",
      "lastRenewalAttemptAt",
      "lastRenewedAt",
      "peerId",
      "state",
    ]);
    expect(parsed.attestation).toMatchObject({ state: "active", peerId: PEER, expiresAt: NOW + WEEK, expiresInSeconds: WEEK });
  });

  it("the state file holds the certificate; nothing else about the account", async () => {
    await attestEnable({ accept: true }, deps());
    const text = readFileSync(path, "utf-8");
    expect(text).not.toContain(JWT);
    expect(text).not.toContain(USER);
  });
});

describe("the yes-or-no prompt", () => {
  async function answer(typed: string | null): Promise<boolean> {
    const input = new PassThrough();
    const asked = askYesNo("Enable?", input, new PassThrough());
    if (typed === null) input.end();
    else input.write(typed);
    return asked;
  }

  it.each(["y\n", "Y\n", "yes\n", " YES \n"])("takes %j as a yes", async (typed) => {
    expect(await answer(typed)).toBe(true);
  });

  it.each(["n\n", "\n", "yep\n", "no\n"])("takes %j as a no", async (typed) => {
    expect(await answer(typed)).toBe(false);
  });

  it("takes the end of the input as a no, not a failure", async () => {
    expect(await answer(null)).toBe(false);
  });
});

describe("help", () => {
  const helpOf = (name: string) => {
    const cmd = attestCommand.commands.find((c) => c.name() === name)!;
    let text = "";
    cmd.configureOutput({ writeOut: (s) => (text += s) });
    cmd.outputHelp();
    return text;
  };

  it("states how long a banned account's certificate can last", () => {
    const text = helpOf("enable");
    expect(text).toContain("banned");
    expect(text).toContain("within about 24 hours");
    expect(text).toContain("at most 7 days");
  });

  it("states what is made public", () => {
    expect(helpOf("enable")).toContain(ADR_NOTICE);
  });
});
