/**
 * `rotifer network attest`: get a proof-of-registration certificate for this
 * node (ADR-300 revision 2). Off until the user turns it on.
 *
 * Every subcommand answers with the same JSON shape under --json:
 * `{ ok: true, action, attestation, daemon, notices }` or
 * `{ ok: false, action, error: { code, message, fix } }`.
 *
 * `daemon` from `status` is `running` (one answers its control server) or
 * `not_running`. From the commands that change the certificate it says whether
 * a daemon took the change: `loaded`, `cannot_load` or `not_running`.
 */
import { Command } from "commander";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import * as display from "../utils/display.js";
import { loadP2pNode } from "../utils/binding.js";
import { controlRequest, isDaemonRunning } from "../utils/p2p-daemon.js";
import {
  asPorError,
  BAN_NOTICE,
  CONSENT_FLAG,
  CONSENT_NOTICE,
  defaultPorClientDeps,
  isPorCapable,
  KEY_CHANGE_NOTICE,
  LIFETIME_NOTICE,
  obtainCertificate,
  PorError,
  type PorCapableNode,
  type PorClientDeps,
} from "../utils/por-client.js";
import {
  porStatePath,
  readPorState,
  removePorState,
  stateFor,
  viewOf,
  writePorState,
  type PorView,
} from "../utils/por-keeper.js";

const ROTIFER_HOME = join(process.env.HOME || process.env.USERPROFILE || "/tmp", ".rotifer");

export const DISABLE_NOTICE =
  "The certificate already issued is not voided: it stays valid until it expires, at most 7 days from its last renewal. There is no way to revoke it yourself.";

/** Whether a running daemon picked the change up. */
export type DaemonLoad = "loaded" | "not_running" | "cannot_load";
/** Whether a daemon is answering: only `status` reports this. */
export type DaemonPresence = "running" | "not_running";

export interface AttestOutcome {
  ok: true;
  action: "enable" | "renew" | "disable" | "status";
  attestation: PorView;
  daemon: DaemonLoad | DaemonPresence;
  notices: string[];
}

export interface AttestDeps {
  statePath: string;
  loadNode: () => { peerId(): string } | null;
  client: PorClientDeps;
  now: () => number;
  isInteractive: () => boolean;
  confirm: (question: string) => Promise<boolean>;
  notify: (notices: string[]) => void;
  reloadDaemon: () => Promise<DaemonLoad>;
  isDaemonRunning: () => Promise<boolean>;
}

function capableNode(deps: AttestDeps): PorCapableNode {
  const node = deps.loadNode();
  if (!isPorCapable(node)) throw new PorError("POR_CLIENT_NEEDS_UPGRADE");
  return node;
}

function nowS(deps: AttestDeps): number {
  return Math.floor(deps.now() / 1000);
}

async function getAndStore(node: PorCapableNode, deps: AttestDeps): Promise<PorView> {
  const cert = await obtainCertificate(node, deps.client);
  // The node refuses a token it could not carry; do not store one.
  try {
    node.setAttestation(cert.token);
  } catch {
    throw new PorError("POR_BAD_RESPONSE");
  }
  writePorState(deps.statePath, stateFor(cert, deps.now()));
  return viewOf(readPorState(deps.statePath), node.peerId(), nowS(deps));
}

export async function attestEnable(options: { accept: boolean }, deps: AttestDeps): Promise<AttestOutcome> {
  const node = capableNode(deps);
  const previous = readPorState(deps.statePath);
  const isSameNode = previous?.peerId === node.peerId();
  const notices = [CONSENT_NOTICE, LIFETIME_NOTICE, BAN_NOTICE];

  if (previous && isSameNode && previous.exp > nowS(deps)) {
    return {
      ok: true,
      action: "enable",
      attestation: viewOf(previous, node.peerId(), nowS(deps)),
      daemon: await deps.reloadDaemon(),
      notices: [],
    };
  }

  // Before asking anything: a sign-in problem makes the question pointless.
  await deps.client.session();

  // This node's link to the pseudonym was agreed to once; a new key is a new node.
  let hasShownNotices = false;
  if (!isSameNode && !options.accept) {
    if (!deps.isInteractive()) throw new PorError("POR_CONSENT_REQUIRED");
    deps.notify(notices);
    hasShownNotices = true;
    if (!(await deps.confirm("Enable certificates for this node?"))) throw new PorError("POR_CONSENT_DECLINED");
  }

  const attestation = await getAndStore(node, deps);
  return {
    ok: true,
    action: "enable",
    attestation,
    daemon: await deps.reloadDaemon(),
    notices: [...(hasShownNotices ? [] : notices), ...(previous && !isSameNode ? [KEY_CHANGE_NOTICE] : [])],
  };
}

export async function attestRenew(deps: AttestDeps): Promise<AttestOutcome> {
  const node = capableNode(deps);
  const state = readPorState(deps.statePath);
  if (!state) throw new PorError("POR_NOT_ENABLED");
  if (state.peerId !== node.peerId()) throw new PorError("POR_KEY_CHANGED");
  const attestation = await getAndStore(node, deps);
  return { ok: true, action: "renew", attestation, daemon: await deps.reloadDaemon(), notices: [] };
}

