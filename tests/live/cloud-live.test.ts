import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CLOUD_ANON_KEY } from "../../src/cloud/types.js";
import { announceSimulation, simulatedService, type SimulatedService } from "./simulate.js";

/**
 * The real Rotifer Cloud, on a schedule (.github/workflows/live-checks.yml),
 * not in the PR gate. The PR gate runs the registry suites against a
 * recorded cloud (tests/fixtures/cloud/); this suite notices what that one
 * cannot:
 * - the real API changing shape (columns the fixture claims are gone, or
 *   changed type);
 * - the publishable key the CLI ships being refused;
 * - the cloud being down or slow. The CLI names the cause
 *   ("Cannot reach Rotifer Cloud (…): connection refused (ECONNREFUSED)"),
 *   so the issue this job opens says what happened.
 *
 * @rotifer-protocol/grammar-checker is our own gene, with a published
 * version chain (0.2.0 → 0.2.1 on 2026-11-01).
 */

const CLOUD = "https://cloud.rotifer.dev";
const CLI = join(__dirname, "../../dist/index.js");
const fixture = JSON.parse(readFileSync(join(__dirname, "../fixtures/cloud/registry.json"), "utf-8"));
let home: string;
// Only for live-checks.yml's simulate_failure input; see simulate.ts. It
// replaces the cloud for the CLI's commands; the direct shape checks below
// still ask the real API.
let sim: SimulatedService | null = null;

function run(args: string[]): Promise<{ out: string; stdout: string; code: number | null }> {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1", ROTIFER_TELEMETRY: "0" };
  // The real cloud, with the key the CLI ships, whatever the environment says.
  delete env.ROTIFER_CLOUD_ENDPOINT;
  delete env.ROTIFER_CLOUD_ANON_KEY;
  if (sim) env.ROTIFER_CLOUD_ENDPOINT = sim.url;
  return new Promise((resolve) => {
    const child = execFile("node", [CLI, ...args], { cwd: home, timeout: 60_000, env }, (_err, stdout, stderr) =>
      resolve({ out: `${stdout}${stderr}`, stdout, code: child.exitCode }),
    );
  });
}

/** What the API itself answers, asked the way the CLI asks (publishable key, no session). */
async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${CLOUD}/rest/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", apikey: DEFAULT_CLOUD_ANON_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json();
}

/** Column → JSON type, for comparing the real answer with the fixture's. */
function shape(row: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, row[k] === null ? "null" : typeof row[k]]));
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "rotifer-cloud-live-"));
  sim = await simulatedService();
  if (sim) announceSimulation(sim, "Rotifer Cloud");
});

afterAll(async () => {
  await sim?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the real Rotifer Cloud", () => {
  it("versions: shows a real gene's chain", async () => {
    const { out, stdout, code } = await run(["--json", "versions", "@rotifer-protocol/grammar-checker"]);
    expect(code, out).toBe(0);
    const { versions } = JSON.parse(stdout) as { versions: Array<Record<string, unknown>> };
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions.at(-1)!.previous_version_id, "the latest version names its predecessor").toBeTruthy();
  });

  it("versions: a gene that does not exist has no versions", async () => {
    const { out, code } = await run(["versions", "nobody", "nonexistent-gene-xyz"]);
    expect(code, out).toBe(0);
    expect(out).toContain("No published versions found for nobody/nonexistent-gene-xyz");
  });

  it("info / stats: a gene that does not exist is not found", async () => {
    for (const cmd of [["info", "nonexistent-id-12345"], ["stats", "nonexistent-id-12345"]]) {
      const { out, code } = await run(cmd);
      expect(code, out).toBe(1);
      expect(out).toContain("Gene 'nonexistent-id-12345' not found");
    }
  });

  it("reputation --leaderboard: the shipped key is accepted", async () => {
    const { out, code } = await run(["reputation", "--leaderboard", "--top", "5"]);
    expect(out).not.toMatch(/No API key found/i);
    expect(out).not.toMatch(/Legacy API keys are disabled/i);
    expect(code, out).toBe(0);
    expect(out).toContain("Reputation Leaderboard");
  });

  it("the genes rows the fixture records still have the same columns and types", async () => {
    const rows = (await api(
      "/genes?name=eq.grammar-checker&published=eq.true&order=created_at.asc" +
        "&select=id,name,version,published,changelog,previous_version_id,created_at,profiles(username)",
    )) as Array<Record<string, unknown>>;
    const real = rows.find((r) => r.previous_version_id !== null && typeof r.changelog === "string") ?? rows.at(-1)!;
    const recorded = fixture.genes[1];
    const keys = Object.keys(recorded);
    // changelog is text or null in both; compare only when both carry one.
    const nonNull = keys.filter((k) => recorded[k] !== null && real[k] !== null);
    expect(shape(real, nonNull)).toEqual(shape(recorded, nonNull));
    expect(Object.keys(real).sort()).toEqual([...keys].sort());
    expect(typeof (real.profiles as { username?: unknown }).username).toBe("string");
  });

  it("the leaderboard rows the fixture records still have the same columns and types", async () => {
    const rows = (await api("/rpc/get_reputation_leaderboard", {
      method: "POST",
      body: JSON.stringify({ p_limit: 3 }),
    })) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const recorded = fixture.reputation_leaderboard[0];
    const keys = Object.keys(recorded);
    expect(Object.keys(rows[0]).sort()).toEqual([...keys].sort());
    // score is a JSON number in both (0 or 0.1157).
    expect(shape(rows[0], keys)).toEqual(shape(recorded, keys));
  });
});
