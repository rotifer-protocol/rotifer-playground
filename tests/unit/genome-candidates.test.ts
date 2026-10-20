import { describe, it, expect } from "vitest";
import {
  EvidenceError,
  resolveCapabilityCandidates,
  schemaIncompatibility,
  type AdmissionPolicy,
  type CandidateSources,
} from "../../src/cloud/capability-candidates.js";
import type { LeaderboardRow } from "../../src/cloud/client.js";
import type { CloudGene } from "../../src/cloud/types.js";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const RECENT = "2026-10-01T00:00:00.000Z";
const STALE = "2026-01-01T00:00:00.000Z";

const IN = { type: "object", required: ["text"], properties: { text: { type: "string" } } };
const OUT = { type: "object", properties: { summary: { type: "string" } } };
const QUERY = { domain: "text.summarize", inputSchemaCompat: IN, outputSchemaCompat: OUT, minFitness: 0.3 };
const POLICY: AdmissionPolicy = { minFitness: 0.3, minVg: 0.7, maxEvalAgeDays: 90, now: NOW };

function row(id: string, over: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    tier: "verified",
    tier_rank: 1,
    gene_id: id,
    gene_name: `gene-${id}`,
    gene_version: "1.0.0",
    owner_username: "alice",
    domain: "text.summarize",
    fidelity: "Native",
    fitness_value: 0.8,
    base_fitness: 0.8,
    fidelity_discount: 1,
    safety_score: 0.9,
    evaluation_method: "sandbox",
    evaluation_n: 20,
    unique_callers: 5,
    invalidation_reason: null,
    total_calls: 100,
    last_evaluated: RECENT,
    versions_on_board: 1,
    ...over,
  };
}

function gene(id: string, over: Partial<CloudGene> = {}): CloudGene {
  return {
    id,
    name: `gene-${id}`,
    owner: "alice",
    domain: "text.summarize",
    version: "1.0.0",
    fidelity: "Native",
    description: null,
    phenotype: { domain: "text.summarize", inputSchema: IN, outputSchema: OUT },
    wasm_url: `https://example.test/${id}.wasm`,
    wasm_size: 10,
    wasm_hash: null,
    content_hash: null,
    downloads: 0,
    fitness: null,
    reputation_score: null,
    created_at: RECENT,
    updated_at: RECENT,
    ...over,
  };
}

function sources(rows: LeaderboardRow[], genes: Record<string, CloudGene>): CandidateSources & { getGeneCalls: string[] } {
  const getGeneCalls: string[] = [];
  return {
    getGeneCalls,
    arenaLeaderboard: async () => rows,
    getGene: async (id: string) => {
      getGeneCalls.push(id);
      const g = genes[id];
      if (!g) throw new Error("not found");
      return g;
    },
  };
}

