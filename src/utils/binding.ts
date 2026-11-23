import { join } from "node:path";
import { existsSync } from "node:fs";
import { ensurePrivateDir } from "./private-fs.js";

export interface CompileResultView {
  irHash: string;
  totalSize: number;
  codeSectionSize: number;
  wasmAvailable: boolean;
}

export interface ExecutionResultView {
  success: boolean;
  output: unknown;
  errorMessage: string | null;
  fuelConsumed: number;
  memoryPeakKb: number;
  durationMs: number;
  sandboxType: string;
}

export interface L0CheckResultView {
  passed: boolean;
  violations: string[];
  checksPerformed: number;
}

export interface AlgebraResultView {
  success: boolean;
  output: unknown;
  errorMessage: string | null;
  stepsExecuted: number;
  totalFuelConsumed: number;
  totalDurationMs: number;
}

export interface NativeBinding {
  compileGeneToFile(
    wasmBytes: Buffer,
    phenotypeJson: string,
    outputPath: string
  ): CompileResultView;
  verifyIrModule(wasmBytes: Buffer): string;
  buildEchoGeneWasm(): Buffer;
  buildSearchGeneWasm(): Buffer;
  buildSummarizeGeneWasm(): Buffer;
  buildTranslateGeneWasm(): Buffer;
  executeGene(
    wasmBytes: Buffer,
    inputJson: string,
    phenotypeJson: string,
    constraintsJson?: string,
    /** v0.9.4 AgentMemory: {"agentId","geneId"}; omitted → the gene has no agent memory. */
    memoryContextJson?: string,
    /** #508: {"NAME":["host"]}, for an external gene; omitted → no limit. Call through utils/env-grant-consent. */
    credentialScopeJson?: string
  ): ExecutionResultView;
  l0Check(
    phenotypeJson: string,
    permissionsJson?: string,
    constraintsJson?: string
  ): L0CheckResultView;
  executeAlgebra(
    algebraJson: string,
    geneEntriesJson: string,
    inputJson: string,
    constraintsJson?: string,
    /** v0.9.4 AgentMemory: {"agentId"}; each gene runs as its entry's v2Id. */
    memoryContextJson?: string,
    /** #508: {"<gene key>":{"NAME":["host"]}}, per gene; a gene with no entry has no limit. */
    credentialScopeJson?: string
  ): AlgebraResultView;
}

let _binding: NativeBinding | null = null;
let _hasLoadAttempted = false;
let _rawModule: Record<string, unknown> | null = null;
let _hasModuleLoadAttempted = false;

const PLATFORM_PACKAGE_MAP: Record<string, string> = {
  "darwin-arm64": "@rotifer/playground-darwin-arm64",
  "darwin-x64": "@rotifer/playground-darwin-x64",
  "linux-x64": "@rotifer/playground-linux-x64-gnu",
  "win32-x64": "@rotifer/playground-win32-x64-msvc",
};

function initBinding(mod: Record<string, unknown>): NativeBinding | null {
  if (!mod.PlaygroundBinding) return null;
  const tmpDir = join(
    process.env.HOME || process.env.USERPROFILE || "/tmp",
    ".rotifer",
    "napi-binding"
  );
  ensurePrivateDir(tmpDir);
  return new (mod.PlaygroundBinding as new (dir: string) => NativeBinding)(tmpDir);
}

/**
 * Try to load the napi native addon.
 * Strategy: platform npm package first, then local .node file fallback.
 * Returns null if the addon is not available (fallback to pure-TS path).
 */
function loadRawModule(): Record<string, unknown> | null {
  if (_hasModuleLoadAttempted) return _rawModule;
  _hasModuleLoadAttempted = true;

  const platformKey = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PACKAGE_MAP[platformKey];
  if (pkgName) {
    try {
      _rawModule = require(pkgName) as Record<string, unknown>;
      return _rawModule;
    } catch {
      // platform package not installed — fall through to local search
    }
  }

  const localCandidates = [
    join(__dirname, "..", "..", `index.${platformKey}.node`),
    join(__dirname, "..", "..", `index.${process.platform}-${process.arch}.node`),
    join(__dirname, "..", "..", `rotifer-napi.${process.platform}-${process.arch}.node`),
  ];
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      try {
        _rawModule = require(candidate) as Record<string, unknown>;
        return _rawModule;
      } catch {
        // addon exists but failed to load — continue
      }
    }
  }

  return null;
}