export async function attestDisable(deps: AttestDeps): Promise<AttestOutcome> {
  const hasCertificate = readPorState(deps.statePath) !== null;
  removePorState(deps.statePath);
  return {
    ok: true,
    action: "disable",
    attestation: viewOf(null, null, nowS(deps)),
    daemon: await deps.reloadDaemon(),
    notices: hasCertificate ? [DISABLE_NOTICE] : [],
  };
}

export async function attestStatus(deps: AttestDeps): Promise<AttestOutcome> {
  const state = readPorState(deps.statePath);
  // Only with a certificate: building a node creates an identity if there is none.
  const peerId = state ? (deps.loadNode()?.peerId() ?? null) : null;
  const attestation = viewOf(state, peerId, nowS(deps));
  return {
    ok: true,
    action: "status",
    attestation,
    daemon: (await deps.isDaemonRunning()) ? "running" : "not_running",
    notices: attestation.state === "key_changed" ? [KEY_CHANGE_NOTICE] : [],
  };
}

const STATE_LABELS: Record<PorView["state"], string> = {
  off: "Off",
  active: "Active",
  expired: "Expired",
  key_changed: "Key changed: this node needs a new certificate",
};

function remaining(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`;
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)} h` : `${Math.ceil(seconds / 60)} min`;
}

/** The certificate as `network status` and `attest` print it. */
export function printAttestation(view: PorView): void {
  display.kv("Certificate", STATE_LABELS[view.state]);
  if (view.expiresAt !== null && view.expiresInSeconds !== null) {
    const left = view.expiresInSeconds > 0 ? ` (in ${remaining(view.expiresInSeconds)})` : "";
    display.kv("Expires", `${new Date(view.expiresAt * 1000).toISOString()}${left}`);
  }
  if (view.lastFailure) {
    display.kv("Last renewal failed", view.lastFailure.message);
    display.hint(view.lastFailure.fix);
  }
}

function printOutcome(out: AttestOutcome): void {
  printAttestation(out.attestation);
  if (out.action === "enable" || out.action === "renew") {
    if (out.attestation.state === "active") display.success("This node has a certificate.");
    if (out.daemon === "not_running") display.hint("It will be used the next time you run 'rotifer network start'.");
    if (out.daemon === "cannot_load") display.warn("The running daemon could not load it: restart with 'rotifer network stop' and 'start'.");
  }
  for (const notice of out.notices) display.info(notice);
}

/** Only a clear yes is a yes. Ending the input (Ctrl-D) is not one. */
export async function askYesNo(question: string, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    return await new Promise<boolean>((resolve, reject) => {
      rl.once("close", () => resolve(false));
      rl.question(`${question} [y/N] `).then((answer) => resolve(/^y(es)?$/i.test(answer.trim())), reject);
    });
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

export function defaultDeps(): AttestDeps {
  return {
    statePath: porStatePath(ROTIFER_HOME),
    loadNode: () => loadP2pNode("127.0.0.1", 0, []),
    client: defaultPorClientDeps,
    now: Date.now,
    isInteractive: () => !display.isJsonMode() && Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: (question) => askYesNo(question, process.stdin, process.stdout),
    notify: (notices) => {
      for (const notice of notices) display.warn(notice);
    },
    reloadDaemon: async () => {
      const result = await controlRequest("POST", "/attestation/reload");
      return !result ? "not_running" : result.ok ? "loaded" : "cannot_load";
    },
    isDaemonRunning,
  };
}

/** Report one command's outcome. A failure is its fixed text, never a stack. */
export async function reportAttest(action: AttestOutcome["action"], run: () => Promise<AttestOutcome>): Promise<void> {
  let out: AttestOutcome;
  try {
    out = await run();
  } catch (err) {
    const { code, message, fix } = asPorError(err);
    if (display.isJsonMode()) {
      process.stdout.write(JSON.stringify({ ok: false, action, error: { code, message, fix } }, null, 2) + "\n");
    } else {
      display.error(message, fix);
    }
    process.exitCode = 1;
    return;
  }
  display.renderResult(out, printOutcome);
}

const HELP = ["", CONSENT_NOTICE, LIFETIME_NOTICE, BAN_NOTICE].join("\n");

export const attestCommand = new Command("attest")
  .description("Get a certificate that links this node to your account (off by default)")
  .addHelpText("after", HELP)
  .addCommand(
    new Command("enable")
      .description("Turn certificates on and get one for this node")
      .option(CONSENT_FLAG, "agree that this node is publicly linked to an account pseudonym (needed when not interactive)", false)
      .addHelpText("after", HELP)
      .action((options: { acceptPublicPseudonym: boolean }) =>
        reportAttest("enable", () => attestEnable({ accept: options.acceptPublicPseudonym }, defaultDeps())),
      ),
  )
  .addCommand(
    new Command("status")
      .description("Show this node's certificate")
      .action(() => reportAttest("status", () => attestStatus(defaultDeps()))),
  )
  .addCommand(
    new Command("renew")
      .description("Renew now (the running daemon does this on its own when under 48 hours remain)")
      .action(() => reportAttest("renew", () => attestRenew(defaultDeps()))),
  )
  .addCommand(
    new Command("disable")
      .description("Stop carrying and renewing the certificate")
      .addHelpText("after", `\n${DISABLE_NOTICE}`)
      .action(() => reportAttest("disable", () => attestDisable(defaultDeps()))),
  );
