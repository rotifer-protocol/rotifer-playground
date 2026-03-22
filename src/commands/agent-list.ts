import { Command } from "commander";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { getProjectRoot } from "../utils/config.js";

interface AgentInfo {
  id: string;
  name: string;
  state: string;
  genome: string[];
  createdAt: string;
}

export const agentListCommand = new Command("list")
  .description("List all agents")
  .action(async () => {
    const root = getProjectRoot();

    display.header("Agent Registry");

    const agentsDir = join(root, ".rotifer", "agents");
    if (!existsSync(agentsDir)) {
      display.warn("No agents created yet");
      display.info("Create one: rotifer agent create <name> --genes <gene1> <gene2>");
      return;
    }

    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      display.warn("No agents created yet");
      display.info("Create one: rotifer agent create <name> --genes <gene1> <gene2>");
      return;
    }

    const agents: AgentInfo[] = files.map((f) => {
      return JSON.parse(readFileSync(join(agentsDir, f), "utf-8"));
    });

    console.log();
    console.log(
      "  " +
        padRight("Name", 20) +
        padRight("State", 12) +
        padRight("Genome", 30) +
        "Agent ID"
    );
    console.log("  " + "-".repeat(90));

    for (const a of agents) {
      const genomeStr = a.genome.length > 0 ? a.genome.join(", ") : "(empty)";
      console.log(
        "  " +
          padRight(a.name, 20) +
          padRight(a.state, 12) +
          padRight(genomeStr, 30) +
          a.id.slice(0, 12) + "..."
      );
    }
    console.log();
    display.info(`${agents.length} agent(s) registered`);
  });

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}