export function tryLoadBinding(): NativeBinding | null {
  if (_hasLoadAttempted) return _binding;
  _hasLoadAttempted = true;
  const mod = loadRawModule();
  if (mod) _binding = initBinding(mod);
  return _binding;
}

/** A gene announcement received from a peer (mirrors the Rust napi struct). */
export interface ReceivedAnnouncement {
  geneId: string;
  name: string;
  domain: string;
  /** Display label claimed by the publisher — not part of the identity. */
  version: string;
  fidelity: string;
  irSpec: string;
  /** GossipSub-authenticated publisher PeerId. */
  publisher: string;
  source?: string;
}

/** One publisher's copy of a gene found by a network search (mirrors Rust). */
export interface NetworkSearchHit {
  geneId: string;
  name: string;
  domain: string;
  version: string;
  fidelity: string;
  irSpec: string;
  timestampMs: number;
  publisher: string;
  /** Where it was found: `dht`, `gossip` or `both`. */
  source: "dht" | "gossip" | "both";
  /** The publisher's registered account as the node knows it; absent if unregistered. */
  account?: string;
}

/** What a network search found within its 3-second deadline. */
export interface NetworkSearchResult {
  hits: NetworkSearchHit[];
  /** The deadline was hit with lookups still running. */
  timedOut: boolean;
  /** Results may be incomplete (deadline or a candidate cap). */
  partial: boolean;
}

/** Counts one announce observed (A2 design v2 §10.2). */
export interface NetworkAnnounceReport {
  geneId: string;
  gossipPeers: number;
  recordSent: number;
  recordAcked: number;
  readableFrom: number;
}

/**
 * Subset of the native `P2pNode` class surfaced to the CLI. Method names are
 * camelCase (napi converts the Rust snake_case automatically).
 */
/** One scheduled republish (A2 design v2 §7.2). */
export interface NetworkRepublishResult {
  /** `gone`: the files no longer compute a v2 ID; `changed`: they compute another one. */
  outcome: string;
  geneId: string;
  recordSent: number;
  recordAcked: number;
}

/** A node's answer to an issuer's challenge, unpadded base64url. */
export interface PorChallengeSignature {
  publicKey: string;
  signature: string;
}

/** Relay and connection settings for a new node (T-231 B2 design §8 PR-②); each left out keeps the default. */
export interface P2pNodeOptions {
  /** Relays to hold a reservation on (multiaddrs with `/p2p/<PeerId>`). */
  relays?: string[];
  /** Most established inbound connections. */
  maxInbound?: number;
  /** Most connections in their handshake, both directions together. */
  maxPending?: number;
  /** Serve as a relay (design §2.2 limits). */
  relayServer?: boolean;
  /** This node's public addresses, `/ip4/<public IPv4>/tcp/<port>` only. */
  announce?: string[];
  /** Accept loopback `announce` addresses (tests only). */
  allowLoopbackAnnounce?: boolean;
}

/** The node's counters `/status` reports (design §4.2); no peer's address, PeerId or score. */
export interface P2pNetworkStats {
  roles: { relayServer: boolean };
  announcedAddrs: string[];
  /** `lastTickAt` is Unix ms, stamped each second while the loop runs; null before start. */
  eventLoop: { lastTickAt: number | null; running: boolean };
  /** Null once the event loop has ended. */
  connections: { inbound: number; outbound: number } | null;
  limits: { inbound: number; outbound: number; pending: number };
  denials: {
    inboundLimit: number;
    pendingInboundLimit: number;
    outboundLimit: number;
    memory: number;
    blocked: number;
  };
  foreignPeersDropped: number;
  nat: {
    reachability: "unknown" | "public" | "private";
    relayReservations: number;
    relayedInbound: number;
    holePunchSucceeded: number;
    holePunchFailed: number;
  };
  relay: Record<string, number | boolean> & { advertising: boolean };
  gossip: { invalid: number; rateLimited: number; unregisteredTopic: number };
  dht: Record<string, number>;
}

