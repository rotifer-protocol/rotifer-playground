import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { existsSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ensurePrivateDir, tightenPrivateFile } from "../utils/private-fs.js";
import {
  geneIdV2,
  loadP2pNode,
  type P2pNodeOptions,
  type NetworkAnnounceReport,
  type NetworkSearchHit,
  type NetworkSearchResult,
  type ReceivedAnnouncement,
} from "../utils/binding.js";
import { listGenes } from "../cloud/client.js";
import {
  announcedTablePath,
  matches,
  readAnnouncedTable,
  writeAnnouncedTable,
  type AnnouncedGene,
  type WithdrawMatch,
} from "../utils/announce-table.js";
import type { CloudGene } from "../cloud/types.js";
import {
  controlRequest,
  isDaemonRunning,
  readDaemonState,
  runDaemon,
} from "../utils/p2p-daemon.js";
import { attestCommand, printAttestation } from "./network-attest.js";
import { KEY_CHANGE_NOTICE } from "../utils/por-client.js";
import { porStatePath, readPorState, viewOf, type PorView } from "../utils/por-keeper.js";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer"
);
const NETWORK_CONFIG = join(ROTIFER_HOME, "network.json");
/** The node key the native node creates on first start (rotifer-core `default_identity_path`). */
const NODE_KEY_FILE = "identity.pem";

interface NetworkConfig {
  node_id: string;
  listen_port: number;
  bootstrap_peers: string[];
  enabled: boolean;
}

function loadNetworkConfig(): NetworkConfig {
  if (existsSync(NETWORK_CONFIG)) {
    try {
      return JSON.parse(readFileSync(NETWORK_CONFIG, "utf-8"));
    } catch {
      // fall through
    }
  }
  return {
    node_id: randomUUID(),
    listen_port: 9878,
    // No default bootstrap peer — see the note in crates/rotifer-core/src/p2p/mod.rs.
    // The old `/dns4/bootstrap.rotifer.dev/tcp/9878` default did not resolve
    // (NXDOMAIN) and `/dns4/` needs a DNS transport this build omits on purpose,
    // so it silently connected to nothing. Official bootstrap infra is not
    // deployed yet; pass peers explicitly with `-b/--bootstrap` until it is.
    bootstrap_peers: [],
    enabled: false,
  };
}

function saveNetworkConfig(config: NetworkConfig): void {
  ensurePrivateDir(ROTIFER_HOME);
  writeFileSync(NETWORK_CONFIG, JSON.stringify(config, null, 2) + "\n");
  tightenPrivateFile(NETWORK_CONFIG);
}

/**
 * Text a publisher claims (name, domain, fidelity, version, IR spec) with
 * terminal control characters escaped, so it cannot move the cursor, clear
 * the screen or reorder text when printed (A2 design v2 §10.1, G9).
 */
export function escapeTerminal(text: string): string {
  return text.replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (ch) => `\\u{${ch.codePointAt(0)!.toString(16)}}`,
  );
}

const V2_QUERY = /^v2:[0-9a-f]{64}$/;
/** Cloud's share of the search (RFC §5.3); P2P answers by its 3 s deadline. */
export const CLOUD_TIMEOUT_MS = 5000;

const G18_NOTICE =
  "Publishing to the DHT makes this node's network addresses visible to anyone who looks up this gene ID.";
const G18_FLAG = join(ROTIFER_HOME, "p2p", "dht-address-notice-shown");

/**
 * How long other nodes may still list a withdrawn gene: copies they stored
 * expire within 24 h of arriving; an announcement heard on gossip is shown
 * until it is 48 h old (design v2 §6.3, §7.3).
 */
const WITHDRAW_LIMITS =
  "Other nodes are not told to delete it: copies they stored expire within 24 h of arriving, " +
  "and a node that heard the announcement on gossip can still list it for up to 48 h.";
