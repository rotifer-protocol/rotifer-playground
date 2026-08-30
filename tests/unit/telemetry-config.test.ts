import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * ~/.rotifer/telemetry.json — the on-disk state shared, in practice, with
 * rotifer-mcp-server on the same machine. Each test gets its own HOME via
 * vi.resetModules() + a fresh dynamic import, same pattern as
 * cloud-invocation.test.ts, so nothing here ever touches the real
 * ~/.rotifer/ this process happens to be running under.
 */
describe("telemetry/config", () => {
  let testHome: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "rotifer-telemetry-"));
    process.env.HOME = testHome;
    delete process.env.ROTIFER_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(testHome, { recursive: true, force: true });
    process.env = { ...savedEnv };
  });

  it("mints a random machine_id on first read and persists it", async () => {
    const { loadOrInitHeartbeatConfig } = await import("../../src/telemetry/config.js");
    const first = loadOrInitHeartbeatConfig();
    expect(first.machine_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(first.enabled).toBe(true);
    expect(first.first_run_notice_shown).toBe(false);

    const second = loadOrInitHeartbeatConfig();
    expect(second.machine_id).toBe(first.machine_id); // same file, not re-minted
  });

  it("writes telemetry.json with 0600 permissions, same as credentials.json", async () => {
    const { loadOrInitHeartbeatConfig } = await import("../../src/telemetry/config.js");
    loadOrInitHeartbeatConfig();
    const { statSync } = await import("node:fs");
    const mode = statSync(join(testHome, ".rotifer", "telemetry.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("setHeartbeatEnabled(false) persists and keeps the same machine_id", async () => {
    const { loadOrInitHeartbeatConfig, setHeartbeatEnabled } = await import("../../src/telemetry/config.js");
    const before = loadOrInitHeartbeatConfig();
    const after = setHeartbeatEnabled(false);
    expect(after.machine_id).toBe(before.machine_id);
    expect(after.enabled).toBe(false);
    expect(after.consent_source).toBe("cli");
    // Setting the choice via CLI counts as having seen the notice — must not
    // print again just because the user hasn't run a Gene yet.
    expect(after.first_run_notice_shown).toBe(true);

    const reloaded = loadOrInitHeartbeatConfig();
    expect(reloaded.enabled).toBe(false);
  });

  it("a corrupt file is treated as absent — remints rather than refusing to run", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(testHome, ".rotifer"), { recursive: true });
    writeFileSync(join(testHome, ".rotifer", "telemetry.json"), "{ not json");

    const { loadOrInitHeartbeatConfig } = await import("../../src/telemetry/config.js");
    const config = loadOrInitHeartbeatConfig();
    expect(config.machine_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(config.enabled).toBe(true);
  });

  it("a file missing machine_id is treated as absent, not partially trusted", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(testHome, ".rotifer"), { recursive: true });
    writeFileSync(
      join(testHome, ".rotifer", "telemetry.json"),
      JSON.stringify({ enabled: false }), // no machine_id at all
    );

    const { loadOrInitHeartbeatConfig } = await import("../../src/telemetry/config.js");
    const config = loadOrInitHeartbeatConfig();
    // Remints from scratch — does NOT pick up the stale enabled:false, which
    // would be trusting half of a file this code doesn't otherwise trust.
    expect(config.machine_id).toBeTruthy();
    expect(config.enabled).toBe(true);
  });
});

/**
 * Pure function — no filesystem, so no HOME isolation needed. This is the
 * table ADR-329 D1 actually specifies: env > stored > default-on, and it is
 * the opposite default from gene_invocation_log's (ADR-316 D1 default-off)
 * on purpose.
 */
describe("resolveHeartbeatDecision", () => {
  function config(overrides: Partial<{ enabled: boolean; consent_source: "installer" | "cli" | "default-notice" }> = {}) {
    return {
      enabled: true,
      machine_id: "00000000-0000-4000-8000-000000000000",
      consent_source: "default-notice" as const,
      first_run_notice_shown: false,
      updated_at: new Date(0).toISOString(),
      ...overrides,
    };
  }

  it("no env, no prior choice -> on-default (the whole point of ADR-329)", async () => {
    const { resolveHeartbeatDecision, heartbeatDecisionEnabled } = await import("../../src/telemetry/config.js");
    const d = resolveHeartbeatDecision(config(), {});
    expect(d).toBe("on-default");
    expect(heartbeatDecisionEnabled(d)).toBe(true);
  });

  it("stored off, no env -> off-stored", async () => {
    const { resolveHeartbeatDecision, heartbeatDecisionEnabled } = await import("../../src/telemetry/config.js");
    const d = resolveHeartbeatDecision(config({ enabled: false }), {});
    expect(d).toBe("off-stored");
    expect(heartbeatDecisionEnabled(d)).toBe(false);
  });

  it("stored on via CLI -> on-stored (distinct from on-default for status reporting)", async () => {
    const { resolveHeartbeatDecision } = await import("../../src/telemetry/config.js");
    const d = resolveHeartbeatDecision(config({ consent_source: "cli" }), {});
    expect(d).toBe("on-stored");
  });

  it("env ROTIFER_TELEMETRY=0 overrides a stored on -> off-env", async () => {
    const { resolveHeartbeatDecision, heartbeatDecisionEnabled } = await import("../../src/telemetry/config.js");
    const d = resolveHeartbeatDecision(config({ enabled: true }), { ROTIFER_TELEMETRY: "0" });
    expect(d).toBe("off-env");
    expect(heartbeatDecisionEnabled(d)).toBe(false);
  });

  it("env ROTIFER_TELEMETRY=1 overrides a stored off -> on-env", async () => {
    const { resolveHeartbeatDecision, heartbeatDecisionEnabled } = await import("../../src/telemetry/config.js");
    const d = resolveHeartbeatDecision(config({ enabled: false }), { ROTIFER_TELEMETRY: "1" });
    expect(d).toBe("on-env");
    expect(heartbeatDecisionEnabled(d)).toBe(true);
  });

  it("DO_NOT_TRACK overrides everything, including an explicit ROTIFER_TELEMETRY=1", async () => {
    const { resolveHeartbeatDecision, heartbeatDecisionEnabled } = await import("../../src/telemetry/config.js");
    const d = resolveHeartbeatDecision(config({ enabled: true }), {
      DO_NOT_TRACK: "1",
      ROTIFER_TELEMETRY: "1",
    });
    expect(d).toBe("off-env");
    expect(heartbeatDecisionEnabled(d)).toBe(false);
  });
});
