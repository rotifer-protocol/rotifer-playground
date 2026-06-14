import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir, tightenPrivateFile } from "../utils/private-fs.js";
import { loadP2pNode } from "../utils/binding.js";

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
    bootstrap_peers: [
      "/dns4/bootstrap.rotifer.dev/tcp/9878",
    ],
    enabled: false,
  };
}

function saveNetworkConfig(config: NetworkConfig): void {
  ensurePrivateDir(ROTIFER_HOME);
  writeFileSync(NETWORK_CONFIG, JSON.stringify(config, null, 2) + "\n");
  tightenPrivateFile(NETWORK_CONFIG);
}

export const networkCommand = new Command("network")
  .description("P2P gene network commands")
  .addCommand(
    new Command("status")
      .description("Show network node status")
      .action(async () => {
        const config = loadNetworkConfig();
        saveNetworkConfig(config);

        display.renderResult(config, (data) => {
          display.header("P2P Network Status");
          console.log();
          display.kv("Node ID", data.node_id);
          display.kv(
            "Status",
            data.enabled
              ? c.success("● Active")
              : c.muted("○ Inactive")
          );
          display.kv("Listen Port", String(data.listen_port));
          display.kv("Bootstrap Peers", String(data.bootstrap_peers.length));
          console.log();

          if (!data.enabled) {
            display.hint("Start the node: rotifer network start");
          }
        });
      })
  )
  .addCommand(
    new Command("start")
      .description("Start the P2P node (runs in the foreground until Ctrl-C)")
      .option("-p, --port <port>", "listen port", "9878")
      .action(async (options: { port: string }) => {
        display.header("Starting P2P Node");

        const config = loadNetworkConfig();
        const port = parseInt(options.port, 10);
        config.listen_port = port;

        const node = loadP2pNode(port, config.bootstrap_peers);
        if (!node) {
          display.warn("Native P2P node is unavailable in this build.");
          display.hint("This CLI was built without the compiled libp2p addon.");
          return;
        }

        try {
          node.start();
        } catch (err) {
          display.error("Failed to start the P2P node", (err as Error).message);
          process.exitCode = 1;
          return;
        }

        config.enabled = true;
        saveNetworkConfig(config);

        console.log();
        display.kv("PeerId", node.peerId());
        for (const addr of node.listenAddrs()) {
          display.kv("Listening", addr);
        }
        display.kv("Bootstrap peers", String(config.bootstrap_peers.length));
        console.log();
        display.success("P2P node running. Press Ctrl-C to stop.");

        // Keep the process alive while the node runs on its own runtime;
        // report newly discovered peers and shut down cleanly on a signal.
        await new Promise<void>((resolve) => {
          let knownPeers = 0;
          const timer = setInterval(() => {
            const count = node.discoveredPeers().length;
            if (count !== knownPeers) {
              knownPeers = count;
              display.info(`Discovered ${count} peer(s)`);
            }
          }, 3000);
          const shutdown = () => {
            clearInterval(timer);
            try {
              node.stop();
            } catch {
              /* best effort */
            }
            config.enabled = false;
            saveNetworkConfig(config);
            display.success("P2P node stopped");
            resolve();
          };
          process.once("SIGINT", shutdown);
          process.once("SIGTERM", shutdown);
        });
      })
  )
  .addCommand(
    new Command("stop")
      .description("Stop the P2P node")
      .action(async () => {
        const config = loadNetworkConfig();
        config.enabled = false;
        saveNetworkConfig(config);
        display.success("P2P node stopped");
      })
  )
  .addCommand(
    new Command("peers")
      .description("List known peers")
      .action(async () => {
        const config = loadNetworkConfig();

        if (!config.enabled) {
          display.warn("P2P node is not active. Run 'rotifer network start' first.");
          return;
        }

        display.renderResult(
          { peers: config.bootstrap_peers.map((addr, i) => ({ rank: i + 1, address: addr, status: "bootstrap" })) },
          (data) => {
            display.header("Known Peers", { separator: false });

            if (data.peers.length === 0) {
              display.warn("No peers discovered");
              return;
            }

            display.table(data.peers as unknown as Record<string, unknown>[], [
              { key: "rank", label: "#", width: 6, format: (v) => String(v) },
              { key: "address", label: "Address", width: 44 },
              { key: "status", label: "Status", width: 12, format: (v) => c.muted(String(v)) },
            ]);
            console.log();
            display.hint(`${data.peers.length} peer(s) known`);
          }
        );
      })
  )
  .addCommand(
    new Command("search")
      .description("Search genes via P2P network")
      .argument("<query>", "search keywords")
      .action(async (query: string) => {
        display.header("P2P Gene Search");

        const config = loadNetworkConfig();

        if (!config.enabled) {
          display.warn("P2P node is not active. Run 'rotifer network start' first.");
          display.info("P2P search is unavailable while the node is inactive.");
          console.log();
        }

        display.info(`Preparing P2P search for: "${query}"`);
        console.log();

        display.info("P2P metadata search is not yet available.");
        display.hint("Use 'rotifer search' for Cloud-based gene discovery.");
      })
  )
  .addCommand(
    new Command("announce")
      .description("Announce a local gene to the P2P network (one-shot)")
      .argument("<gene-name>", "gene name to announce")
      .action(async (geneName: string) => {
        display.header("Gene Announcement");

        const config = loadNetworkConfig();

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

        // Ephemeral listen port (0) so a one-shot announce never clashes with a
        // `network start` node already bound to the configured port.
        const node = loadP2pNode(0, config.bootstrap_peers);
        if (!node) {
          display.warn("Native P2P node is unavailable in this build.");
          display.hint("This CLI was built without the compiled libp2p addon.");
          return;
        }

        try {
          node.start();
          node.announceGene(
            geneName,
            pheno.name ?? geneName,
            pheno.domain ?? "",
            pheno.version ?? "0.0.0",
            pheno.fidelity ?? "Unknown"
          );
          console.log();
          display.kv("PeerId", node.peerId());
          display.kv("Topic", "/rotifer/announcements");
          // Give GossipSub a moment to propagate before tearing the node down.
          await new Promise((r) => setTimeout(r, 2000));
          display.success(`Announced '${geneName}' to the network`);
        } catch (err) {
          display.error("Announcement failed", (err as Error).message);
          process.exitCode = 1;
        } finally {
          try {
            node.stop();
          } catch {
            /* best effort */
          }
        }
      })
  );