const KEY_NOTICE =
  "A record's time window bounds one claim. It does not bound a stolen node key: whoever holds the key " +
  "can keep signing. Rotate the node key (delete ~/.rotifer/identity.pem, restart) if it leaks.";

type SearchMode = "keyword" | "gene_id";

interface CloudPart {
  status: "ok" | "timeout" | "error" | "skipped";
  genes: CloudGene[];
}

export interface P2pPublisher {
  peerId: string;
  registered: boolean;
  name: string;
  domain: string;
  fidelity: string;
  version: string;
  irSpec: string;
  timestampMs: number;
  source: NetworkSearchHit["source"];
}

export interface P2pGeneGroup {
  geneId: string;
  /** Cloud search results carry no v2 ID, so a match cannot be told (§9). */
  cloudMatch: "unknown";
  registeredAccounts: number;
  labelsAgree: boolean;
  publishers: P2pPublisher[];
}

interface P2pPart {
  status: "ok" | "timeout" | "error" | "daemon_not_running";
  partial: boolean;
  genes: P2pGeneGroup[];
}

export interface NetworkSearchOutput {
  query: string;
  mode: SearchMode;
  /** The two lists are never merged into one (§9). */
  merged: false;
  cloud: CloudPart;
  p2p: P2pPart;
}

const LABELS = ["name", "domain", "fidelity", "version", "irSpec"] as const;

/**
 * Group P2P hits by v2 ID. Groups rank by distinct registered accounts, then
 * by their newest announcement; unregistered publishers are listed, not counted.
 */
export function groupP2pHits(hits: NetworkSearchHit[]): P2pGeneGroup[] {
  const byGene = new Map<string, NetworkSearchHit[]>();
  for (const h of hits) byGene.set(h.geneId, [...(byGene.get(h.geneId) ?? []), h]);
  const newest = (g: P2pGeneGroup) => Math.max(...g.publishers.map((p) => p.timestampMs));
  return [...byGene.entries()]
    .map(([geneId, group]) => {
      const publishers = group
        .map((h) => ({
          peerId: h.publisher,
          registered: h.account !== undefined && h.account !== null,
          name: h.name,
          domain: h.domain,
          fidelity: h.fidelity,
          version: h.version,
          irSpec: h.irSpec,
          timestampMs: h.timestampMs,
          source: h.source,
        }))
        .sort((a, b) => Number(b.registered) - Number(a.registered) || b.timestampMs - a.timestampMs);
      return {
        geneId,
        cloudMatch: "unknown" as const,
        registeredAccounts: new Set(group.flatMap((h) => (h.account ? [h.account] : []))).size,
        labelsAgree: LABELS.every((k) => new Set(publishers.map((p) => p[k])).size === 1),
        publishers,
      };
    })
    .sort((a, b) => b.registeredAccounts - a.registeredAccounts || newest(b) - newest(a));
}

