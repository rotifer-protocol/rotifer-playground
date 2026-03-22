import { Command } from "commander";
import chalk from "chalk";
import * as display from "../utils/display.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  if (!existsSync(ROTIFER_HOME)) {
    mkdirSync(ROTIFER_HOME, { recursive: true });
  }
  writeFileSync(NETWORK_CONFIG, JSON.stringify(config, null, 2) + "\n");
}

export const networkCommand = new Command("network")
  .description("P2P gene network commands (v0.5 foundation)")
  .addCommand(
    new Command("status")
      .description("Show network node status")
      .action(async () => {
        display.header("P2P Network Status");

        const config = loadNetworkConfig();
        saveNetworkConfig(config);

        console.log();
        display.keyValue("Node ID", config.node_id);
        display.keyValue(
          "Status",
          config.enabled
            ? chalk.green("● Active")
            : chalk.dim("○ Inactive")
        );
        display.keyValue("Listen Port", String(config.listen_port));
        display.keyValue("Bootstrap Peers", String(config.bootstrap_peers.length));
        console.log();

        if (!config.enabled) {
          display.info("Start the node: rotifer network start");
        }
      })
  )
  .addCommand(
    new Command("start")
      .description("Start the P2P node")
      .option("-p, --port <port>", "listen port", "9878")
      .action(async (options: { port: string }) => {
        display.header("Starting P2P Node");

        const config = loadNetworkConfig();
        config.listen_port = parseInt(options.port, 10);
        config.enabled = true;
        saveNetworkConfig(config);

        console.log();
        display.keyValue("Node ID", config.node_id);
        display.keyValue("Listen", `/ip4/0.0.0.0/tcp/${config.listen_port}`);
        display.keyValue("Protocol", "rotifer/gene-discovery/1.0.0");
        console.log();

        display.info("Connecting to bootstrap peers...");
        for (const peer of config.bootstrap_peers) {
          display.info(`  → ${peer}`);
        }
        console.log();

        display.warn(
          "P2P networking is in foundation stage (v0.5). " +
          "Gene metadata discovery is available; binary transfer uses Cloud CDN."
        );
        console.log();
        display.success("P2P node initialized");
        display.info(
          "In a future release, the node will run as a background daemon. " +
          "For now, network config is saved to ~/.rotifer/network.json"
        );
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
        display.header("Known Peers");

        const config = loadNetworkConfig();

        if (!config.enabled) {
          display.warn("P2P node is not active. Run 'rotifer network start' first.");
          return;
        }

        console.log();
        if (config.bootstrap_peers.length === 0) {
          display.warn("No peers discovered");
          return;
        }

        const col = { id: 6, addr: 44, status: 10 };
        console.log(
          "  " +
            padRight("#", col.id) +
            padRight("Address", col.addr) +
            "Status"
        );
        console.log("  " + "\u2500".repeat(60));

        for (let i = 0; i < config.bootstrap_peers.length; i++) {
          console.log(
            "  " +
              padRight(String(i + 1), col.id) +
              padRight(config.bootstrap_peers[i], col.addr) +
              chalk.dim("bootstrap")
          );
        }
        console.log();
        display.info(`${config.bootstrap_peers.length} peer(s) known`);
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
          display.info("Falling back to Cloud search...");
          console.log();
        }

        display.info(`Searching P2P network for: "${query}"`);
        display.info("Querying DHT for gene metadata...");
        console.log();

        display.warn(
          "P2P gene search is in foundation stage (stub). " +
          "Currently, all gene discovery goes through the Cloud Registry. " +
          "P2P metadata propagation will be available in a future release."
        );
        console.log();
        display.info("Use 'rotifer search' for Cloud-based gene discovery.");
      })
  )
  .addCommand(
    new Command("announce")
      .description("Announce a gene to the P2P network")
      .argument("<name>", "gene name to announce")
      .action(async (name: string) => {
        display.header("Gene Announcement");

        const config = loadNetworkConfig();

        if (!config.enabled) {
          display.warn("P2P node is not active. Run 'rotifer network start' first.");
          return;
        }

        display.info(`Announcing gene '${name}' to P2P network...`);
        display.info("Broadcasting gene metadata via GossipSub...");
        console.log();

        display.warn(
          "P2P gene announcement is in foundation stage (stub). " +
          "Gene metadata propagation to connected peers is planned for a future release. " +
          "For now, use 'rotifer publish' to share via Cloud Registry."
        );
      })
  );

function padRight(str: string, len: number): string {
  return str.length >= len ? str : str + " ".repeat(len - str.length);
}
