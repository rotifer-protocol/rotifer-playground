/**
 * Storage and consent state for the anonymous usage heartbeat (ADR-329).
 *
 * Lives in ~/.rotifer/telemetry.json, the same directory (and the same
 * private-mode convention — see private-fs.ts) as credentials.json and
 * cloud.json. Deliberately the same shape as codegraph's
 * ~/.codegraph/telemetry.json (ADR-329's Context section names it as the
 * design this is measured against): `enabled`, `machine_id`,
 * `consent_source`, `first_run_notice_shown`, `updated_at`.
 *
 * This file is shared, in practice, with rotifer-mcp-server: both processes
 * read and write ~/.rotifer/telemetry.json on the same machine, so a
 * machine_id minted by one is picked up by the other rather than each
 * inventing its own. mcp-server carries its own copy of this module (no
 * cross-package import — they are separate npm packages) but the on-disk
 * shape must stay identical, or one process's write would look like
 * corruption to the other's reader.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDir, tightenPrivateFile } from "../utils/private-fs.js";
import { telemetryOptedOutByEnv, telemetryExplicitlyOnByEnv } from "./consent.js";

const ROTIFER_HOME = join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".rotifer",
);
const TELEMETRY_CONFIG_FILE = "telemetry.json";

export type ConsentSource = "installer" | "cli" | "default-notice";

export interface HeartbeatConfig {
  /** The user's stored choice. Irrelevant when an env var overrides it. */
  enabled: boolean;
  /** Random UUIDv4, minted once. Never derived from hardware, paths, or identity. */
  machine_id: string;
  consent_source: ConsentSource;
  /** Gates the one-line notice — see maybeAnnounceFirstRun below. */
  first_run_notice_shown: boolean;
  updated_at: string;
}

function telemetryConfigPath(): string {
  return join(ROTIFER_HOME, TELEMETRY_CONFIG_FILE);
}

function readStoredConfig(): HeartbeatConfig | null {
  const p = telemetryConfigPath();
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf-8")) as Partial<HeartbeatConfig>;
    if (typeof parsed.machine_id !== "string" || !parsed.machine_id) return null;
    return {
      enabled: parsed.enabled !== false,
      machine_id: parsed.machine_id,
      consent_source: parsed.consent_source ?? "default-notice",
      first_run_notice_shown: parsed.first_run_notice_shown === true,
      updated_at: parsed.updated_at ?? new Date(0).toISOString(),
    };
  } catch {
    // A corrupt file is treated the same as a missing one: a fresh
    // machine_id is minted below. Losing continuity on a corrupt file is a
    // acceptable one-time cost; refusing to run telemetry at all until a
    // human fixes the file is not — this is opt-out telemetry, not a wallet.
    return null;
  }
}

function writeStoredConfig(config: HeartbeatConfig): void {
  ensurePrivateDir(ROTIFER_HOME);
  const p = telemetryConfigPath();
  writeFileSync(p, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  tightenPrivateFile(p);
}

/**
 * Reads the stored config, minting one (with a fresh machine_id) on first
 * ever call. This is the read path every reporting call goes through — it
 * is cheap (one small JSON file) and idempotent, so there is no reason to
 * cache it across calls within a process; a concurrent `rotifer telemetry
 * off` in another terminal should be picked up by the next report, not
 * shadowed by a stale in-memory copy.
 */
export function loadOrInitHeartbeatConfig(): HeartbeatConfig {
  const existing = readStoredConfig();
  if (existing) return existing;

  const fresh: HeartbeatConfig = {
    enabled: true,
    machine_id: randomUUID(),
    consent_source: "default-notice",
    first_run_notice_shown: false,
    updated_at: new Date().toISOString(),
  };
  writeStoredConfig(fresh);
  return fresh;
}

/** Backs `rotifer telemetry on|off`. Keeps the existing machine_id. */
export function setHeartbeatEnabled(isEnabled: boolean): HeartbeatConfig {
  const current = loadOrInitHeartbeatConfig();
  const updated: HeartbeatConfig = {
    ...current,
    enabled: isEnabled,
    consent_source: "cli",
    // Explicitly setting the choice via the CLI counts as having seen
    // whatever notice there was to see — this must not print again.
    first_run_notice_shown: true,
    updated_at: new Date().toISOString(),
  };
  writeStoredConfig(updated);
  return updated;
}

export function resetHeartbeatIdentity(): void {
  const p = telemetryConfigPath();
  if (existsSync(p)) {
    writeFileSync(p, "", { mode: 0o600 });
  }
  // Deleting would also work; overwriting with an empty file and letting the
  // next loadOrInitHeartbeatConfig() call treat it as corrupt-and-remint is
  // simpler than importing unlinkSync for a rarely-used reset path.
}

export type HeartbeatDecision =
  | "off-env"
  | "on-env"
  | "off-stored"
  | "on-stored"
  | "on-default";

/**
 * Resolution order, mirrored in TELEMETRY.md and kept in sync deliberately:
 *   DO_NOT_TRACK / ROTIFER_TELEMETRY (env, either direction) > stored choice
 *   > default on.
 *
 * The heartbeat's default is the opposite of gene_invocation_log's
 * (ADR-316 D1 default-off) on purpose — see the migration header on
 * usage_heartbeat for why: this table carries no per-row accountability to
 * protect, and default-off here would just reproduce the blind spot
 * ADR-329 exists to close.
 */
export function resolveHeartbeatDecision(
  config: HeartbeatConfig,
  env: NodeJS.ProcessEnv = process.env,
): HeartbeatDecision {
  if (telemetryOptedOutByEnv(env)) return "off-env";
  if (telemetryExplicitlyOnByEnv(env)) return "on-env";
  if (!config.enabled) return "off-stored";
  return config.consent_source === "default-notice" ? "on-default" : "on-stored";
}

export function heartbeatDecisionEnabled(d: HeartbeatDecision): boolean {
  return d === "on-env" || d === "on-stored" || d === "on-default";
}

/**
 * Marks the first-run notice as shown and persists it — separated from
 * printing the notice itself (in heartbeat.ts) so the persistence, which
 * must happen exactly once and survive even if the network call that
 * follows fails, is not tangled up with I/O to stderr.
 */
export function markFirstRunNoticeShown(config: HeartbeatConfig): void {
  if (config.first_run_notice_shown) return;
  writeStoredConfig({ ...config, first_run_notice_shown: true, updated_at: new Date().toISOString() });
}
