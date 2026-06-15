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

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer"
);
const DAEMON_STATE = join(ROTIFER_HOME, "daemon.json");

const TOKEN_HEADER = "x-rotifer-token";
const CONTROL_HOST = "127.0.0.1";

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
export function controlRequest(
  method: string,
  path: string,
  body?: unknown
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
        timeout: 5000,
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
): Promise<void> {
  const maybeNode = loadP2pNode(listenHost, listenPort, bootstrapPeers);
  if (!maybeNode) {
    process.stderr.write("native P2P node unavailable; daemon cannot start\n");
    process.exit(1);
  }
  const node = maybeNode; // non-null below (incl. inside the control-server closure)
  node.start();

  const token = randomBytes(24).toString("hex");
  const startedAt = Date.now();
  let isShuttingDown = false;

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
        try {
          const g = JSON.parse(data) as Record<string, string>;
          node.announceGene(g.geneId, g.name, g.domain, g.version, g.fidelity);
          send(200, { ok: true });
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
