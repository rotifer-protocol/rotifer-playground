/**
 * The runs a submission measured are published whether the score is filed as
 * `sandbox` or `estimated` (T-54).
 *
 * Every submission is `estimated` while C_util / R_rob are placeholders, and
 * runs used to be published only for `sandbox` — so none ever reached the run
 * ledger, and the season median could never gather a sample.
 * tests/e2e/arena-submit-runs.test.ts proves the whole path against a real
 * stack; these pin what CI can check without one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("arena submit publishes the runs whenever the Gene ran", () => {
  const src = readFileSync(join(process.cwd(), "src/commands/arena-submit.ts"), "utf-8");

  it("the upload is gated on having run, not on the method label", () => {
    expect(src).toMatch(/if \(didRunInSandbox\) \{\s*await publishEvaluationRuns\(/);
    expect(src).not.toMatch(/evaluationMethod === "sandbox"\)\s*\{\s*await publishEvaluationRuns/);
  });

  it("the label still follows the formula's completeness, so an estimate stays an estimate", () => {
    expect(src).toMatch(/\(didRunInSandbox && hasCompleteFitnessInputs\) \? "sandbox" : "estimated"/);
    expect(src).toMatch(/const hasCompleteFitnessInputs = false;/);
  });

  it("the hint no longer claims the runs are recorded when they are not uploaded", () => {
    expect(src).not.toContain("its latency and its cost are still recorded");
    expect(src).toContain("this local submission keeps them on this machine only");
  });
});

describe("publishEvaluationRuns against PostgREST's return=minimal", () => {
  const saved = {
    HOME: process.env.HOME,
    ROTIFER_CLOUD_ENDPOINT: process.env.ROTIFER_CLOUD_ENDPOINT,
    ROTIFER_CLOUD_ANON_KEY: process.env.ROTIFER_CLOUD_ANON_KEY,
  };
  let home: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const RUN = {
    run_index: 0, sandbox_success: true, output_schema_valid: true, latency_ms: 12, resource_cost: 3400, failure_kind: null,
  };

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "rotifer-runs-upload-"));
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    writeFileSync(
      join(home, ".rotifer", "credentials.json"),
      JSON.stringify({ access_token: "test-token-not-real", expires_at: Date.now() + 3_600_000 }),
    );
    process.env.HOME = home;
    process.env.ROTIFER_CLOUD_ENDPOINT = "https://cloud.example.test";
    process.env.ROTIFER_CLOUD_ANON_KEY = "anon-test-key";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("201 with an empty body is success, not a JSON parse error", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const { publishEvaluationRuns } = await import("../../src/cloud/client.js");
    await expect(publishEvaluationRuns("g-1", "s-1", [RUN])).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://cloud.example.test/rest/v1/arena_evaluation_runs");
    expect(JSON.parse(String(init.body))).toEqual([{ gene_id: "g-1", submission_id: "s-1", ...RUN }]);
  });

  it("a refused insert still throws with the server's message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: "new row violates row-level security policy" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    const { publishEvaluationRuns } = await import("../../src/cloud/client.js");
    await expect(publishEvaluationRuns("g-1", "s-1", [RUN])).rejects.toThrow(
      "Cloud API error (403): new row violates row-level security policy",
    );
  });

  it("no runs, no request", async () => {
    const { publishEvaluationRuns } = await import("../../src/cloud/client.js");
    await publishEvaluationRuns("g-1", "s-1", []);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
