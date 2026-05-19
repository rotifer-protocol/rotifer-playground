import { Command } from "commander";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import { requireProjectRoot } from "../utils/project-root.js";

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
    const root = requireProjectRoot();

    display.header("Agent Registry");

    const agentsDir = join(root, ".rotifer", "agents");
    if (!existsSync(agentsDir)) {
      display.warn("No agents created yet");
      display.hint("Create one: rotifer agent create <agent-name> --genes <gene1> <gene2>");
      return;
    }

    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      display.warn("No agents created yet");
      display.hint("Create one: rotifer agent create <agent-name> --genes <gene1> <gene2>");
      return;
    }

    const agents: AgentInfo[] = files.map((f) => {
      return JSON.parse(readFileSync(join(agentsDir, f), "utf-8"));
    });

    display.table(
      agents.map((a, i) => ({
        "#": i + 1,
        name: a.name,
        state: a.state,
        genome: a.genome.length > 0 ? a.genome.join(", ") : "(empty)",
        id: a.id,
      })),
      [
        { key: "#", label: "#", width: 4, align: "right" },
        { key: "name", label: "Name", width: 18 },
        {
          key: "state",
          label: "State",
          width: 10,
          format: (v: unknown) => {
            const s = String(v);
            const lower = s.toLowerCase();
            if (lower === "active" || lower === "idle") return c.success(s);
            if (lower === "running") return c.warn(s);
            if (lower === "terminated" || lower === "error") return c.error(s);
            return c.muted(s);
          },
        },
        { key: "genome", label: "Genome", width: 28 },
        { key: "id", label: "Agent ID" },
      ],
    );
    display.hint(`${agents.length} agent(s) registered`);
  });