describe("#30-c capability admission — a high-fitness, low-safety candidate is refused", () => {
  // X: best fitness but low declared safety; Y: modest fitness, high safety;
  // Z: best scores but not yet verified; W: verified but evidence too old;
  // V: verified, good scores, incompatible schema.
  const rows = [
    row("X", { fitness_value: 0.95, safety_score: 0.5 }),
    row("Y", { fitness_value: 0.6, safety_score: 0.92 }),
    row("Z", { fitness_value: 0.99, safety_score: 0.95, tier: "under_evaluation" }),
    row("W", { fitness_value: 0.98, safety_score: 0.96, last_evaluated: STALE }),
    row("V", { fitness_value: 0.97, safety_score: 0.97 }),
  ];
  const genes = {
    X: gene("X"),
    Y: gene("Y"),
    Z: gene("Z"),
    W: gene("W"),
    V: gene("V", { phenotype: { inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } }, outputSchema: OUT } }),
  };

  it("selects Y and rejects X/Z/W/V for exactly their own reason", async () => {
    const src = sources(rows, genes);
    const { candidates, admitted } = await resolveCapabilityCandidates(QUERY, POLICY, src);
    expect(admitted.map((c) => c.cloudId)).toEqual(["Y"]);
    const codes = Object.fromEntries(candidates.map((c) => [c.cloudId, c.rejections.map((r) => r.code)]));
    expect(codes).toEqual({
      X: ["vg-below-threshold"],
      Y: [],
      Z: ["not-verified"],
      W: ["stale-evidence"],
      V: ["schema-incompatible"],
    });
    // Evidence came from the leaderboard; the schema from getGene(UUID) for every candidate.
    expect(src.getGeneCalls.sort()).toEqual(["V", "W", "X", "Y", "Z"]);
    const y = candidates.find((c) => c.cloudId === "Y")!;
    expect(y.evidence).toMatchObject({ tier: "verified", fitness_value: 0.6, safety_score: 0.92, safety_score_source: "submitter-declared" });
  });

  it("a stricter V(g) threshold rejects a candidate that 0.7 would admit", async () => {
    const src = sources([row("A", { safety_score: 0.75 })], { A: gene("A") });
    expect((await resolveCapabilityCandidates(QUERY, POLICY, src)).admitted).toHaveLength(1);
    const strict = await resolveCapabilityCandidates(QUERY, { ...POLICY, minVg: 0.8 }, src);
    expect(strict.admitted).toHaveLength(0);
    expect(strict.candidates[0].rejections[0]).toMatchObject({ code: "vg-below-threshold" });
    expect(strict.candidates[0].rejections[0].detail).toContain("0.8");
  });

  it("thresholds are strict: fitness equal to minFitness and safety equal to minVg do not pass", async () => {
    const src = sources([row("E", { fitness_value: 0.3, safety_score: 0.7 })], { E: gene("E") });
    const { candidates } = await resolveCapabilityCandidates(QUERY, POLICY, src);
    expect(candidates[0].rejections.map((r) => r.code)).toEqual(["fitness-below-threshold", "vg-below-threshold"]);
  });

  it("missing evidence counts as failing, not as passing", async () => {
    const src = sources([row("M", { fitness_value: null, safety_score: null, last_evaluated: null })], { M: gene("M") });
    const { candidates, admitted } = await resolveCapabilityCandidates(QUERY, POLICY, src);
    expect(admitted).toEqual([]);
    expect(candidates[0].rejections.map((r) => r.code)).toEqual(["missing-evidence", "missing-evidence", "missing-evidence"]);
  });

  it("Wrapped, invalidated, and artifact-less candidates are refused (fidelity compared case-insensitively)", async () => {
    const src = sources(
      [
        row("WR", { fidelity: "Wrapped" }),
        row("wr", { fidelity: "wrapped" }),
        row("HY", { fidelity: "hybrid" }),
        row("IN", { invalidation_reason: "no-published-artifact" }),
        row("NA"),
      ],
      { WR: gene("WR"), wr: gene("wr"), HY: gene("HY"), IN: gene("IN"), NA: gene("NA", { wasm_url: null }) },
    );
    const { candidates, admitted } = await resolveCapabilityCandidates(QUERY, POLICY, src);
    const codes = Object.fromEntries(candidates.map((c) => [c.cloudId, c.rejections.map((r) => r.code)]));
    expect(codes.WR).toEqual(["fidelity"]);
    expect(codes.wr).toEqual(["fidelity"]);
    expect(codes.IN).toEqual(["invalidated"]);
    expect(codes.NA).toEqual(["no-artifact"]);
    expect(admitted.map((c) => c.cloudId)).toEqual(["HY"]);
  });

  it("admitted candidates are ordered by fitness, highest first", async () => {
    const src = sources(
      [row("lo", { fitness_value: 0.5 }), row("hi", { fitness_value: 0.9 }), row("mid", { fitness_value: 0.7 })],
      { lo: gene("lo"), hi: gene("hi"), mid: gene("mid") },
    );
    expect((await resolveCapabilityCandidates(QUERY, POLICY, src)).admitted.map((c) => c.cloudId)).toEqual(["hi", "mid", "lo"]);
  });

  it("rows from another domain are ignored", async () => {
    const src = sources([row("other", { domain: "text.translate" })], {});
    expect((await resolveCapabilityCandidates(QUERY, POLICY, src)).candidates).toEqual([]);
  });
});

describe("#30-c evidence that cannot be read is a failure, not a fallback", () => {
  it("leaderboard error → EvidenceError", async () => {
    const src: CandidateSources = {
      arenaLeaderboard: async () => {
        throw new Error("network down");
      },
      getGene: async () => gene("x"),
    };
    await expect(resolveCapabilityCandidates(QUERY, POLICY, src)).rejects.toBeInstanceOf(EvidenceError);
  });

  it("a candidate whose Registry row has an empty phenotype → EvidenceError", async () => {
    const src = sources([row("E")], { E: gene("E", { phenotype: {} }) });
    await expect(resolveCapabilityCandidates(QUERY, POLICY, src)).rejects.toThrow("empty phenotype");
  });

  it("a candidate whose Registry row cannot be fetched → EvidenceError", async () => {
    const src = sources([row("gone")], {});
    await expect(resolveCapabilityCandidates(QUERY, POLICY, src)).rejects.toThrow("could not read Registry row gone");
  });
});

describe("schema compatibility rule", () => {
  it("accepts a candidate needing a subset of the inputs and producing a superset of the outputs", () => {
    expect(
      schemaIncompatibility(QUERY, {
        inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" }, lang: { type: "string" } } },
        outputSchema: { type: "object", properties: { summary: { type: "string" }, words: { type: "number" } } },
      }),
    ).toBeNull();
  });

  it("refuses a missing required input, a missing output, a type change, or no schema", () => {
    const base = { inputSchema: IN, outputSchema: OUT };
    expect(schemaIncompatibility(QUERY, { ...base, inputSchema: { type: "object", required: ["url"], properties: {} } })).toContain("requires input 'url'");
    expect(schemaIncompatibility(QUERY, { ...base, outputSchema: { type: "object", properties: {} } })).toContain("does not produce output 'summary'");
    expect(
      schemaIncompatibility(QUERY, { ...base, outputSchema: { type: "object", properties: { summary: { type: "number" } } } }),
    ).toContain("different type");
    expect(schemaIncompatibility(QUERY, {})).toContain("no checkable");
    expect(schemaIncompatibility({ inputSchemaCompat: {}, outputSchemaCompat: OUT }, base)).toContain("no checkable");
  });
});
