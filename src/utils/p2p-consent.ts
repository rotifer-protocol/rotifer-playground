/**
 * First-run P2P consent (T-237, ADR-313 D5 item 3): no P2P connection before
 * the user has read what the node connects to and allowed it.
 *
 * - The record is `~/.rotifer/p2p/consent.json` (0600), one per system
 *   account. A missing, unreadable or malformed record, or one for an older
 *   notice, counts as no consent: it fails towards not connecting.
 * - There is no environment variable that grants consent: an environment is
 *   inherited by every child process, so one set for a script would let other
 *   programs connect silently.
 * - `NOTICE_VERSION` names the notice text below. Change the text and the
 *   version goes up, so everyone is asked again; a unit test pins the text's
 *   SHA-256 to the version.
 */
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, tightenPrivateFile } from "./private-fs.js";

export const NOTICE_VERSION = 1;

/** The notice (design §2.1), with `{N}`, `{M}` and `{PEER_ID}` filled in at run time. */
export const NOTICE_TEMPLATE = `P2P networking is off for this account. Starting the node turns it on.

The node will connect to:
  - bootstrap peers from -b or ~/.rotifer/network.json   (now: {N})
  - relay nodes from --relay, used to reach nodes behind NAT
  - peers it met on earlier runs, saved in ~/.rotifer/peers.json   (now: {M})
  - peers that those nodes introduce
  - devices on your local network, only with a non-loopback --host and without --no-mdns
  - rotifer.dev, only to fetch the public keys that check other nodes' certificates
There is no public Rotifer network yet. With no peers configured, the node connects to nothing.

Every peer it connects to can see:
  - your IP address
  - this node's ID, {PEER_ID}, kept in ~/.rotifer/identity.pem
  - the gene announcements this node receives and forwards
With --relay-server or --announce, other nodes can also connect to this node on their own.
It sends gene metadata (names, IDs, versions), never gene code or the inputs and outputs of a run.

Stop the node:          rotifer network stop
Withdraw this consent:  rotifer network consent --revoke`;

export const NOTICE_QUESTION = "Allow P2P networking for this account? [y/N] ";

/** Shown for `{PEER_ID}` when there is no node key yet and none may be made. */
export const PEER_ID_NOT_YET = "(made when the node first starts)";

/** Design §2.2: refused without consent and without a way to ask. */
export const CONSENT_REQUIRED_TITLE = "P2P networking needs your consent first";
export const CONSENT_REQUIRED_HINT =
  "Nothing was started and no connection was made. Run 'rotifer network start' in a terminal to read what it connects to and allow it, or pass --accept-p2p if you have read it (rotifer network consent --show prints the text).";
export const CONSENT_REQUIRED_JSON = {
  ok: false,
  action: "start",
  error: {
    code: "P2P_CONSENT_REQUIRED",
    message: "P2P networking needs your consent first. Nothing was started.",
    fix: "Run 'rotifer network start' in a terminal, or pass --accept-p2p after reading 'rotifer network consent --show'.",
  },
} as const;

/** Design §2.3: the user answered no (or just pressed Enter). */
export const DECLINED = "Not started. P2P networking stays off; nothing was saved.";

/** Design §2.4: the daemon was started directly, without a record. */
export const DAEMON_REFUSED =
  "P2P daemon not started: no consent recorded in ~/.rotifer/p2p/consent.json. Run 'rotifer network start' or 'rotifer network consent --accept'.";

export type ConsentSource = "prompt" | "flag" | "command";
const SOURCES: readonly ConsentSource[] = ["prompt", "flag", "command"];

export interface ConsentRecord {
  version: 1;
  noticeVersion: number;
  acceptedAt: string;
  cliVersion?: string;
  source: ConsentSource;
}

/** `~/.rotifer`, read at call time so a changed `HOME` is honoured. */
export function rotiferHome(): string {
  return join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".rotifer");
}

export function consentPath(home: string = rotiferHome()): string {
  return join(home, "p2p", "consent.json");
}

/** The record if it is valid and for this notice (or a later one), else `null`. */
export function readConsent(home: string = rotiferHome()): ConsentRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(consentPath(home), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;
  if (r.version !== 1) return null;
  if (typeof r.noticeVersion !== "number" || !Number.isInteger(r.noticeVersion)) return null;
  if (r.noticeVersion < NOTICE_VERSION) return null;
  if (typeof r.acceptedAt !== "string" || Number.isNaN(Date.parse(r.acceptedAt))) return null;
  if (!SOURCES.includes(r.source as ConsentSource)) return null;
  if (r.cliVersion !== undefined && typeof r.cliVersion !== "string") return null;
  return r as unknown as ConsentRecord;
}

/** Record consent to the current notice (atomic, 0600). No IP, PeerId or host goes in it. */
export function writeConsent(source: ConsentSource, cliVersion: string | undefined, home: string = rotiferHome()): ConsentRecord {
  const record: ConsentRecord = {
    version: 1,
    noticeVersion: NOTICE_VERSION,
    acceptedAt: new Date().toISOString(),
    ...(cliVersion ? { cliVersion } : {}),
    source,
  };
  const path = consentPath(home);
  ensurePrivateDir(home);
  ensurePrivateDir(join(home, "p2p"));
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  tightenPrivateFile(tmp);
  renameSync(tmp, path);
  return record;
}

/** Delete the record; whether there was one. Touches nothing else. */
export function removeConsent(home: string = rotiferHome()): boolean {
  const path = consentPath(home);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

/** Ask only on a terminal both ways, and never under --json (design §3). */
export function canAsk(isJson: boolean): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isJson;
}

/** Distinct remembered peers in `~/.rotifer/peers.json` (capped like the store, 64). */
export function rememberedPeerCount(home: string = rotiferHome()): number {
  try {
    const list = JSON.parse(readFileSync(join(home, "peers.json"), "utf-8")) as unknown;
    if (!Array.isArray(list)) return 0;
    return Math.min(new Set(list.filter((a) => typeof a === "string")).size, 64);
  } catch {
    return 0;
  }
}

export function renderNotice(values: { bootstrapPeers: number; rememberedPeers: number; peerId: string }): string {
  return NOTICE_TEMPLATE.replace("{N}", String(values.bootstrapPeers))
    .replace("{M}", String(values.rememberedPeers))
    .replace("{PEER_ID}", values.peerId);
}

/** Only "y" or "yes" (any case) agrees; Enter alone does not. */
export function isYes(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}
