import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { existsSync, readFileSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { ensurePrivateDir, tightenPrivateFile } from "../utils/private-fs.js";
import { loadP2pNode, type ReceivedAnnouncement } from "../utils/binding.js";
import {
  controlRequest,
  isDaemonRunning,
  readDaemonState,
  runDaemon,
} from "../utils/p2p-daemon.js";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer"
);
const NETWORK_CONFIG = join(ROTIFER_HOME, "network.json");

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
    bootstrap_peers: ["/dns4/bootstrap.rotifer.dev/tcp/9878"],
    enabled: false,
  };
}

function saveNetworkConfig(config: NetworkConfig): void {
  ensurePrivateDir(ROTIFER_HOME);
  writeFileSync(NETWORK_CONFIG, JSON.stringify(config, null, 2) + "\n");
  tightenPrivateFile(NETWORK_CONFIG);
}

/** Spawn the daemon as a detached background process, logging to ~/.rotifer/daemon.log. */
function spawnDaemon(host: string, port: number, bootstrapPeers: string[]): void {
  ensurePrivateDir(ROTIFER_HOME);
  const logFd = openSync(join(ROTIFER_HOME, "daemon.log"), "a");
  const args = [process.argv[1], "network", "__daemon", "--host", host, "--port", String(port)];
  for (const peer of bootstrapPeers) {
    args.push("--bootstrap", peer);
  }
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
      .description("Show P2P daemon status")
      .action(async () => {
        const config = loadNetworkConfig();
        saveNetworkConfig(config);
        const status = await controlRequest("GET", "/status");

        display.header("P2P Network Status");
        console.log();
        if (status?.ok) {
          const s = status.body as {
            peerId: string;
            listenAddrs: string[];
            peers: number;
          };
          display.kv("Status", c.success("● Running"));
          display.kv("PeerId", s.peerId);
          for (const addr of s.listenAddrs) display.kv("Listening", addr);
          display.kv("Discovered peers", String(s.peers));
        } else {
          display.kv("Status", c.muted("○ Not running"));
          display.kv("Listen Port", String(config.listen_port));
          display.kv("Bootstrap Peers", String(config.bootstrap_peers.length));
          console.log();
          display.hint("Start the daemon: rotifer network start");
        }
        console.log();
      })
  )
  .addCommand(
    new Command("start")
      .description("Start the P2P node as a background daemon")
      .option("-p, --port <port>", "listen port", "9878")
      .option(
        "-H, --host <addr>",
        "listen interface: 127.0.0.1 (loopback) or 0.0.0.0 (reachable from other machines)",
        "127.0.0.1",
      )
      .option("-b, --bootstrap <addr...>", "bootstrap peer multiaddr(s); overrides config")
      .action(async (options: { port: string; host: string; bootstrap?: string[] }) => {
        display.header("Starting P2P Daemon");

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

        spawnDaemon(host, port, bootstrap);
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
        console.log();
        display.success("P2P daemon running in the background.");
        if (host !== "127.0.0.1") {
          display.hint("'rotifer network status' shows the reachable multiaddr — give it to other nodes as --bootstrap");
        }
        display.hint("rotifer network peers / announce / status / stop");
      })
  )
  // Hidden: the long-running daemon process spawned by `start`.
  .addCommand(
    new Command("__daemon")
      .description("(internal) run the P2P daemon")
      .option("-H, --host <addr>", "listen interface", "127.0.0.1")
      .option("-p, --port <port>", "listen port", "9878")
      .option("--bootstrap <addr...>", "bootstrap multiaddr(s)")
      .action(async (options: { host: string; port: string; bootstrap?: string[] }) => {
        await runDaemon(options.host, parseInt(options.port, 10), options.bootstrap ?? []);
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
          const from = (a.source ?? a.publisher).slice(0, 16);
          display.kv(`${a.name}@${a.version}`, `${a.domain} · ${a.fidelity} · from ${from}…`);
        }
        console.log();
        display.hint(`${anns.length} announcement(s) received`);
      })
  )
  .addCommand(
    new Command("search")
      .description("Search genes via the P2P network")
      .argument("<query>", "search keywords")
      .action(async (query: string) => {
        display.header("P2P Gene Search");
        if (!(await isDaemonRunning())) {
          display.warn("P2P daemon is not running. Run 'rotifer network start' first.");
          console.log();
        }
        display.info(`Preparing P2P search for: "${query}"`);
        console.log();
        display.info("P2P metadata search (DHT) is not yet available.");
        display.hint("Use 'rotifer search' for Cloud-based gene discovery.");
      })
  )
  .addCommand(
    new Command("announce")
      .description("Announce a local gene through the running daemon")
      .argument("<gene-name>", "gene name to announce")
      .action(async (geneName: string) => {
        display.header("Gene Announcement");

        const phenotypePath = join(process.cwd(), "genes", geneName, "phenotype.json");
        if (!existsSync(phenotypePath)) {
          display.error(`Gene '${geneName}' not found`, `expected ${phenotypePath}`);
          process.exitCode = 1;
          return;
        }
        let pheno: { name?: string; domain?: string; version?: string; fidelity?: string };
        try {
          pheno = JSON.parse(readFileSync(phenotypePath, "utf-8"));
        } catch (err) {
          display.error("Failed to read phenotype.json", (err as Error).message);
          process.exitCode = 1;
          return;
        }

        const result = await controlRequest("POST", "/announce", {
          geneId: geneName,
          name: pheno.name ?? geneName,
          domain: pheno.domain ?? "",
          version: pheno.version ?? "0.0.0",
          fidelity: pheno.fidelity ?? "Unknown",
        });
        if (!result) {
          display.warn("P2P daemon is not running. Run 'rotifer network start' first.");
          return;
        }
        if (!result.ok) {
          display.error("Announcement failed", JSON.stringify(result.body));
          process.exitCode = 1;
          return;
        }
        display.success(`Announced '${geneName}' to the network`);
      })
  );
