/**
 * F(g)'s reference scale (ADR-318 D2, v0.9.3 #6).
 *
 * L_ref / Cost_ref are the season median of a gene's domain and fidelity,
 * served by the registry's `get_fitness_reference`. The CLI must use the median
 * when it gets one and fall back to the fixed constants when it does not, and
 * record which it used — but only send that record to a registry known to have
 * the columns, or every submit to an older registry would fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FALLBACK_REFERENCE,
  LATENCY_SCALE_MS,
  RESOURCE_SCALE_UNITS,
  computeBaseFitness,
  resolveFitnessReference,
  type SeasonReferenceRow,
} from "../../src/utils/fitness-formula.js";

const ROW: SeasonReferenceRow = { l_ref_ms: 80, cost_ref: 3000, sample_genes: 7, season_number: 2 };

describe("the formula reproduces the shared vectors (same file as the Rust tests)", () => {
  const doc = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/fitness-reference-vectors.json"), "utf-8")) as {
    coverage: number;
    robustness: number;
    vectors: Array<{
      name: string;
      runs: Array<{ success: boolean; latency_ms: number; resource_cost: number }>;
      reference: { latency_ms: number; resource_cost: number };
      expected: { success_rate: number; latency_score: number; resource_efficiency: number; value: number };
    }>;
  };

  it("has the vectors", () => {
    expect(doc.vectors.length).toBeGreaterThanOrEqual(5);
  });

  for (const v of doc.vectors) {
    it(v.name, () => {
      const n = v.runs.length;
      const got = computeBaseFitness(
        {
          successRate: v.runs.filter((r) => r.success).length / n,
          avgLatencyMs: v.runs.reduce((s, r) => s + r.latency_ms, 0) / n,
          avgResourceCost: v.runs.reduce((s, r) => s + r.resource_cost, 0) / n,
          coverage: doc.coverage,
          robustness: doc.robustness,
        },
        { latencyMs: v.reference.latency_ms, resourceCost: v.reference.resource_cost },
      );
      expect(got.latencyScore).toBeCloseTo(v.expected.latency_score, 12);
      expect(got.resourceEfficiency).toBeCloseTo(v.expected.resource_efficiency, 12);
      expect(got.value).toBeCloseTo(v.expected.value, 12);
    });
  }

  it("a gene at the reference scores one half on each term", () => {
    const got = computeBaseFitness(
      { successRate: 1, avgLatencyMs: 80, avgResourceCost: 3000, coverage: 0.5, robustness: 0.5 },
      { latencyMs: 80, resourceCost: 3000 },
    );
    expect(got.latencyScore).toBe(0.5);
    expect(got.resourceEfficiency).toBe(0.5);
  });

  it("without a reference, or with an unusable one, the fixed constants apply", () => {
    const inputs = { successRate: 1, avgLatencyMs: 250, avgResourceCost: 7000, coverage: 0.5, robustness: 0.5 };
    const plain = computeBaseFitness(inputs);
    expect(plain.latencyScore).toBeCloseTo(1 / (1 + 250 / LATENCY_SCALE_MS), 15);
    expect(plain.resourceEfficiency).toBeCloseTo(1 / (1 + 7000 / RESOURCE_SCALE_UNITS), 15);
    for (const bad of [{ latencyMs: 0, resourceCost: 1 }, { latencyMs: 1, resourceCost: -1 }, { latencyMs: NaN, resourceCost: 1 }]) {
      expect(computeBaseFitness(inputs, bad).value).toBe(plain.value);
    }
  });
});

describe("resolveFitnessReference: a median when there is one, the constants otherwise", () => {
  it("got a median: uses it, and it may be recorded", async () => {
    const r = await resolveFitnessReference("text.x", "Native", async () => ROW);
    expect(r).toEqual({
      scale: { latencyMs: 80, resourceCost: 3000 },
      source: "season-median",
      isRecordable: true,
      sampleGenes: 7,
      seasonNumber: 2,
    });
  });

  it("asks for the gene's own domain and fidelity", async () => {
    const fetcher = vi.fn(async () => ROW);
    await resolveFitnessReference("sim.particle", "Native", fetcher);
    expect(fetcher).toHaveBeenCalledWith("sim.particle", "Native");
  });

  it("too few genes this season: the constants, and the fallback may be recorded", async () => {
    const r = await resolveFitnessReference("text.x", "Native", async () => null);
    expect(r.scale).toEqual(FALLBACK_REFERENCE);
    expect(r.source).toBe("fallback");
    expect(r.isRecordable).toBe(true);
    expect(r.reason).toContain("too few measured text.x / Native genes");
  });

  it("registry unreachable or without the function: the constants, and nothing is recorded", async () => {
    const r = await resolveFitnessReference("text.x", "Native", async () => {
      throw new Error("HTTP 404");
    });
    expect(r.scale).toEqual(FALLBACK_REFERENCE);
    expect(r.source).toBe("fallback");
    expect(r.isRecordable).toBe(false);
    expect(r.reason).toContain("HTTP 404");
  });

  it("a non-positive median is not used", async () => {
    const r = await resolveFitnessReference("text.x", "Native", async () => ({ ...ROW, cost_ref: 0 }));
    expect(r.scale).toEqual(FALLBACK_REFERENCE);
    expect(r.source).toBe("fallback");
  });

  it("the resolved scale is a copy: changing it cannot move the shared fallback", async () => {
    const r = await resolveFitnessReference("text.x", "Native", async () => null);
    r.scale.latencyMs = 1;
    expect(FALLBACK_REFERENCE.latencyMs).toBe(LATENCY_SCALE_MS);
  });
});

describe("the cloud client: reading the median and recording the reference", () => {
  const saved = {
    HOME: process.env.HOME,
    ROTIFER_CLOUD_ENDPOINT: process.env.ROTIFER_CLOUD_ENDPOINT,
    ROTIFER_CLOUD_ANON_KEY: process.env.ROTIFER_CLOUD_ANON_KEY,
  };
  let home: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  beforeEach(() => {
    vi.resetModules();
    home = mkdtempSync(join(tmpdir(), "rotifer-fref-"));
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

  it("getFitnessReference posts the domain and fidelity to the RPC and returns its row", async () => {
    fetchMock.mockResolvedValue(json([ROW]));
    const { getFitnessReference } = await import("../../src/cloud/client.js");
    expect(await getFitnessReference("text.x", "Native")).toEqual(ROW);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://cloud.example.test/rest/v1/rpc/get_fitness_reference");
    expect(JSON.parse(init.body)).toEqual({ p_domain: "text.x", p_fidelity: "Native" });
  });

  it("an empty answer means no median (null), not an error", async () => {
    fetchMock.mockResolvedValue(json([]));
    const { getFitnessReference } = await import("../../src/cloud/client.js");
    expect(await getFitnessReference("text.x", "Native")).toBeNull();
  });

  it("a registry without the function (404) throws, so the caller falls back without recording", async () => {
    fetchMock.mockResolvedValue(json({ code: "PGRST202", message: "Could not find the function" }, 404));
    const { getFitnessReference } = await import("../../src/cloud/client.js");
    const r = await resolveFitnessReference("text.x", "Native", getFitnessReference);
    expect(r.source).toBe("fallback");
    expect(r.isRecordable).toBe(false);
  });

  async function submitBody(fitness: Record<string, unknown>): Promise<Record<string, unknown>> {
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    writeFileSync(
      join(home, ".rotifer", "credentials.json"),
      JSON.stringify({ access_token: "test-token-not-real", expires_at: Date.now() + 3_600_000 }),
    );
    const gene = { id: "g-1", name: "demo", domain: "text.x", owner: "someone", profiles: { username: "someone" } };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/arena_entries")) return json([{ gene_id: "g-1", domain: "text.x", ...JSON.parse(String(init!.body)) }]);
      return json([gene]);
    });
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    await arenaSubmit("g-1", {
      value: 0.4, safety_score: 0.9, success_rate: 1, latency_score: 0.5, resource_efficiency: 0.5,
      evaluation_method: "estimated", evaluation_n: 3,
      ...fitness,
    } as never);
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/arena_entries"))!;
    return JSON.parse(String(call[1].body));
  }

  it("a submission carries the reference it was scaled by", async () => {
    const body = await submitBody({ fitness_reference: "season-median", l_ref_ms: 80, cost_ref: 3000 });
    expect(body).toMatchObject({ fitness_reference: "season-median", l_ref_ms: 80, cost_ref: 3000, evaluation_method: "estimated" });
  });

  it("without a recordable reference the three columns are not sent at all", async () => {
    const body = await submitBody({});
    for (const k of ["fitness_reference", "l_ref_ms", "cost_ref"]) expect(body).not.toHaveProperty(k);
  });
});

describe("arena submit wires the reference in", () => {
  const src = readFileSync(join(process.cwd(), "src/commands/arena-submit.ts"), "utf-8");

  it("resolves the reference for the gene's domain and fidelity and scales F(g) with it", () => {
    expect(src).toMatch(/resolveFitnessReference\(phenotype\.domain, declaredFidelity, getFitnessReference\)/);
    expect(src).toMatch(/computeBaseFitness\([\s\S]*?reference\.scale,\s*\)/);
  });

  it("sends the reference only when the registry answered", () => {
    expect(src).toMatch(/reference\?\.isRecordable\s*\?/);
  });

  it("still records every submission as estimated (C_util / R_rob are placeholders)", () => {
    expect(src).toMatch(/const hasCompleteFitnessInputs = false;/);
  });
});
