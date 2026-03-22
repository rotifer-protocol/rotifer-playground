#!/usr/bin/env node

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initCommand } from "./commands/init.js";
import { scanCommand } from "./commands/scan.js";
import { wrapCommand } from "./commands/wrap.js";
import { testCommand } from "./commands/test.js";
import { compileCommand } from "./commands/compile.js";
import { arenaSubmitCommand } from "./commands/arena-submit.js";
import { arenaListCommand } from "./commands/arena-list.js";
import { arenaWatchCommand } from "./commands/arena-watch.js";
import { agentCreateCommand } from "./commands/agent-create.js";
import { agentListCommand } from "./commands/agent-list.js";
import { agentRunCommand } from "./commands/agent-run.js";
import { loginCommand } from "./commands/login.js";
import { logoutCommand } from "./commands/logout.js";
import { publishCommand } from "./commands/publish.js";
import { searchCommand } from "./commands/search.js";
import { installCommand } from "./commands/install.js";
import { reputationCommand } from "./commands/reputation.js";
import { infoCommand } from "./commands/info.js";
import { listCommand } from "./commands/list.js";
import { runCommand } from "./commands/run.js";
import { versionsCommand } from "./commands/versions.js";
import { whoamiCommand } from "./commands/whoami.js";
import { statsCommand } from "./commands/stats.js";
import { compareCommand } from "./commands/compare.js";
import { networkCommand } from "./commands/network.js";
import { vgCommand } from "./commands/vg.js";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("rotifer")
  .description(
    "Rotifer Playground — development environment for the Rotifer Protocol"
  )
  .version(pkg.version);

program.addCommand(initCommand);
program.addCommand(scanCommand);
program.addCommand(wrapCommand);
program.addCommand(testCommand);
program.addCommand(compileCommand);

program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(publishCommand);
program.addCommand(searchCommand);
program.addCommand(installCommand);
program.addCommand(reputationCommand);
program.addCommand(infoCommand);
program.addCommand(listCommand);
program.addCommand(runCommand);
program.addCommand(versionsCommand);
program.addCommand(whoamiCommand);
program.addCommand(statsCommand);
program.addCommand(compareCommand);

const arena = program.command("arena").description("Arena competition commands");
arena.addCommand(arenaSubmitCommand);
arena.addCommand(arenaListCommand);
arena.addCommand(arenaWatchCommand);

const agent = program.command("agent").description("Agent lifecycle commands");
agent.addCommand(agentCreateCommand);
agent.addCommand(agentListCommand);
agent.addCommand(agentRunCommand);

program.addCommand(networkCommand);
program.addCommand(vgCommand);

program.parse();
