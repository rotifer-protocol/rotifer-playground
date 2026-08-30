/**
 * Anonymous usage heartbeat (ADR-329).
 *
 * Answers a narrower question than gene_invocation_log: not "who called
 * what", just "did this machine run something today, and through which
 * channel". No identity, on by default, and — unlike the invocation report
 * — it costs nothing to lose one. It is not §33.4 input; a dropped
 * heartbeat is not a hole in an audited ledger, it is one machine's "active
 * today" signal that will show up again tomorrow if the machine is still in
 * use. That is why this file, unlike cloud/invocation.ts, does not track
 * in-flight requests for a caller to await before process.exit() — the
 * reliability engineering that report needs would be pure overhead here.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCloudConfig } from "../cloud/client.js";
import { resolveInvocationChannel, runningUnderTest } from "../cloud/invocation.js";
import {
  loadOrInitHeartbeatConfig,
  resolveHeartbeatDecision,
  heartbeatDecisionEnabled,
  markFirstRunNoticeShown,
  type HeartbeatConfig,
} from "./config.js";

// __dirname is CommonJS's own global here (see tsconfig's "module": "NodeNext"
// targeting CJS output) — no fileURLToPath(import.meta.url) needed, and that
// ESM-only syntax would fail to compile in this build target anyway.
let cachedVersion: string | null = null;
function packageVersion(): string | null {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    cachedVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/**
 * The one-line disclosure, printed to stderr exactly once, before the first
 * heartbeat this machine ever actually sends — never before, so a machine
 * whose heartbeat is off (env or stored choice) never sees a notice about
 * data that is never leaving it. Mirrors codegraph's wording pattern
 * (ADR-329 measured its design against codegraph's, verified against its
 * compiled output) but says MCP explicitly, because stderr is where CLI
 * users look and exactly where MCP hosts do not — the MCP side of this
 * (rotifer-mcp-server) carries the notice in a tool response instead, for
 * that reason.
 */
function printFirstRunNotice(): void {
  process.stderr.write(
    "[rotifer] Anonymous usage heartbeat is on by default — no code, no identity, just " +
      "\"this machine ran something today\". `rotifer telemetry off`, ROTIFER_TELEMETRY=0, " +
      "or DO_NOT_TRACK=1 disables it. Details: https://rotifer.dev/telemetry\n",
  );
}

/**
 * Reports one Gene invocation's worth of activity for this machine, today,
 * on the given channel. Fire-and-forget; every failure mode is silence,
 * same contract as recordGeneInvocation. Safe to call unconditionally from
 * every call site that already calls recordGeneInvocation — this function
 * does its own consent and test-run checks.
 */
export function recordHeartbeat(): void {
  // The whole body is one try/catch, deliberately wider than the network
  // call. loadOrInitHeartbeatConfig()/markFirstRunNoticeShown() write to
  // ~/.rotifer/telemetry.json — config.ts does not swallow that failure
  // (rotifer telemetry on/off should surface a write error to the user who
  // ran it), but a Gene execution silently failing because this
  // fire-and-forget signal couldn't touch the filesystem would be a much
  // worse trade. Every failure mode here is silence, same contract as the
  // network call below.
  try {
    if (runningUnderTest()) return;

    const channel = resolveInvocationChannel();
    if (channel === null) return; // unattributable declared channel — see resolveInvocationChannel

    const config: HeartbeatConfig = loadOrInitHeartbeatConfig();
    const decision = resolveHeartbeatDecision(config);
    if (!heartbeatDecisionEnabled(decision)) return;

    // Only reached once we know a report is actually about to leave the
    // process — see printFirstRunNotice's doc comment for why the ordering
    // matters. Persisted synchronously so a crash in the fetch below can
    // never cause the notice to reprint on the next run.
    if (!config.first_run_notice_shown) {
      printFirstRunNotice();
      markFirstRunNoticeShown(config);
    }

    const cloudConfig = loadCloudConfig();
    const url = `${cloudConfig.endpoint.replace(/\/+$/, "")}/rest/v1/rpc/record_heartbeat`;

    // No Authorization header: record_heartbeat is anon-callable by design
    // (migration 20260830010000) — that grant is the entire point of ADR-329.
    // Sending credentials here would be pointless (the RPC does not use them)
    // and would defeat the "no identity" promise for a user who happens to be
    // signed in but has not opted into the signed-in invocation report.
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cloudConfig.anonKey },
      body: JSON.stringify({
        p_machine_id: config.machine_id,
        p_channel: channel,
        p_client_version: packageVersion(),
        p_invocation_delta: 1,
      }),
    })
      .then((res) => {
        if (!res.ok && process.env.ROTIFER_DEBUG) {
          process.stderr.write(`[rotifer] record_heartbeat failed (${res.status})\n`);
        }
      })
      .catch((err: unknown) => {
        if (process.env.ROTIFER_DEBUG) {
          process.stderr.write(`[rotifer] record_heartbeat error: ${(err as Error)?.message ?? err}\n`);
        }
      });
  } catch (err: unknown) {
    if (process.env.ROTIFER_DEBUG) {
      process.stderr.write(`[rotifer] record_heartbeat setup error: ${(err as Error)?.message ?? err}\n`);
    }
  }
}