async function searchCloud(query: string): Promise<CloudPart> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CLOUD_TIMEOUT_MS);
  try {
    const result = await listGenes({ query, signal: abort.signal });
    return { status: "ok", genes: result.genes };
  } catch {
    return { status: abort.signal.aborted ? "timeout" : "error", genes: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function searchP2p(query: string, mode: SearchMode): Promise<P2pPart> {
  const failed = (status: P2pPart["status"]): P2pPart => ({ status, partial: false, genes: [] });
  if (!readDaemonState()) return failed("daemon_not_running");
  const started = Date.now();
  const result = await controlRequest("POST", "/search", mode === "gene_id" ? { geneId: query } : { keyword: query });
  // No answer: a stale state file is refused at once; a stuck daemon runs
  // into the request timeout.
  if (!result) return failed(Date.now() - started < 3500 ? "daemon_not_running" : "timeout");
  if (!result.ok) return failed("error");
  const found = result.body as NetworkSearchResult;
  return {
    status: found.timedOut ? "timeout" : "ok",
    partial: found.partial,
    genes: groupP2pHits(found.hits),
  };
}

/** Run Cloud and the P2P network side by side (RFC §5.3, design v2 §9–§10.1). */
export async function networkSearch(query: string): Promise<NetworkSearchOutput> {
  const mode: SearchMode = V2_QUERY.test(query) ? "gene_id" : "keyword";
  const [cloud, p2p] = await Promise.all([
    mode === "gene_id" ? Promise.resolve<CloudPart>({ status: "skipped", genes: [] }) : searchCloud(query),
    searchP2p(query, mode),
  ]);
  return { query, mode, merged: false, cloud, p2p };
}

const short = (id: string, n: number) => (id.length > n ? `${id.slice(0, n)}…` : id);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function cloudFailure(cloud: CloudPart): string {
  if (cloud.status === "skipped") return "Rotifer Cloud cannot look up v2 gene IDs";
  return cloud.status === "timeout"
    ? `Rotifer Cloud did not answer within ${CLOUD_TIMEOUT_MS / 1000} s`
    : "Rotifer Cloud is unreachable or returned an error";
}

/**
 * The daemon ran the search: it finished, or stopped at its 3 s deadline with
 * what it had (design §10.1: the deadline always makes the result partial).
 * A control request that got no reply has nothing and is not partial.
 */
function hasDaemonAnswered(p2p: P2pPart): boolean {
  return p2p.status === "ok" || (p2p.status === "timeout" && p2p.partial);
}

function p2pFailure(p2p: P2pPart): string {
  if (p2p.status === "daemon_not_running") return "the P2P daemon is not running";
  return p2p.status === "timeout" ? "the P2P daemon did not answer in time" : "the P2P search failed";
}

function printSearch(out: NetworkSearchOutput): void {
  display.header(`Gene Search  "${escapeTerminal(out.query)}"`, { separator: false });
  const { cloud, p2p } = out;
  const hasP2pAnswer = hasDaemonAnswered(p2p);

  if (cloud.status === "skipped") {
    display.info("Rotifer Cloud skipped: it cannot look up v2 gene IDs.");
  } else if (cloud.status === "ok") {
    console.log(c.bold(`Rotifer Cloud (${cloud.genes.length})`));
    for (const g of cloud.genes) {
      const label = escapeTerminal(`${g.name}@${g.version}`);
      const rep = g.reputation_score == null ? "" : ` · reputation ${g.reputation_score}`;
      console.log(
        `  ${label.padEnd(22)}${escapeTerminal(g.domain)} · ${escapeTerminal(g.fidelity)} · by ${escapeTerminal(g.owner)}${rep}`,
      );
    }
  } else if (hasP2pAnswer) {
    display.warn("Rotifer Cloud unreachable — showing P2P results only");
  }

  if (p2p.status === "daemon_not_running") {
    if (cloud.status === "ok") display.hint("Run 'rotifer network start' to include the P2P network.");
  } else if (hasP2pAnswer) {
    console.log(
      c.bold(`P2P network (${p2p.genes.length})`) +
        "  heard from other nodes · whether any is the same gene as a Cloud result is unknown",
    );
    for (const g of p2p.genes) {
      const unregistered = g.publishers.filter((p) => !p.registered).length;
      const counts = [plural(g.registeredAccounts, "registered account", "registered accounts")];
      if (unregistered > 0) counts.push(plural(unregistered, "unregistered publisher", "unregistered publishers"));
      console.log(`  ${short(g.geneId, 9)}  ${counts.join(", ")}`);
      for (const p of g.publishers) {
        const label = escapeTerminal(p.version ? `${p.name}@${p.version}` : p.name);
        const reg = p.registered ? " (registered)" : "";
        console.log(
          `     ${label.padEnd(20)} ${escapeTerminal(p.domain)} · ${escapeTerminal(p.fidelity)}   from ${short(p.peerId, 12)}${reg}`,
        );
      }
      if (!g.labelsAgree) {
        const differ = LABELS.filter((k) => new Set(g.publishers.map((p) => p[k])).size > 1);
        console.log(`     ! publishers disagree on ${differ.join(" and ")}`);
      }
    }
    if (p2p.partial) display.hint("P2P results may be incomplete: the 3 s search deadline or a candidate limit was hit.");
  } else if (cloud.status === "ok") {
    display.warn(`P2P network not searched: ${p2pFailure(p2p)}.`);
  }

  if (cloud.status === "ok" && hasP2pAnswer) {
    display.hint(
      "The two lists are not merged: Cloud search results don't carry a v2 gene ID, so one gene can appear in both.",
    );
  }
  if (hasP2pAnswer) {
    display.hint(
      "Name, domain, fidelity and version are each publisher's own claim. The gene ID itself is only checked when the content is fetched.",
    );
  }
}

/** Arguments for the hidden `network __daemon` subcommand that `start` spawns. */
export function daemonArgs(
  host: string,
  port: number,
  bootstrapPeers: string[],
  shouldUseMdns: boolean,
  node: P2pNodeOptions = {},
): string[] {
  const args = ["network", "__daemon", "--host", host, "--port", String(port)];
  for (const peer of bootstrapPeers) {
    args.push("--bootstrap", peer);
  }
  if (!shouldUseMdns) args.push("--no-mdns");
  for (const relay of node.relays ?? []) args.push("--relay", relay);
  if (node.relayServer) args.push("--relay-server");
  for (const addr of node.announce ?? []) args.push("--announce", addr);
  if (node.maxInbound !== undefined) args.push("--max-inbound", String(node.maxInbound));
  if (node.maxPending !== undefined) args.push("--max-pending", String(node.maxPending));
  return args;
}

/** The relay and connection-limit flags `start` and `__daemon` share (T-231 B2 design §8 PR-②). */
interface NodeFlags {
  relay?: string[];
  relayServer?: boolean;
  announce?: string[];
  maxInbound?: string;
  maxPending?: string;
}

function withNodeFlags(cmd: Command): Command {
  return cmd
    .option("--relay <addr...>", "hold a reservation on this relay (multiaddr ending in /p2p/<PeerId>), so NATed peers can reach this node")
    .option("--relay-server", "serve as a relay for other nodes (needs --announce)")
    .option("--announce <addr...>", "this node's public address, /ip4/<public IPv4>/tcp/<port> only")
    .option("--max-inbound <n>", "most established inbound connections (default 50)")
    .option("--max-pending <n>", "most connections in their handshake, both directions (default 20)");
}

/** `flags` as node options, or what is wrong with them. Unset flags stay unset. */
export function nodeOptionsFrom(flags: NodeFlags): P2pNodeOptions | { error: string } {
  const count = (v: string | undefined, name: string): number | undefined | string => {
    if (v === undefined) return undefined;
    return /^[1-9][0-9]*$/.test(v) && Number(v) <= 0xffffffff ? Number(v) : `${name} must be a whole number of 1 or more, got "${v}"`;
  };
  const maxInbound = count(flags.maxInbound, "--max-inbound");
  const maxPending = count(flags.maxPending, "--max-pending");
  for (const v of [maxInbound, maxPending]) if (typeof v === "string") return { error: v };
  return {
    ...(flags.relay?.length ? { relays: flags.relay } : {}),
    ...(flags.relayServer ? { relayServer: true } : {}),
    ...(flags.announce?.length ? { announce: flags.announce } : {}),
    ...(maxInbound !== undefined ? { maxInbound: maxInbound as number } : {}),
    ...(maxPending !== undefined ? { maxPending: maxPending as number } : {}),
  };
}

/**
 * The fields `network status --json` prints: design T-231 §4.2's, no more.
 * The other `/status` fields (own PeerId, listen addresses) stay out, so the
 * JSON holds no address but the announced ones, no PeerId and no score.
 */
export const STATUS_JSON_FIELDS = [
  "version",
  "roles",
  "announcedAddrs",
  "eventLoop",
  "connections",
  "limits",
  "denials",
  "foreignPeersDropped",
  "colocation",
  "nat",
  "relay",
  "gossip",
  "dht",
] as const;

/** `/status` cut down to `STATUS_JSON_FIELDS`; a field the daemon does not report is left out. */
export function statusJson(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { running: true };
  for (const field of STATUS_JSON_FIELDS) if (field in body) out[field] = body[field];
  return out;
}

/** mDNS only runs off loopback: it announces a node at its LAN address (RFC §5.1). */
function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** Spawn the daemon as a detached background process, logging to ~/.rotifer/daemon.log. */
function spawnDaemon(
  host: string,
  port: number,
  bootstrapPeers: string[],
  shouldUseMdns: boolean,
  node: P2pNodeOptions,
): void {
  ensurePrivateDir(ROTIFER_HOME);
  const logFd = openSync(join(ROTIFER_HOME, "daemon.log"), "a");
  const args = [process.argv[1], ...daemonArgs(host, port, bootstrapPeers, shouldUseMdns, node)];
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
}

async function waitForDaemon(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export const networkCommand = new Command("network")
  .description("P2P gene network commands")
  .addCommand(
    new Command("status")
      .description(
        "Show P2P daemon status (reads only; writes no file). With the global --json, print the node's counters as JSON: no peer addresses, PeerIds or scores",
      )
      .option("--state-file <path>", "read the daemon's port and token from this file, not ~/.rotifer/daemon.json")
      .action(async (options: { stateFile?: string }, cmd: Command) => {
        const status = options.stateFile
          ? await controlRequest("GET", "/status", undefined, undefined, options.stateFile)
          : await controlRequest("GET", "/status");
        // `--json` is the CLI's global option (src/index.ts), so read it from there.
        if (cmd.optsWithGlobals().json === true) {
          if (!status?.ok) {
            console.log(JSON.stringify({ running: false }));
            process.exitCode = 1;
            return;
          }
          console.log(JSON.stringify(statusJson(status.body as Record<string, unknown>), null, 2));
          return;
        }
        const config = loadNetworkConfig();

        display.header("P2P Network Status");
        console.log();
        if (status?.ok) {
          const s = status.body as {
            peerId: string;
            listenAddrs: string[];
            peers: number;
            dhtPeers?: number;
            connectedPeers?: number;
            attestation?: PorView;
          };
          display.kv("Status", c.success("● Running"));
          display.kv("PeerId", s.peerId);
          for (const addr of s.listenAddrs) display.kv("Listening", addr);
          display.kv("Discovered peers", String(s.peers));
          // Absent when the daemon predates these counts.
          if (s.connectedPeers !== undefined) display.kv("Connected peers", String(s.connectedPeers));
          if (s.dhtPeers !== undefined) display.kv("DHT peers", String(s.dhtPeers));
          // Absent when this addon cannot hold a certificate.
          if (s.attestation) printAttestation(s.attestation);
        } else {
          display.kv("Status", c.muted("○ Not running"));
          // No node key yet: this machine has no node id to show. Say so
          // rather than make one up (status writes nothing).
          if (!existsSync(join(ROTIFER_HOME, NODE_KEY_FILE))) {
            display.kv("Node", "not initialised: run 'rotifer network start' first");
          }
          display.kv("Listen Port", String(config.listen_port));
          display.kv("Bootstrap Peers", String(config.bootstrap_peers.length));
          printAttestation(viewOf(readPorState(porStatePath(ROTIFER_HOME)), null, Math.floor(Date.now() / 1000)));
          console.log();
          display.hint("Start the daemon: rotifer network start");
        }
        console.log();
      })
  )
  .addCommand(
    withNodeFlags(new Command("start"))
      .description("Start the P2P node as a background daemon (or in this process with --foreground)")
      .option("-p, --port <port>", "listen port", "9878")
      .option(
        "-H, --host <addr>",
        "listen interface: 127.0.0.1 (loopback) or 0.0.0.0 (reachable from other machines)",
        "127.0.0.1",
      )
      .option("-b, --bootstrap <addr...>", "bootstrap peer multiaddr(s); overrides config")
      .option(
        "--no-mdns",
        "don't discover or announce on the local network (use on untrusted Wi-Fi); mDNS only runs with a non-loopback --host",
      )
      .option("--foreground", "run in this process instead of the background, for a service manager such as systemd; exits non-zero if the node stops working")
      .action(async (options: { port: string; host: string; bootstrap?: string[]; mdns: boolean; foreground?: boolean } & NodeFlags) => {
        display.header("Starting P2P Daemon");
        const node = nodeOptionsFrom(options);
        if ("error" in node) {
          display.error(node.error);
          process.exitCode = 1;
          return;
        }

        if (await isDaemonRunning()) {
          display.warn("P2P daemon is already running.");
          display.hint("Use 'rotifer network status' to inspect it, or 'stop' first.");
          return;
        }

        // Fail fast with a clear message if the native addon is absent, rather
        // than spawning a daemon that immediately dies.
        if (!loadP2pNode("127.0.0.1", 0, [])) {
          display.warn("Native P2P node is unavailable in this build.");
          display.hint("This CLI was built without the compiled libp2p addon.");
          return;
        }

        const config = loadNetworkConfig();
        const port = parseInt(options.port, 10);
        config.listen_port = port;
        const host = options.host;
        const bootstrap =
          options.bootstrap && options.bootstrap.length > 0
            ? options.bootstrap
            : config.bootstrap_peers;

        if (options.foreground) {
          config.enabled = true;
          saveNetworkConfig(config);
          display.info("Running in the foreground; stop with Ctrl-C or SIGTERM.");
          await runDaemon(host, port, bootstrap, options.mdns, { node, foreground: true });
          return;
        }

        spawnDaemon(host, port, bootstrap, options.mdns, node);
        const isReady = await waitForDaemon(15_000);
        if (!isReady) {
          display.error(
            "P2P daemon did not come up in time",
            `check ${join(ROTIFER_HOME, "daemon.log")}`
          );
          process.exitCode = 1;
          return;
        }

        config.enabled = true;
        saveNetworkConfig(config);
        const state = readDaemonState();
        console.log();
        display.kv("PeerId", state?.peerId ?? "?");
        display.kv("Listen host", host);
        display.kv("PID", String(state?.pid ?? "?"));
        display.kv("Bootstrap peers", String(bootstrap.length));
        display.kv(
          "LAN discovery (mDNS)",
          !options.mdns ? "off (--no-mdns)" : isLoopbackHost(host) ? "off (loopback only)" : "on",
        );
        console.log();
        display.success("P2P daemon running in the background.");
        const certificate = readPorState(porStatePath(ROTIFER_HOME));
        if (certificate && state && certificate.peerId !== state.peerId) display.warn(KEY_CHANGE_NOTICE);
        if (host !== "127.0.0.1") {
          display.hint("'rotifer network status' shows the reachable multiaddr — give it to other nodes as --bootstrap");
        }
        display.hint("rotifer network peers / announce / status / stop");
      })
  )
  // Hidden: the long-running daemon process spawned by `start`.
  .addCommand(
    withNodeFlags(new Command("__daemon"))
      .description("(internal) run the P2P daemon")
      .option("-H, --host <addr>", "listen interface", "127.0.0.1")
      .option("-p, --port <port>", "listen port", "9878")
      .option("--bootstrap <addr...>", "bootstrap multiaddr(s)")
      .option("--no-mdns", "disable mDNS LAN discovery")
      .action(async (options: { host: string; port: string; bootstrap?: string[]; mdns: boolean } & NodeFlags) => {
        const node = nodeOptionsFrom(options);
        if ("error" in node) {
          process.stderr.write(`${node.error}\n`);
          process.exit(1);
        }
        const args = [options.host, parseInt(options.port, 10), options.bootstrap ?? [], options.mdns] as const;
        // Without the new flags the daemon is started exactly as before.
        if (Object.keys(node).length === 0) await runDaemon(...args);
        else await runDaemon(...args, { node });
      }),
    { hidden: true }
  )
  .addCommand(
    new Command("stop")
      .description("Stop the P2P daemon")
      .action(async () => {
        const result = await controlRequest("POST", "/stop");
        if (!result) {
          display.warn("P2P daemon is not running.");
          return;
        }
        const config = loadNetworkConfig();
        config.enabled = false;
        saveNetworkConfig(config);
        display.success("P2P daemon stopped");
      })
  )
  .addCommand(
    new Command("peers")
      .description("List peers discovered by the running daemon")
      .action(async () => {
        const result = await controlRequest("GET", "/peers");
        if (!result) {
          display.warn("P2P daemon is not running. Run 'rotifer network start' first.");
          return;
        }
        const peers = (result.body as { peers: string[] }).peers ?? [];
        display.header("Discovered Peers", { separator: false });
        if (peers.length === 0) {
          display.warn("No peers discovered yet.");
          return;
        }
        for (const [i, peer] of peers.entries()) {
          display.kv(`#${i + 1}`, peer);
        }
        console.log();
        display.hint(`${peers.length} peer(s) discovered`);
      })
  )
  .addCommand(
    new Command("received")
      .description("Show gene announcements this node has received from peers")
      .action(async () => {
        const result = await controlRequest("GET", "/received");
        if (!result) {
          display.warn("P2P daemon is not running. Run 'rotifer network start' first.");
          return;
        }
        const anns =
          (result.body as { announcements?: ReceivedAnnouncement[] }).announcements ?? [];
        display.header("Received Gene Announcements", { separator: false });
        if (anns.length === 0) {
          display.warn("No announcements received yet.");
          display.hint("A peer must announce a gene while this node is connected + subscribed.");
          return;
        }
        for (const a of anns) {
          const from = (a.publisher ?? a.source ?? "").slice(0, 16);
          const label = escapeTerminal(a.version ? `${a.name}@${a.version}` : a.name);
          display.kv(
            label,
            `${escapeTerminal(a.domain)} · ${escapeTerminal(a.fidelity)} · ${a.geneId.slice(0, 15)}… · from ${from}…`,
          );
        }
        console.log();
        display.hint(`${anns.length} announcement(s) received`);
        display.hint("Names and versions are labels claimed by the publisher; the gene ID is derived from the content.");
      })
  )
  .addCommand(
    new Command("search")
      .description("Search Rotifer Cloud and the P2P network")
      .argument("<query>", "keywords, or one v2 gene ID (v2:<64 hex>)")
      .addHelpText(
        "after",
        [
          "",
          "Keywords match the name and domain of announcements this node heard",
          "from other nodes, and run a Rotifer Cloud search alongside.",
          "A v2 gene ID is looked up in the DHT; Rotifer Cloud cannot look up v2 IDs.",
          "The DHT is never searched by keyword. The two lists are not merged.",
        ].join("\n"),
      )
      .action(async (query: string) => {
        const out = await networkSearch(query);
        const isCloudOk = out.cloud.status === "ok";
        const isP2pOk = hasDaemonAnswered(out.p2p);
        display.renderResult(out, printSearch);
        if (!isCloudOk && !isP2pOk) {
          if (!display.isJsonMode()) {
            display.error("Search failed", `${cloudFailure(out.cloud)}; ${p2pFailure(out.p2p)}.`);
          }
          process.exitCode = 1;
        }
      })
  )
  .addCommand(
    new Command("announce")
      .description("Announce a local gene through the running daemon")
      .argument("<gene-name>", "gene name to announce")
      .addHelpText("after", `\n! ${G18_NOTICE}`)
      .action(async (geneName: string) => {
        display.header("Gene Announcement");

        const phenotypePath = join(process.cwd(), "genes", geneName, "phenotype.json");
        if (!existsSync(phenotypePath)) {
          display.error(`Gene '${geneName}' not found`, `expected ${phenotypePath}`);
          process.exitCode = 1;
          return;
        }

        // The wire carries the content-derived v2 ID, never the directory name.
        const genesRoot = join(process.cwd(), "genes");
        const idResult = geneIdV2(genesRoot, geneName);
        if (!("id" in idResult)) {
          display.error(`Gene '${geneName}' has no v2 gene ID`, idResult.reason);
          display.hint("See docs/gene-id-v2.md §5 for what makes an ID computable.");
          process.exitCode = 1;
          return;
        }

        const result = await controlRequest("POST", "/announce", { genesRoot, name: geneName });
        if (!result) {
          display.warn("P2P daemon is not running. Run 'rotifer network start' first.");
          return;
        }
        if (!result.ok) {
          display.error("Announcement failed", JSON.stringify(result.body));
          process.exitCode = 1;
          return;
        }
        display.success(`Announced '${geneName}'`);
        display.kv("Gene ID (v2)", idResult.id);
        const report = (result.body as { report?: NetworkAnnounceReport }).report;
        if (!report) return; // an older native addon announces over gossip only
        display.kv("Gossip", `published (${plural(report.gossipPeers, "connected peer subscribes", "connected peers subscribe")})`);
        display.kv(
          "DHT record",
          report.recordSent === 0
            ? "not sent: no DHT peers yet"
            : `sent to ${plural(report.recordSent, "node", "nodes")}, ${report.recordAcked} acknowledged (an acknowledgement does not prove the record was kept)`,
        );
        display.kv("Provider record", "published (the protocol reports no count and no acknowledgement)");
        display.kv("Read-back", `readable from ${plural(report.readableFrom, "other node", "other nodes")}`);
        // Shown once per node; always in --help (design v2 §10.2, G18).
        if (!existsSync(G18_FLAG)) {
          display.warn(G18_NOTICE);
          try {
            ensurePrivateDir(join(ROTIFER_HOME, "p2p"));
            writeFileSync(G18_FLAG, `${new Date().toISOString()}\n`);
          } catch {
            /* the notice is shown again next time */
          }
        }
      })
  )
  .addCommand(attestCommand)
  .addCommand(
    new Command("withdraw")
      .description("Stop announcing a gene: no more republishing, and this node stops serving it")
      .argument("<gene>", "gene name or v2 gene ID")
      .addHelpText("after", `\n${WITHDRAW_LIMITS}\n${KEY_NOTICE}`)
      .action(async (gene: string) => {
        display.header("Gene Withdrawal");
        const match: WithdrawMatch = V2_QUERY.test(gene) ? { geneId: gene } : { name: gene };
        const result = await controlRequest("POST", "/withdraw", match);
        let withdrawn: AnnouncedGene[];
        if (!result) {
          // No daemon: nothing is being served; only the table remembers it.
          const path = announcedTablePath(ROTIFER_HOME);
          const { entries, problem } = readAnnouncedTable(path);
          if (problem) display.warn(problem);
          withdrawn = entries.filter((e) => matches(e, match));
          if (withdrawn.length > 0) writeAnnouncedTable(path, entries.filter((e) => !matches(e, match)));
          display.info("The P2P daemon is not running: the gene was only removed from the republish table.");
        } else if (!result.ok) {
          display.error("Withdrawal failed", JSON.stringify(result.body));
          process.exitCode = 1;
          return;
        } else {
          withdrawn = (result.body as { withdrawn?: AnnouncedGene[] }).withdrawn ?? [];
        }
        if (withdrawn.length === 0) {
          display.error(`'${escapeTerminal(gene)}' is not announced from this node`);
          process.exitCode = 1;
          return;
        }
        for (const w of withdrawn) {
          display.success(`Stopped announcing '${escapeTerminal(w.name)}'`);
          display.kv("Gene ID (v2)", w.geneId);
        }
        display.info(WITHDRAW_LIMITS);
      })
  );