export interface P2pNodeHandle {
  start(): void;
  peerId(): string;
  listenAddrs(): string[];
  discoveredPeers(): string[];
  /** Peers in the DHT routing table right now (absent in addons before A2 §8.1). */
  dhtPeers?(): string[];
  /** Peers with an open connection right now, DHT or not (absent likewise). */
  connectedPeers?(): string[];
  receivedAnnouncements(): ReceivedAnnouncement[];
  /** Announce the local gene `name` under `genesRoot`; returns its v2 ID. */
  announceLocalGene(genesRoot: string, name: string): string;
  /** Search the DHT and gossip for one v2 ID (absent in addons before A2 PR-3). */
  searchGene?(geneId: string): Promise<NetworkSearchResult>;
  /** Match name or domain among announcements heard on gossip (absent likewise). */
  searchKeyword?(query: string): Promise<NetworkSearchResult>;
  /** Announce over gossip and the DHT, reporting what was observed (absent likewise). */
  announceLocalGeneReport?(genesRoot: string, name: string): Promise<NetworkAnnounceReport>;
  /** Republish the record and provider entry if the files still compute `geneId` (absent before A2 PR-4). */
  republishLocalGene?(genesRoot: string, name: string, geneId: string): Promise<NetworkRepublishResult>;
  /** Stop providing `geneId` and drop this node's own copy of its record (absent likewise). */
  withdrawGene?(geneId: string): void;
  /** Answer an issuer's challenge; the node builds the message itself (absent before T-170). */
  signPorChallenge?(aud: string, userId: string, nonce: string, challengeExp: number): PorChallengeSignature;
  /** Carry this certificate in heartbeats, or none (absent likewise). */
  setAttestation?(token: string | null): void;
  /** Counters for `/status` (absent before T-231 PR-②). */
  networkStats?(): P2pNetworkStats;
  /** Whether the event loop is running (absent likewise). */
  eventLoopRunning?(): boolean;
  /** End the event loop as a crash would; tests only (absent likewise). */
  endEventLoopForTest?(): void;
  stop(): void;
}

/**
 * Construct a native libp2p P2P node. Returns null when the native addon is
 * unavailable (e.g. a pure-TS environment without the compiled `.node`), so
 * callers can degrade gracefully. mDNS LAN discovery is off unless asked for
 * (ADR-313: no default exposure); the daemon passes the CLI's `--no-mdns` choice.
 */
export function loadP2pNode(
  listenHost: string,
  listenPort: number,
  bootstrapPeers: string[],
  shouldUseMdns = false,
  options?: P2pNodeOptions,
): P2pNodeHandle | null {
  const mod = loadRawModule();
  // napi renders the Rust `P2pNode` as `P2PNode` (it uppercases the "p2p"
  // acronym); accept either spelling so both the raw addon and any JS wrapper work.
  const Ctor = (mod?.P2PNode ?? mod?.P2pNode) as
    | (new (
        host: string,
        port: number,
        peers: string[],
        shouldUseMdns?: boolean,
        trustAnchors?: undefined,
        options?: P2pNodeOptions,
      ) => P2pNodeHandle)
    | undefined;
  if (typeof Ctor !== "function") return null;
  // An addon before T-231 PR-② ignores the sixth argument; callers that pass
  // options check for `networkStats` to tell (see `supportsNodeOptions`).
  return new Ctor(listenHost, listenPort, bootstrapPeers, shouldUseMdns, undefined, options);
}

/** Whether this addon takes `P2pNodeOptions`: it came with `networkStats` (T-231 PR-②). */
export function supportsNodeOptions(node: P2pNodeHandle): boolean {
  return typeof node.networkStats === "function";
}

/** Outcome of computing a gene's v2 ID: the ID, or why it has none. */
export type GeneIdV2Result = { id: string } | { reason: string };

/**
 * Gene ID v2 of the gene `name` under `genesRoot` (docs/gene-id-v2.md).
 * Computed by the native addon — the single implementation — so it is
 * unavailable in a pure-TS environment.
 */
export function geneIdV2(genesRoot: string, name: string): GeneIdV2Result {
  const fn = loadRawModule()?.geneIdV2 as ((root: string, name: string) => string) | undefined;
  if (typeof fn !== "function") return { reason: "native module not available" };
  try {
    return { id: fn(genesRoot, name) };
  } catch (err) {
    return { reason: (err as Error).message.replace(/^gene ID not computable: /, "") };
  }
}

/** Whether the loaded native addon can compute v2 gene IDs (an older installed package cannot). */
export function hasNativeGeneIdV2(): boolean {
  return typeof loadRawModule()?.geneIdV2 === "function";
}

export function isNativeAvailable(): boolean {
  return tryLoadBinding() !== null;
}
