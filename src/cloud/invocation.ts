import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCloudConfig } from "./client.js";
import { loadCredentials } from "./auth.js";

/**
 * Report one execution of a Cloud-installed Gene to Rotifer Cloud.
 *
 * This is the CLI half of the invocation record that feeds the protocol's
 * anti-manipulation metrics (unique callers, dedup windows — spec §33.4). The
 * MCP server has reported its `run_gene` calls since 0.8.7; the CLI, which is
 * how most Genes actually get executed, never did. Combined with two other
 * breaks in the same pipeline the metrics stayed at zero from the day they
 * shipped, and the gate they drive ran on an empty table.
 *
 * Three conditions, all of them documented to users, all of them the same as
 * the MCP server's:
 *
 *   - Only Genes installed from Cloud carry a `.cloud-manifest.json`, and only
 *     those have an id to report against. A locally-authored Gene is silent.
 *   - Only when signed in. Signed out, nothing is sent (ADR-316 default).
 *   - `ROTIFER_TELEMETRY=0` (or `false` / `off`) switches it off entirely.
 *
 * Fire-and-forget: it never blocks or fails a run. But unlike the loggers this
 * was modelled on, a failed report is written to stderr when `ROTIFER_DEBUG` is
 * set rather than swallowed outright — a swallowed 400 is how the previous
 * pipeline stayed dead for months without anyone noticing.
 *
 * Fire-and-forget has one sharp edge, found the hard way on the first real
 * end-to-end run: `process.exit()` terminates immediately and does not wait for
 * a pending request, so every command that reports and then exits non-zero was
 * killing its own report mid-flight — no row, and not even the ROTIFER_DEBUG
 * line, because `.then` never ran. Callers that are about to exit must
 * `await flushInvocationReports()` first. Callers that simply return need not:
 * Node drains the pending request before the event loop empties.
 *
 * A fourth gate exists that users do not control: a test run reports nothing.
 * `tests/e2e/dogfooding-pipeline.test.ts` spawns the real CLI against the
 * repo's own Cloud-installed Genes, so on 2026-08-18 one `npm test` by a
 * signed-in developer wrote four invocation records straight into production —
 * source-linker twice, grammar-checker twice, timestamps two seconds apart.
 * Those are executions, but they are not usage, and §33.4's whole purpose is to
 * count callers who actually reached for a Gene. A metrics pipeline that
 * manufactures its own traffic is broken in the opposite direction from the one
 * this module was written to fix, and just as quietly.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Reports still in flight. Emptied as each settles; see flushInvocationReports. */
const inFlight = new Set<Promise<void>>();

/** Longest a caller will wait for reports to settle before exiting anyway. */
export const FLUSH_TIMEOUT_MS = 2000;

/**
 * Wait for any in-flight invocation reports to settle. Call this before
 * `process.exit()`; a run must never hang on telemetry, so it gives up after
 * FLUSH_TIMEOUT_MS and resolves regardless.
 */
