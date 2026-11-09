/**
 * Automatic renewal (ADR-300 revision 2): when it fires, what a failure leaves
 * behind, and the state file. The clock is injected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  isRenewalDue,
  PorKeeper,
  porStatePath,
  readPorState,
  viewOf,
  writePorState,
  type PorState,
} from "../../src/utils/por-keeper.js";
import { KEY_CHANGE_NOTICE, PorError, type PorCapableNode, type PorCertificate } from "../../src/utils/por-client.js";

// The contract's numbers, written out: changing the module's constants turns these red.
const HOURS_48 = 172_800;
const HOUR_MS = 3_600_000;
const PEER = "12D3KooWMe";
const EXP = 1_800_000_000;
const TOKEN = "OLD.CERTIFICATE.TOKEN";

let home: string;
let path: string;
let clockS: number;
let carried: (string | null)[];
let logs: string[];
let obtain: ReturnType<typeof vi.fn<(n: PorCapableNode) => Promise<PorCertificate>>>;

function node(peerId = PEER): PorCapableNode {
  return {
    peerId: () => peerId,
    signPorChallenge: () => ({ publicKey: "", signature: "" }),
    setAttestation: (t) => void carried.push(t),
  };
}

function keeper(n = node()): PorKeeper {
  return new PorKeeper({ path, node: n, obtain, now: () => clockS * 1000, log: (l) => logs.push(l) });
}

function state(over: Partial<PorState> = {}): PorState {
  return {
    peerId: PEER,
    token: TOKEN,
    iat: EXP - 604_800,
    exp: EXP,
    lastRenewalAttemptAt: null,
    lastRenewedAt: null,
    lastFailure: null,
    ...over,
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "por-keeper-"));
  path = porStatePath(home);
  clockS = EXP - 3 * 86_400;
  carried = [];
  logs = [];
  obtain = vi.fn(async () => ({ token: "NEW.TOKEN", peerId: PEER, iat: clockS, exp: clockS + 604_800 }));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("isRenewalDue", () => {
  it("fires under 48 hours left, and not at 48 hours exactly", () => {
    expect(isRenewalDue(EXP, EXP - HOURS_48 - 1)).toBe(false);
    expect(isRenewalDue(EXP, EXP - HOURS_48)).toBe(false);
    expect(isRenewalDue(EXP, EXP - HOURS_48 + 1)).toBe(true);
    expect(isRenewalDue(EXP, EXP + 1)).toBe(true);
  });
});

describe("the state file", () => {
  it("is private", () => {
    writePorState(path, state());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("reads back what was written", () => {
    writePorState(path, state());
    expect(readPorState(path)).toEqual(state());
  });

  it.each(["not json", "{}", '{"peerId":"p","token":1,"iat":1,"exp":2}'])("treats %s as no certificate", (text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    expect(readPorState(path)).toBeNull();
  });

  it("is absent by default, which reads as off", () => {
    expect(readPorState(path)).toBeNull();
    expect(viewOf(null, PEER, EXP).state).toBe("off");
  });
});

describe("viewOf", () => {
  it("names each state", () => {
    expect(viewOf(state(), PEER, EXP - 1).state).toBe("active");
    expect(viewOf(state(), PEER, EXP).state).toBe("expired");
    expect(viewOf(state(), "12D3KooWNew", EXP - 1).state).toBe("key_changed");
    expect(viewOf(state(), null, EXP - 1).state).toBe("active");
  });

  it("does not offer to renew a certificate for another key", () => {
    expect(viewOf(state(), PEER, EXP - 1).autoRenew).toBe(true);
    expect(viewOf(state(), "12D3KooWNew", EXP - 1).autoRenew).toBe(false);
  });

  it("never carries the token", () => {
    expect(JSON.stringify(viewOf(state(), PEER, EXP - 1))).not.toContain(TOKEN);
  });
});

describe("PorKeeper", () => {
  it("loads a live certificate into the node", () => {
    writePorState(path, state());
    keeper().reload();
    expect(carried).toEqual([TOKEN]);
  });

  it("does nothing when certificates are off", async () => {
    const k = keeper();
    k.reload();
    await k.tick();
    expect(carried).toEqual([null]);
    expect(obtain).not.toHaveBeenCalled();
  });

  it("does not renew at 48 hours exactly", async () => {
    writePorState(path, state());
    clockS = EXP - HOURS_48;
    await keeper().tick();
    expect(obtain).not.toHaveBeenCalled();
  });

  it("renews one second later, for the same node, and starts carrying the new one", async () => {
    writePorState(path, state());
    clockS = EXP - HOURS_48 + 1;
    const n = node();
    await keeper(n).tick();
    expect(obtain).toHaveBeenCalledTimes(1);
    expect(obtain.mock.calls[0][0]).toBe(n);
    expect(carried).toEqual(["NEW.TOKEN"]);
    const after = readPorState(path)!;
    expect(after.token).toBe("NEW.TOKEN");
    expect(after.peerId).toBe(PEER);
    expect(after.lastRenewedAt).toBe(clockS * 1000);
    expect(after.lastFailure).toBeNull();
  });

  describe("when renewal fails", () => {
    beforeEach(() => {
      writePorState(path, state());
      clockS = EXP - 3600;
      obtain.mockRejectedValue(new PorError("POR_SESSION_EXPIRED"));
    });

    it("keeps the node running on its current certificate and shows the failure", async () => {
      await expect(keeper().tick()).resolves.toBeUndefined();
      expect(carried).toEqual([]);
      const after = readPorState(path)!;
      expect(after.token).toBe(TOKEN);
      expect(after.lastFailure?.code).toBe("POR_SESSION_EXPIRED");
      expect(after.lastFailure?.fix).toContain("rotifer login");
      expect(after.lastRenewalAttemptAt).toBe(clockS * 1000);
      expect(viewOf(after, PEER, clockS).lastFailure?.code).toBe("POR_SESSION_EXPIRED");
    });

    it("survives an unexpected exception and does not record its text", async () => {
      obtain.mockRejectedValue(new Error("boom SECRET.SESSION.JWT"));
      await expect(keeper().tick()).resolves.toBeUndefined();
      expect(readPorState(path)!.lastFailure?.code).toBe("POR_CLIENT_ERROR");
      expect(readFileSync(path, "utf-8")).not.toContain("SECRET.SESSION.JWT");
      expect(logs.join("\n")).not.toContain("SECRET.SESSION.JWT");
    });

    it("waits an hour before trying again", async () => {
      const k = keeper();
      await k.tick();
      clockS += 3599;
      await k.tick();
      expect(obtain).toHaveBeenCalledTimes(1);
      clockS += 1;
      await k.tick();
      expect(obtain).toHaveBeenCalledTimes(2);
    });

    it("clears the failure when a later try works", async () => {
      const k = keeper();
      await k.tick();
      obtain.mockResolvedValue({ token: "NEW.TOKEN", peerId: PEER, iat: clockS, exp: clockS + 604_800 });
      clockS += HOUR_MS / 1000;
      await k.tick();
      expect(readPorState(path)!.lastFailure).toBeNull();
    });

    it("does not bring back a certificate disabled during the round", async () => {
      obtain.mockImplementation(async () => {
        rmSync(path);
        throw new PorError("POR_UNREACHABLE");
      });
      await keeper().tick();
      expect(existsSync(path)).toBe(false);
    });
  });

  it("does not bring back a certificate disabled while a renewal was succeeding", async () => {
    writePorState(path, state());
    clockS = EXP - 3600;
    obtain.mockImplementation(async () => {
      rmSync(path);
      return { token: "NEW.TOKEN", peerId: PEER, iat: clockS, exp: clockS + 604_800 };
    });
    const k = keeper();
    await k.tick();
    expect(existsSync(path)).toBe(false);
    expect(carried).not.toContain("NEW.TOKEN");
    expect(k.view().state).toBe("off");
  });

  it("a state file it cannot write does not escape the tick, and later ticks still run", async () => {
    writePorState(path, state());
    clockS = EXP - 7200;
    // A directory where the temporary file goes: a real write failure, as any user.
    const blocker = `${path}.${process.pid}.tmp`;
    mkdirSync(blocker);
    const k = keeper();
    await expect(k.tick()).resolves.toBeUndefined();
    expect(logs.join("\n")).toContain("renewal check failed");

    rmSync(blocker, { recursive: true });
    clockS += HOUR_MS / 1000;
    await k.tick();
    expect(readPorState(path)!.token).toBe("NEW.TOKEN");
  });

  it("does not store a certificate the node refused", async () => {
    writePorState(path, state());
    clockS = EXP - 3600;
    const n = node();
    n.setAttestation = () => {
      throw new Error("attestation is for another PeerId");
    };
    await keeper(n).tick();
    const after = readPorState(path)!;
    expect(after.token).toBe(TOKEN);
    expect(after.lastFailure?.code).toBe("POR_BAD_RESPONSE");
  });

  it("stops carrying a certificate once it has expired, and still tries to renew", async () => {
    writePorState(path, state());
    clockS = EXP;
    obtain.mockRejectedValue(new PorError("POR_UNREACHABLE"));
    await keeper().tick();
    expect(carried).toEqual([null]);
    expect(obtain).toHaveBeenCalledTimes(1);
  });

  it("does not carry an expired certificate after a restart", () => {
    writePorState(path, state());
    clockS = EXP + 1;
    keeper().reload();
    expect(carried).toEqual([null]);
  });

  it("after a key change: carries nothing, renews nothing, says what to do", async () => {
    writePorState(path, state());
    clockS = EXP - 3600;
    const k = keeper(node("12D3KooWNew"));
    k.reload();
    await k.tick();
    expect(carried).toEqual([null]);
    expect(obtain).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain(KEY_CHANGE_NOTICE);
    expect(k.view().state).toBe("key_changed");
  });

  it("does not overlap rounds", async () => {
    writePorState(path, state());
    clockS = EXP - 3600;
    let finish: () => void = () => {};
    obtain.mockImplementation(
      () =>
        new Promise((res) => {
          finish = () => res({ token: "NEW.TOKEN", peerId: PEER, iat: clockS, exp: clockS + 604_800 });
        }),
    );
    const k = keeper();
    const first = k.tick();
    await k.tick();
    expect(obtain).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });

  it("logs only codes and fixed text", async () => {
    writePorState(path, state());
    clockS = EXP - 3600;
    await keeper().tick();
    expect(logs.join("\n")).not.toContain("NEW.TOKEN");
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
});
