/**
 * P2P daemon + local control channel (§3.1 phase 2).
 *
 * Phase 1 ran the libp2p node only in the foreground (`start`) or one-shot
 * (`announce`). Phase 2 runs it as a persistent background daemon and lets
 * separate `rotifer network` commands talk to it over a loopback HTTP control
 * server (127.0.0.1, OS-assigned port), authenticated with a per-daemon token.
 *
 * State (PID + control port + token + PeerId) lives in `~/.rotifer/daemon.json`
 * (mode 0600). The token gates the control endpoints so other local processes
 * cannot drive the node.
 */
import { createServer, request } from "node:http";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ensurePrivateDir, tightenPrivateFile } from "./private-fs.js";
import { loadP2pNode } from "./binding.js";
import { Republisher, announcedTablePath, type WithdrawMatch } from "./announce-table.js";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer"
);
const DAEMON_STATE = join(ROTIFER_HOME, "daemon.json");

const TOKEN_HEADER = "x-rotifer-token";
const CONTROL_HOST = "127.0.0.1";

/** Cumulative same-IP counters from the native node (A6 design v3 §3.4). */
export interface ColocationStats {
  /** Distinct IPs that ever had more connected peers than P6's threshold. */
  ipsOverThreshold: number;
  /** Most connected peers ever seen on one IP. */
  maxPeersOnOneIp: number;
  /** Distinct IPs over the threshold while one of their peers held a valid proof of registration. */
  ipsOverThresholdWithRegisteredPeer: number;
}

/** Addons before A6 lack `colocationStats`. */
interface ColocationReader {
  colocationStats?(): ColocationStats;
}

export interface DaemonState {
  pid: number;
  /** Loopback control-server port (OS-assigned). */
  port: number;
  /** Per-daemon bearer token for the control endpoints. */
  token: string;
  peerId: string;
  startedAt: number;
}

export function readDaemonState(): DaemonState | null {
  if (!existsSync(DAEMON_STATE)) return null;
  try {
    return JSON.parse(readFileSync(DAEMON_STATE, "utf-8")) as DaemonState;
  } catch {
    return null;
  }
}

function writeDaemonState(state: DaemonState): void {
  ensurePrivateDir(ROTIFER_HOME);
  writeFileSync(DAEMON_STATE, JSON.stringify(state, null, 2) + "\n");
  tightenPrivateFile(DAEMON_STATE);
}

export function clearDaemonState(): void {
  try {
    rmSync(DAEMON_STATE, { force: true });
  } catch {
    /* best effort */
  }
}

export interface ControlResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/**
 * Send a control request to the running daemon. Returns null when no daemon is
 * recorded or it is unreachable (so callers can report "not running").
 */
/**
 * Control routes that work on the network take longer than the default 5 s:
 * a search answers by its 3 s deadline; an announce runs three 3 s steps.
 */
const ROUTE_TIMEOUT_MS: Record<string, number> = { "/search": 4000, "/announce": 15000 };

/** The daemon's republish table (A2 design v2 §7.3). */
const ANNOUNCED_TABLE = announcedTablePath(ROTIFER_HOME);

