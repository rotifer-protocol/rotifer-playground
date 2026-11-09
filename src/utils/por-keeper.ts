/**
 * The node's certificate on disk, and the daemon's job of keeping it fresh
 * (ADR-300 revision 2).
 *
 * `~/.rotifer/p2p/attestation.json` (mode 0600) exists only while certificates
 * are enabled. Its absence is the default: off.
 *
 * Renewal timing is decided in one place, `isRenewalDue`. The service has its
 * own too-early rule (at most one reissue a day unless under 48 h remain); a
 * node that waits for `isRenewalDue` never meets it.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDir, tightenPrivateFile } from "./private-fs.js";
import {
  asPorError,
  KEY_CHANGE_NOTICE,
  PorError,
  type PorCapableNode,
  type PorCertificate,
  type PorErrorCode,
} from "./por-client.js";

export const RENEW_WHEN_REMAINING_S = 48 * 3600;
/** How often the daemon looks at the certificate. */
export const RENEW_CHECK_MS = 10 * 60 * 1000;
/** How long the daemon waits after a failed renewal; at most 48 tries before expiry. */
export const RENEW_RETRY_MS = 60 * 60 * 1000;

/** The one judgement of when a certificate should be renewed. */
export function isRenewalDue(expS: number, nowS: number): boolean {
  return expS - nowS < RENEW_WHEN_REMAINING_S;
}

export interface PorFailure {
  code: PorErrorCode;
  message: string;
  fix: string;
}

export interface PorState {
  peerId: string;
  token: string;
  iat: number;
  exp: number;
  lastRenewalAttemptAt: number | null;
  lastRenewedAt: number | null;
  lastFailure: PorFailure | null;
}

export function porStatePath(rotiferHome: string): string {
  return join(rotiferHome, "p2p", "attestation.json");
}

function isPorState(v: unknown): v is PorState {
  const s = v as PorState | null;
  return (
    typeof s === "object" &&
    s !== null &&
    typeof s.peerId === "string" &&
    typeof s.token === "string" &&
    typeof s.iat === "number" &&
    typeof s.exp === "number"
  );
}

export function readPorState(path: string): PorState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isPorState(parsed)) return null;
    return {
      ...parsed,
      lastRenewalAttemptAt: parsed.lastRenewalAttemptAt ?? null,
      lastRenewedAt: parsed.lastRenewedAt ?? null,
      lastFailure: parsed.lastFailure ?? null,
    };
  } catch {
    return null;
  }
}

export function writePorState(path: string, state: PorState): void {
  ensurePrivateDir(dirname(path));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  tightenPrivateFile(tmp);
  renameSync(tmp, path);
  tightenPrivateFile(path);
}

export function removePorState(path: string): void {
  rmSync(path, { force: true });
}

/** State for a fresh certificate, recording when it was obtained. */
export function stateFor(cert: PorCertificate, nowMs: number): PorState {
  return {
    peerId: cert.peerId,
    token: cert.token,
    iat: cert.iat,
    exp: cert.exp,
    lastRenewalAttemptAt: nowMs,
    lastRenewedAt: nowMs,
    lastFailure: null,
  };
}

/** `active`, `expired`, `key_changed` or `off`; each name means only that. */
export type PorStateName = "off" | "active" | "expired" | "key_changed";

/** What is safe to show or print: never the token. */
export interface PorView {
  state: PorStateName;
  /** The PeerId the certificate is for. */
  peerId: string | null;
  issuedAt: number | null;
  expiresAt: number | null;
  /** Seconds left; 0 once expired; null without a certificate. */
  expiresInSeconds: number | null;
  /** Whether a running daemon will renew this certificate. */
  autoRenew: boolean;
  lastRenewalAttemptAt: number | null;
  lastRenewedAt: number | null;
  lastFailure: PorFailure | null;
}

const OFF: PorView = {
  state: "off",
  peerId: null,
  issuedAt: null,
  expiresAt: null,
  expiresInSeconds: null,
  autoRenew: false,
  lastRenewalAttemptAt: null,
  lastRenewedAt: null,
  lastFailure: null,
};

