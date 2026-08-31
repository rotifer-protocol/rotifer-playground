/**
 * Anonymous usage heartbeat (ADR-329).
 *
 * Answers a narrower question than gene_invocation_log: not "who called
 * what", just "did this machine run something today, and through which
 * channel". No identity, on by default, and — unlike the invocation report
 * — it costs nothing to lose one. It is not §33.4 input; a dropped
 * heartbeat is not a hole in an audited ledger, it is one machine's "active
 * today" signal that will show up again tomorrow if the machine is still in
 * use.
 *
 * This file used to not track in-flight requests at all, on the theory that
 * "Node drains the pending request before the event loop empties" (the same
 * assumption cloud/invocation.ts's success path relies on) made it
 * unnecessary here. A real end-to-end run against production — `rotifer run`
 * on a freshly-provisioned machine, 2026-08-30 — showed that assumption does
 * not hold for this fetch: the CLI printed the first-run notice (proof the
 * request was sent) and exited 0, and the row never arrived. A manual POST
 * with the same body against the same machine_id landed immediately, which
 * rules out the RPC, the grant, and the endpoint — the only thing different
 * was that the CLI process existed for a few hundred more milliseconds. So
 * this now tracks in-flight requests the same way cloud/invocation.ts does,
 * and every call site that can exit soon after calling recordHeartbeat()
 * must await flushHeartbeat() first, exactly like flushInvocationReports().
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

/** Heartbeat reports still in flight. Emptied as each settles; see flushHeartbeat. */
const inFlight = new Set<Promise<void>>();

/** Longest a caller will wait for a heartbeat to settle before exiting anyway. */
export const FLUSH_TIMEOUT_MS = 2000;

/**
 * Wait for any in-flight heartbeat report to settle. Call this before
 * `process.exit()` — and before returning from a command that is about to let
 * the process exit on its own, since that path turned out not to be safe
 * either (see this file's top comment). A run must never hang on telemetry,
 * so it gives up after timeoutMs and resolves regardless.
 */
export async function flushHeartbeat(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
  if (inFlight.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled([...inFlight]).then(() => undefined), deadline]);
  if (timer) clearTimeout(timer);
}

/**
 * Reports one Gene invocation's worth of activity for this machine, today,
 * on the given channel. Fire-and-forget; every failure mode is silence,
 * same contract as recordGeneInvocation. Safe to call unconditionally from
 * every call site that already calls recordGeneInvocation — this function
 * does its own consent and test-run checks. The request it sends is tracked
 * in `inFlight` until it settles — see flushHeartbeat.
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
    const settled: Promise<void> = fetch(url, {
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
      })
      .finally(() => {
        inFlight.delete(settled);
      });
    inFlight.add(settled);
  } catch (err: unknown) {
    if (process.env.ROTIFER_DEBUG) {
      process.stderr.write(`[rotifer] record_heartbeat setup error: ${(err as Error)?.message ?? err}\n`);
    }
  }
}
