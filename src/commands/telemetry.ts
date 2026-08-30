import { Command } from "commander";
import * as display from "../utils/display.js";
import { c } from "../utils/palette.js";
import {
  loadOrInitHeartbeatConfig,
  setHeartbeatEnabled,
  resolveHeartbeatDecision,
  heartbeatDecisionEnabled,
  type HeartbeatDecision,
} from "../telemetry/config.js";

function describeDecision(d: HeartbeatDecision): string {
  switch (d) {
    case "off-env":
      return "off — DO_NOT_TRACK or ROTIFER_TELEMETRY in this shell";
    case "on-env":
      return "on — ROTIFER_TELEMETRY in this shell";
    case "off-stored":
      return "off — your stored choice (rotifer telemetry off)";
    case "on-stored":
      return "on — your stored choice (rotifer telemetry on)";
    case "on-default":
      return "on — default (ADR-329); nobody has chosen otherwise yet";
  }
}

export const telemetryCommand = new Command("telemetry")
  .description("Show or change the anonymous usage heartbeat")
  .action(() => {
    // `rotifer telemetry` with no subcommand — same shape as `codegraph
    // telemetry` with no argument, which this project measured its
    // telemetry design against (ADR-329). Aliases `status`.
    reportStatus();
  })
  .addCommand(
    new Command("status")
      .description("Show the current heartbeat state and why")
      .action(() => reportStatus()),
  )
  .addCommand(
    new Command("on")
      .description("Turn the anonymous heartbeat on")
      .action(() => {
        const config = setHeartbeatEnabled(true);
        display.success("Anonymous usage heartbeat: on");
        display.kv("Machine ID", config.machine_id);
        display.hint("No code, no identity — just \"this machine ran something today\".");
      }),
  )
  .addCommand(
    new Command("off")
      .description("Turn the anonymous heartbeat off")
      .action(() => {
        setHeartbeatEnabled(false);
        display.success("Anonymous usage heartbeat: off");
        display.hint("Nothing is sent — not even an opted-out notice.");
      }),
  );

function reportStatus(): void {
  const config = loadOrInitHeartbeatConfig();
  const decision = resolveHeartbeatDecision(config);
  const isEnabled = heartbeatDecisionEnabled(decision);

  display.header("Telemetry");
  display.kv("Anonymous heartbeat", isEnabled ? c.success("on") : c.muted("off"));
  display.kv("Reason", describeDecision(decision));
  display.kv("Machine ID", config.machine_id);
  console.log();
  display.hint("Details: https://rotifer.dev/telemetry");
  display.hint("`rotifer telemetry off` / ROTIFER_TELEMETRY=0 / DO_NOT_TRACK=1 all disable it.");
}