/** `nodePeerId` is null when no native node is at hand to compare with. */
export function viewOf(state: PorState | null, nodePeerId: string | null, nowS: number): PorView {
  if (!state) return OFF;
  const isKeyChanged = nodePeerId !== null && nodePeerId !== state.peerId;
  const remaining = Math.max(0, state.exp - nowS);
  return {
    state: isKeyChanged ? "key_changed" : remaining > 0 ? "active" : "expired",
    peerId: state.peerId,
    issuedAt: state.iat,
    expiresAt: state.exp,
    expiresInSeconds: remaining,
    autoRenew: !isKeyChanged,
    lastRenewalAttemptAt: state.lastRenewalAttemptAt,
    lastRenewedAt: state.lastRenewedAt,
    lastFailure: state.lastFailure,
  };
}

export interface PorKeeperDeps {
  path: string;
  node: PorCapableNode;
  /** One full challenge round: the same one enabling uses. */
  obtain: (node: PorCapableNode) => Promise<PorCertificate>;
  /** Milliseconds since the epoch. */
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Keeps a running node's certificate loaded and fresh. A failure is recorded
 * where `status` shows it and tried again later; nothing it does can stop the
 * node, and a failed renewal leaves the current certificate in use.
 */
export class PorKeeper {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private isTicking = false;
  private retryAfterMs = 0;
  private hasWarnedKeyChange = false;

  constructor(private readonly deps: PorKeeperDeps) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
  }

  start(): void {
    this.reload();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), RENEW_CHECK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private nowS(): number {
    return Math.floor(this.now() / 1000);
  }

  private setToken(token: string | null): boolean {
    try {
      this.deps.node.setAttestation(token);
      return true;
    } catch {
      return false;
    }
  }

  /** Apply what is on disk: after `start`, and when `attest` changed it. */
  reload(): PorView {
    this.retryAfterMs = 0;
    const state = readPorState(this.deps.path);
    const nodePeerId = this.deps.node.peerId();
    const view = viewOf(state, nodePeerId, this.nowS());
    if (view.state === "active" && state) {
      if (!this.setToken(state.token)) this.log("attestation: the stored certificate could not be loaded");
    } else {
      this.setToken(null);
    }
    if (view.state === "key_changed" && !this.hasWarnedKeyChange) {
      this.hasWarnedKeyChange = true;
      this.log(`attestation: ${KEY_CHANGE_NOTICE}`);
    }
    return view;
  }

  view(): PorView {
    return viewOf(readPorState(this.deps.path), this.deps.node.peerId(), this.nowS());
  }

  /** Stop carrying a lapsed certificate, and renew one that is due. */
  async tick(): Promise<void> {
    if (this.isTicking) return;
    this.isTicking = true;
    try {
      await this.renewIfDue();
    } catch (err) {
      // State-file trouble and the like: the node runs on regardless.
      this.log(`attestation: renewal check failed (${asPorError(err).code})`);
    } finally {
      this.isTicking = false;
    }
  }

  private async renewIfDue(): Promise<void> {
    const state = readPorState(this.deps.path);
    if (!state || state.peerId !== this.deps.node.peerId()) return;
    if (state.exp <= this.nowS()) this.setToken(null);
    if (!isRenewalDue(state.exp, this.nowS()) || this.now() < this.retryAfterMs) return;

    let failure: PorError;
    try {
      const cert = await this.deps.obtain(this.deps.node);
      // `attest disable` may have run during the round: its choice stands.
      if (!readPorState(this.deps.path)) {
        this.log("attestation: certificates were turned off during renewal; the new one was dropped");
        return;
      }
      if (this.setToken(cert.token)) {
        writePorState(this.deps.path, stateFor(cert, this.now()));
        this.retryAfterMs = 0;
        this.log("attestation: certificate renewed");
        return;
      }
      failure = new PorError("POR_BAD_RESPONSE");
    } catch (err) {
      failure = asPorError(err);
    }
    this.retryAfterMs = this.now() + RENEW_RETRY_MS;
    this.log(`attestation: renewal failed (${failure.code}); will retry`);
    // Read again: `attest disable` may have run during the round.
    const latest = readPorState(this.deps.path);
    if (latest) {
      writePorState(this.deps.path, {
        ...latest,
        lastRenewalAttemptAt: this.now(),
        lastFailure: { code: failure.code, message: failure.message, fix: failure.fix },
      });
    }
  }
}
