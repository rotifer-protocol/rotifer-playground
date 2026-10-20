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

/** v2 ID of a fake Registry row: derived from its id, overridable per test. */
const v2Of = (id: string) => "v2:" + id.toLowerCase().padEnd(64, "0").slice(0, 64).replace(/[^0-9a-f]/g, "a");

function sources(
  rows: LeaderboardRow[],
  genes: Record<string, CloudGene>,
  geneIds: Record<string, { id: string } | { reason: string }> = {},
): CandidateSources & { getGeneCalls: string[]; computeCalls: string[] } {
  const getGeneCalls: string[] = [];
  const computeCalls: string[] = [];
  return {
    getGeneCalls,
    computeCalls,
    computeGeneId: async (g: CloudGene) => {
      computeCalls.push(g.id);
      return geneIds[g.id] ?? { id: v2Of(g.id) };
    },
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

describe("excludeGeneIds is applied at admission", () => {
  const rows = [row("best", { fitness_value: 0.95 }), row("next", { fitness_value: 0.85 }), row("low", { fitness_value: 0.5, safety_score: 0.2 })];
  const genes = { best: gene("best"), next: gene("next"), low: gene("low") };

  it("an excluded top scorer is rejected and the next best is chosen", async () => {
    const src = sources(rows, genes);
    const { candidates, admitted } = await resolveCapabilityCandidates({ ...QUERY, excludeGeneIds: [v2Of("best")] }, POLICY, src);
    expect(admitted.map((c) => c.cloudId)).toEqual(["next"]);
    const best = candidates.find((c) => c.cloudId === "best")!;
    expect(best.rejections).toEqual([{ code: "excluded", detail: expect.stringContaining(v2Of("best")) }]);
    expect(admitted[0].geneId).toBe(v2Of("next"));
    // Only candidates that passed every other check are identified by content.
    expect(src.computeCalls.sort()).toEqual(["best", "next"]);
  });

  // T-10 #10: every admitted candidate is identified by content, exclusion list or not,
  // so "what is installed is what was admitted" holds for every capability pick.
  it("without excludeGeneIds the top scorer wins and is still identified by content", async () => {
    const src = sources(rows, genes);
    const { admitted } = await resolveCapabilityCandidates(QUERY, POLICY, src);
    expect(admitted[0].cloudId).toBe("best");
    expect(admitted[0].geneId).toBe(v2Of("best"));
    expect(src.computeCalls.sort()).toEqual(["best", "next"]);
  });

  it("without excludeGeneIds a candidate whose ID cannot be computed is still refused", async () => {
    const src = sources(rows, genes, { best: { reason: "WASM hash does not match the Registry row" } });
    const { admitted } = await resolveCapabilityCandidates(QUERY, POLICY, src);
    expect(admitted.map((c) => c.cloudId)).toEqual(["next"]);
  });

  it("an ID that cannot be computed counts as missing evidence, not as 'not excluded'", async () => {
    const src = sources(rows, genes, { best: { reason: "WASM hash does not match the Registry row" } });
    const { candidates, admitted } = await resolveCapabilityCandidates({ ...QUERY, excludeGeneIds: [v2Of("other")] }, POLICY, src);
    expect(admitted.map((c) => c.cloudId)).toEqual(["next"]);
    expect(candidates.find((c) => c.cloudId === "best")!.rejections[0]).toMatchObject({ code: "missing-evidence" });
  });

  it("every admissible candidate excluded → none admitted", async () => {
    const src = sources(rows, genes);
    const { admitted } = await resolveCapabilityCandidates({ ...QUERY, excludeGeneIds: [v2Of("best"), v2Of("next")] }, POLICY, src);
    expect(admitted).toEqual([]);
  });
});

describe("T-10 #13: candidates beyond the first leaderboard page are seen", () => {
  // 450 rows in the domain; only row 421 is admissible.
  const many = Array.from({ length: 450 }, (_, i) =>
    row(`r${i}`, i === 420 ? { fitness_value: 0.9 } : { tier: "not_evaluated" }),
  );
  const genesById = Object.fromEntries(many.map((r) => [r.gene_id, gene(r.gene_id)]));

  function pagedSources() {
    const offsets: number[] = [];
    const src = sources([], genesById);
    src.arenaLeaderboard = async (o: { domain?: string; limit?: number; offset?: number }) => {
      offsets.push(o.offset ?? 0);
      const limit = o.limit ?? 200;
      return many.slice(o.offset ?? 0, (o.offset ?? 0) + limit);
    };
    return { src, offsets };
  }

  it("pages until a short page and finds the admissible row on page 3", async () => {
    const { src, offsets } = pagedSources();
    const { candidates, admitted } = await resolveCapabilityCandidates(QUERY, POLICY, src);
    expect(candidates).toHaveLength(450);
    expect(admitted.map((c) => c.cloudId)).toEqual(["r420"]);
    expect(offsets).toEqual([0, 200, 400]);
  });

  it("a leaderboard that never ends is evidence it cannot read, not 'no candidate'", async () => {
    const src = sources([], {});
    src.arenaLeaderboard = async (o: { limit?: number }) =>
      Array.from({ length: o.limit ?? 200 }, (_, i) => row(`x${i}`, { domain: "other.domain" }));
    await expect(resolveCapabilityCandidates(QUERY, POLICY, src)).rejects.toThrow("more than");
  });
});

describe("#30-c evidence that cannot be read is a failure, not a fallback", () => {
  it("leaderboard error → EvidenceError", async () => {
    const src: CandidateSources = {
      arenaLeaderboard: async () => {
        throw new Error("network down");
      },
      getGene: async () => gene("x"),
      computeGeneId: async () => ({ reason: "unused" }),
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
