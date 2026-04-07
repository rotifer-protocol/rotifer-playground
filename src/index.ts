#!/usr/bin/env node

import { Command, Help } from "commander";
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
import { helloCommand } from "./commands/hello.js";
import { selfUpdateCommand } from "./commands/self-update.js";
import { userConfigCommand } from "./commands/user-config.js";
import { apiKeyCommand } from "./commands/api-key.js";
import { checkForUpdate, checkCacheSync, printUpdateNotification } from "./utils/update-check.js";
import { loadUserConfig } from "./utils/user-config.js";
import { setOutputMode, banner, formatGroupedHelp, formatSubcommandHelp } from "./utils/display.js";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const program = new Command();

program
  .name("rotifer")
  .description(
    "Rotifer Playground — development environment for the Rotifer Protocol"
  )
  .version(pkg.version)
  .option("--json", "Output machine-readable JSON to stdout")
  .option("--plain", "Output plain text without color/styling")
  .addHelpText("before", () => banner(pkg.version))
  .configureHelp({
    formatHelp(cmd: Command, helper: Help): string {
      if (cmd !== program) return formatSubcommandHelp(cmd, helper);
      return formatGroupedHelp(cmd, helper);
    },
  });

program.hook("preAction", () => {
  const opts = program.opts();
  if (opts.json) {
    setOutputMode("json");
  } else if (opts.plain) {
    setOutputMode("plain");
  }
});

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

program.addCommand(helloCommand);
program.addCommand(networkCommand);
program.addCommand(vgCommand);
program.addCommand(selfUpdateCommand);
program.addCommand(userConfigCommand);
program.addCommand(apiKeyCommand);

// Propagate themed help formatting to all subcommands.
// Commander.js v14 strips ANSI if getOutHasColors() is falsy,
// but we manage colors via chalk. Override to pass through.
(function propagateHelp(cmd: Command) {
  for (const sub of cmd.commands) {
    sub.configureHelp({
      formatHelp(_cmd: Command, helper: Help): string {
        return formatSubcommandHelp(_cmd, helper);
      },
    });
    sub.configureOutput({
      getOutHasColors: () => process.stdout.isTTY ?? false,
      getErrHasColors: () => process.stderr.isTTY ?? false,
    });
    propagateHelp(sub);
  }
})(program);

const userConfig = loadUserConfig();
if (userConfig["update-check"] !== false) {
  const cached = checkCacheSync("@rotifer/playground", pkg.version);
  if (cached) {
    process.on("exit", () => printUpdateNotification(cached, "@rotifer/playground"));
  }
  checkForUpdate("@rotifer/playground", pkg.version)
    .then((info) => {
      if (info && !cached) printUpdateNotification(info, "@rotifer/playground");
    })
    .catch(() => {});
}

program.parse();