export function controlRequest(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = ROUTE_TIMEOUT_MS[path] ?? 5000,
): Promise<ControlResult | null> {
  const state = readDaemonState();
  if (!state) return Promise.resolve(null);

  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = request(
      {
        host: CONTROL_HOST,
        port: state.port,
        path,
        method,
        headers: {
          [TOKEN_HEADER]: state.token,
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed: unknown = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ ok: (res.statusCode ?? 0) < 400, status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Whether a daemon is recorded and answering its control server. */
export async function isDaemonRunning(): Promise<boolean> {
  const result = await controlRequest("GET", "/status");
  return result?.ok ?? false;
}

/**
 * Run the daemon: start the libp2p node, expose a token-gated loopback control
 * server, record the state file, and stay alive until stopped. Called from the
 * hidden `network __daemon` subcommand in a detached process.
 */
export async function runDaemon(
  listenHost: string,
  listenPort: number,
  bootstrapPeers: string[],
  shouldUseMdns: boolean,
): Promise<void> {
  const maybeNode = loadP2pNode(listenHost, listenPort, bootstrapPeers, shouldUseMdns);
  if (!maybeNode) {
    process.stderr.write("native P2P node unavailable; daemon cannot start\n");
    process.exit(1);
  }
  const node = maybeNode; // non-null below (incl. inside the control-server closure)
  node.start();
  const { colocationStats } = node as typeof node & ColocationReader;

  const token = randomBytes(24).toString("hex");
  const startedAt = Date.now();
  let isShuttingDown = false;

  // Republishing needs an addon that can republish and withdraw (A2 PR-4).
  const { republishLocalGene, withdrawGene } = node;
  const republisher =
    republishLocalGene && withdrawGene
      ? new Republisher({
          path: ANNOUNCED_TABLE,
          republish: (e) => republishLocalGene.call(node, e.genesRoot, e.name, e.geneId),
          withdraw: (geneId) => withdrawGene.call(node, geneId),
          hasDhtPeer: () => (node.dhtPeers ? node.dhtPeers().length > 0 : true),
          log: (line) => process.stderr.write(`${line}\n`),
        })
      : null;
  republisher?.restore();

  const server = createServer((req, res) => {
    const send = (code: number, obj: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.headers[TOKEN_HEADER] !== token) {
      send(403, { error: "forbidden" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${CONTROL_HOST}`);

    if (req.method === "GET" && url.pathname === "/status") {
      send(200, {
        peerId: node.peerId(),
        listenAddrs: node.listenAddrs(),
        peers: node.discoveredPeers().length,
        // An older native addon lacks these; leave them out rather than fail.
        ...(node.dhtPeers ? { dhtPeers: node.dhtPeers().length } : {}),
        ...(node.connectedPeers ? { connectedPeers: node.connectedPeers().length } : {}),
        // Cumulative same-IP counters (A6 design v3 §3.4); absent before A6.
        ...(colocationStats ? { colocation: colocationStats.call(node) } : {}),
        startedAt,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/peers") {
      send(200, { peers: node.discoveredPeers() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/received") {
      send(200, { announcements: node.receivedAnnouncements() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/announce") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        let g: { genesRoot?: string; name?: string };
        try {
          g = JSON.parse(data) as typeof g;
          if (!g.genesRoot || !g.name) throw new Error("genesRoot and name are required");
        } catch (err) {
          send(400, { error: (err as Error).message });
          return;
        }
        // The native node builds the wire record itself (v2 ID, fields,
        // IR spec version), so every field has a single implementation.
        if (node.announceLocalGeneReport) {
          const { genesRoot, name } = g;
          node.announceLocalGeneReport(genesRoot, name).then(
            (report) => {
              republisher?.added({ genesRoot, name, geneId: report.geneId });
              send(200, { ok: true, geneId: report.geneId, report });
            },
            (err: Error) => send(400, { error: err.message }),
          );
          return;
        }
        try {
          send(200, { ok: true, geneId: node.announceLocalGene(g.genesRoot, g.name) });
        } catch (err) {
          send(400, { error: (err as Error).message });
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/search") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        let q: { geneId?: string; keyword?: string };
        try {
          q = JSON.parse(data) as typeof q;
        } catch {
          send(400, { error: "body must be JSON" });
          return;
        }
        // An older native addon cannot search; say so instead of failing.
        const run =
          typeof q.geneId === "string"
            ? node.searchGene?.(q.geneId)
            : typeof q.keyword === "string"
              ? node.searchKeyword?.(q.keyword)
              : null;
        if (run === null) {
          send(400, { error: "geneId or keyword is required" });
          return;
        }
        if (run === undefined) {
          send(501, { error: "this native addon cannot search; update the CLI" });
          return;
        }
        run.then(
          (result) => send(200, result),
          (err: Error) => send(400, { error: err.message }),
        );
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/withdraw") {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => {
        let w: { geneId?: unknown; name?: unknown };
        try {
          w = JSON.parse(data) as typeof w;
        } catch {
          send(400, { error: "body must be JSON" });
          return;
        }
        const match: WithdrawMatch | null =
          typeof w.geneId === "string" ? { geneId: w.geneId } : typeof w.name === "string" ? { name: w.name } : null;
        if (!match) {
          send(400, { error: "geneId or name is required" });
          return;
        }
        if (!republisher) {
          send(501, { error: "this native addon cannot withdraw; update the CLI" });
          return;
        }
        try {
          send(200, { ok: true, withdrawn: republisher.withdraw(match) });
        } catch (err) {
          send(400, { error: (err as Error).message });
        }
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      send(200, { ok: true });
      shutdown();
      return;
    }
    send(404, { error: "not found" });
  });

  function shutdown(): void {
    if (isShuttingDown) return;
    isShuttingDown = true;
    republisher?.stop();
    try {
      node.stop();
    } catch {
      /* best effort */
    }
    server.close();
    clearDaemonState();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve, reject) => {
    server.listen(0, CONTROL_HOST, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      writeDaemonState({ pid: process.pid, port, token, peerId: node.peerId(), startedAt });
      resolve();
    });
    server.on("error", reject);
  });
  // The listening control server keeps the process alive; it exits via shutdown().
}