export async function flushInvocationReports(timeoutMs: number = FLUSH_TIMEOUT_MS): Promise<void> {
  if (inFlight.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([Promise.allSettled([...inFlight]).then(() => undefined), deadline]);
  if (timer) clearTimeout(timer);
}

export function telemetryOptedOut(): boolean {
  const flag = (process.env.ROTIFER_TELEMETRY || "").trim().toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
}

/**
 * True when this process is a test run (or was spawned by one — `execSync` and
 * friends pass the environment down, which is exactly how the CLI under test
 * inherits these).
 *
 * Deliberately narrow: `CI` is NOT one of these. A Gene invoked from someone's
 * pipeline is still a caller reaching for it; a Gene invoked by a test asserting
 * that the pipeline compiles is not.
 */
export function runningUnderTest(): boolean {
  return Boolean(
    process.env.VITEST ||
      process.env.JEST_WORKER_ID ||
      (process.env.NODE_ENV || "").trim().toLowerCase() === "test",
  );
}

/** The Cloud id recorded when this Gene was installed, or null. */
export function cloudGeneId(geneDir: string): string | null {
  const manifestPath = join(geneDir, ".cloud-manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as { cloud_id?: unknown };
    const id = manifest.cloud_id;
    return typeof id === "string" && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

export interface InvocationReport {
  /** The Gene id reported, or null when nothing was sent. */
  reported: string | null;
  /** Why nothing was sent: telemetry-off | test-run | not-logged-in | no-cloud-identity. */
  reason?: string;
  /** Resolves when the POST settles; absent when nothing was sent. */
  settled?: Promise<void>;
  /** The channel attributed to this report, or null when none could be. */
  channel?: string | null;
}

/**
 * What the registry's `client_channel` column accepts: lowercase snake_case,
 * optionally one colon qualifying a transport with its host. Mirrored from the
 * CHECK constraint in migration 20260830000000 — kept in sync deliberately,
 * because a value this side considers fine and the database rejects would fail
 * the whole report, and reporting is fire-and-forget: nobody would find out.
 */
const CHANNEL_RE = /^[a-z0-9_]{1,32}(:[a-z0-9_]{1,32})?$/;

/**
 * Who is reporting this invocation.
 *
 * Defaults to `cli`, because that is what this process is. When the CLI was
 * spawned by something else — today the MCP server's `run_gene`, which shells
 * out rather than executing Genes itself — that parent sets
 * ROTIFER_INVOCATION_CHANNEL and the run is attributed to the real entry point
 * instead of to the CLI that happens to be doing the work.
 *
 * Why the parent tells us rather than us guessing: the alternative is
 * inspecting the process tree, which differs per platform and per host, and
 * would quietly mislabel every host it has not been taught about. An explicit
 * handshake is either present and correct, or absent and honestly `cli`.
 *
 * A malformed value is dropped rather than sanitised. Silently rewriting
 * `Claude Code` into `claude_code` would invent an attribution the caller
 * never made; null says "not attributable", which is true and readable.
 */
export function resolveInvocationChannel(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const declared = (env.ROTIFER_INVOCATION_CHANNEL || "").trim();
  if (!declared) return "cli";
  return CHANNEL_RE.test(declared) ? declared : null;
}

/**
 * Returns the id that was reported, or null when nothing was sent (and why,
 * for callers that want to say so). Never throws.
 */
export function recordGeneInvocation(geneDir: string): InvocationReport {
  if (telemetryOptedOut()) return { reported: null, reason: "telemetry-off" };
  if (runningUnderTest()) return { reported: null, reason: "test-run" };

  const creds = loadCredentials();
  const callerId = creds?.user?.id;
  if (!callerId) return { reported: null, reason: "not-logged-in" };

  const geneId = cloudGeneId(geneDir);
  if (!geneId) return { reported: null, reason: "no-cloud-identity" };

  const channel = resolveInvocationChannel();

  // v2 carries the channel; the original entry point is still there for
  // clients that predate it, and both share one idempotency guard server-side
  // (migration 20260830000000) so an MCP call reported through both is still
  // one row. When the channel is unattributable we call the older function
  // rather than sending an explicit null: same outcome in the ledger, and it
  // keeps "no channel" from looking like a client that tried and failed.
  const config = loadCloudConfig();
  const rpc = channel === null ? "log_gene_invocation" : "log_gene_invocation_v2";
  const url = `${config.endpoint.replace(/\/+$/, "")}/rest/v1/rpc/${rpc}`;

  const settled = fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.anonKey,
      Authorization: `Bearer ${creds!.access_token}`,
    },
    body: JSON.stringify(
      channel === null
        ? { p_gene_id: geneId, p_caller_agent_id: callerId }
        : { p_gene_id: geneId, p_caller_agent_id: callerId, p_client_channel: channel },
    ),
  })
    .then((res) => {
      if (!res.ok && process.env.ROTIFER_DEBUG) {
        process.stderr.write(`[rotifer] ${rpc} failed (${res.status})\n`);
      }
    })
    .catch((err: unknown) => {
      if (process.env.ROTIFER_DEBUG) {
        process.stderr.write(`[rotifer] ${rpc} error: ${(err as Error)?.message ?? err}\n`);
      }
    })
    .finally(() => {
      inFlight.delete(settled);
    });

  inFlight.add(settled);
  return { reported: geneId, settled, channel };
}
