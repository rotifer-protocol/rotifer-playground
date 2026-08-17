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
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function telemetryOptedOut(): boolean {
  const flag = (process.env.ROTIFER_TELEMETRY || "").trim().toLowerCase();
  return flag === "0" || flag === "false" || flag === "off";
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

/**
 * Returns the id that was reported, or null when nothing was sent (and why,
 * for callers that want to say so). Never throws.
 */
export function recordGeneInvocation(geneDir: string): { reported: string | null; reason?: string } {
  if (telemetryOptedOut()) return { reported: null, reason: "telemetry-off" };

  const creds = loadCredentials();
  const callerId = creds?.user?.id;
  if (!callerId) return { reported: null, reason: "not-logged-in" };

  const geneId = cloudGeneId(geneDir);
  if (!geneId) return { reported: null, reason: "no-cloud-identity" };

  const config = loadCloudConfig();
  const url = `${config.endpoint.replace(/\/+$/, "")}/rest/v1/rpc/log_gene_invocation`;

  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: config.anonKey,
      Authorization: `Bearer ${creds!.access_token}`,
    },
    body: JSON.stringify({ p_gene_id: geneId, p_caller_agent_id: callerId }),
  })
    .then((res) => {
      if (!res.ok && process.env.ROTIFER_DEBUG) {
        process.stderr.write(`[rotifer] log_gene_invocation failed (${res.status})\n`);
      }
    })
    .catch((err: unknown) => {
      if (process.env.ROTIFER_DEBUG) {
        process.stderr.write(`[rotifer] log_gene_invocation error: ${(err as Error)?.message ?? err}\n`);
      }
    });

  return { reported: geneId };
}
