import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir, tightenPrivateFile } from "../utils/private-fs.js";

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
      .description("Start the P2P node")
      .option("-p, --port <port>", "listen port", "9878")
      .action(async (options: { port: string }) => {
        display.header("Starting P2P Node");

        const config = loadNetworkConfig();
        config.listen_port = parseInt(options.port, 10);
        config.enabled = true;
        saveNetworkConfig(config);

        console.log();
        display.kv("Node ID", config.node_id);
        display.kv("Listen", `/ip4/0.0.0.0/tcp/${config.listen_port}`);
        display.kv("Protocol", "rotifer/gene-discovery/1.0.0");
        console.log();

        display.info("Configured bootstrap peers:");
        for (const peer of config.bootstrap_peers) {
          display.info(`  → ${peer}`);
        }
        console.log();

        display.success("P2P node initialized");
        display.info("Gene metadata discovery is available; binary transfer uses Cloud CDN.");
        display.hint("Network config saved to ~/.rotifer/network.json");
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
      .description("Announce a gene to the P2P network")
      .argument("<gene-name>", "gene name to announce")
      .action(async (geneName: string) => {
        display.header("Gene Announcement");

        const config = loadNetworkConfig();

        if (!config.enabled) {
          display.warn("P2P node is not active. Run 'rotifer network start' first.");
          return;
        }

        display.info(`Preparing announcement for gene '${geneName}'...`);
        console.log();

        display.info("P2P gene announcement is not yet available.");
        display.hint("Use 'rotifer publish' to share via Cloud Registry.");
      })
  );
