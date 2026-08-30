/**
 * The one environment-variable check both telemetry paths share.
 *
 * ADR-329's decision is explicit: "ROTIFER_TELEMETRY=0 同时关闭匿名信号与
 * 登录上报——「关掉」意味着全部，与 316 的语义一致." Before this module
 * existed, `ROTIFER_TELEMETRY` was checked in exactly one place
 * (cloud/invocation.ts, for the signed-in Gene invocation report). Adding
 * the anonymous heartbeat with its own copy of that check would have been
 * the easy path and the wrong one: two copies of "is telemetry off" drift
 * the moment either one changes, and the failure mode is silent — a user
 * who set ROTIFER_TELEMETRY=0 expecting it to mean everything would keep
 * being counted by whichever path didn't get updated.
 *
 * DO_NOT_TRACK is the cross-tool convention (https://consoledonottrack.com/)
 * and is new here — ADR-316 predates it. It outranks ROTIFER_TELEMETRY
 * because it is a stance the user took before ever hearing of this project.
 */
export function telemetryOptedOutByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const dnt = (env.DO_NOT_TRACK || "").trim().toLowerCase();
  if (dnt !== "" && dnt !== "0" && dnt !== "false") return true;

  const flag = (env.ROTIFER_TELEMETRY || "").trim().toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

/**
 * True when the environment explicitly asked for telemetry (as opposed to
 * "unset, so whatever the default is"). Distinguishing "explicitly on" from
 * "unset" matters for the heartbeat: an explicit ROTIFER_TELEMETRY=1 should
 * win even over a stored "disabled" choice, the same way `codegraph
 * TELEMETRY=1` does — a per-shell override should not require first running
 * a separate command to change stored state.
 */
export function telemetryExplicitlyOnByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  if (telemetryOptedOutByEnv(env)) return false;
  const flag = (env.ROTIFER_TELEMETRY || "").trim().toLowerCase();
  return flag !== "" && flag !== "0" && flag !== "false" && flag !== "off";
}
