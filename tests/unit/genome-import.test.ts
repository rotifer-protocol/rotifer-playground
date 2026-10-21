import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";

// Registry reads, the install itself and the native v2 ID are stubbed here; the
// real counterpart is covered by tests/e2e/genome-*.test.ts (ROTIFER_E2E_REGISTRY=1).
vi.mock("../../src/cloud/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/cloud/client.js")>()),
  getGene: vi.fn(),
  listGeneVersions: vi.fn(),
  arenaLeaderboard: vi.fn(),
  downloadGeneWasm: vi.fn(),
}));
vi.mock("../../src/commands/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/commands/install.js")>()),
  installGeneFromCloud: vi.fn(),
}));
vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  geneIdV2: vi.fn(),
}));

import { arenaLeaderboard, downloadGeneWasm, getGene, listGeneVersions, type LeaderboardRow } from "../../src/cloud/client.js";
import { installGeneFromCloud } from "../../src/commands/install.js";
import { geneIdV2 } from "../../src/utils/binding.js";
import { setOutputMode } from "../../src/utils/display.js";
import type { CloudGene } from "../../src/cloud/types.js";
import { exportGenome, findAgent, jcs, type GenomeBlueprint } from "../../src/commands/genome.js";
import {
  compositionPlan,
  computeGenomeId,
  effectiveMinVg,
  importGenome,
  parseBlueprint,
  runGenomeImport,
  GenomeImportError,
} from "../../src/commands/genome-import.js";
import { captureOutput, fakeV2, writeAgent } from "./genome-test-helpers.js";

const NOW = new Date("2026-10-20T00:00:00.000Z");
const IN = { type: "object", required: ["text"], properties: { text: { type: "string" } } };
const OUT = { type: "object", properties: { result: { type: "string" } } };

/** The fake Registry: one published row per gene version. */
interface Row { id: string; name: string; owner: string; version: string; fidelity: string; v2: string }
const REGISTRY: Row[] = [
  { id: "id-alpha-1", name: "alpha", owner: "alice", version: "1.0.0", fidelity: "Native", v2: fakeV2("alpha@1.0.0") },
  { id: "id-alpha-2", name: "alpha", owner: "alice", version: "2.0.0", fidelity: "Native", v2: fakeV2("alpha@2.0.0") },
  { id: "id-beta-1", name: "beta", owner: "bob", version: "1.0.0", fidelity: "Hybrid", v2: fakeV2("beta@1.0.0") },
  { id: "id-gamma-1", name: "gamma", owner: "carol", version: "1.0.0", fidelity: "Native", v2: fakeV2("gamma@1.0.0") },
  { id: "id-delta-1", name: "delta", owner: "alice", version: "3.0.0", fidelity: "Native", v2: fakeV2("delta@3.0.0") },
];

function cloudGene(r: Row): CloudGene {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    domain: "text.x",
    version: r.version,
    fidelity: r.fidelity,
    description: null,
    phenotype: { name: r.name, version: r.version, domain: "text.x", fidelity: r.fidelity, inputSchema: IN, outputSchema: OUT },
    wasm_url: `https://example.test/${r.id}.wasm`,
    wasm_size: 0,
    wasm_hash: null,
    content_hash: null,
    downloads: 0,
    fitness: null,
    reputation_score: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

function leaderRow(r: Row, over: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    tier: "verified", tier_rank: 1, gene_id: r.id, gene_name: r.name, gene_version: r.version,
    owner_username: r.owner, domain: "text.x", fidelity: r.fidelity, fitness_value: 0.8, base_fitness: 0.8,
    fidelity_discount: 1, safety_score: 0.9, evaluation_method: "sandbox", evaluation_n: 20, unique_callers: 5,
    invalidation_reason: null, total_calls: 50, last_evaluated: "2026-10-10T00:00:00.000Z", versions_on_board: 1,
    ...over,
  };
}

const row = (name: string, version = "1.0.0") => REGISTRY.find((r) => r.name === name && r.version === version)!;

let root: string;
let installs: string[];

beforeEach(() => {
  root = join(tmpdir(), `genome-import-${randomUUID()}`);
  mkdirSync(join(root, "genes"), { recursive: true });
  installs = [];
  vi.mocked(getGene).mockImplementation(async (id: string) => {
    const r = REGISTRY.find((x) => x.id === id);
    if (!r) throw new Error(`Gene '${id}' not found`);
    return cloudGene(r);
  });
  vi.mocked(listGeneVersions).mockImplementation(async (owner: string, name: string) =>
    REGISTRY.filter((r) => r.owner === owner && r.name === name).map((r) => ({
      id: r.id, version: r.version, changelog: null, previous_version_id: null, created_at: "2026-10-01T00:00:00.000Z",
    })),
  );
  vi.mocked(arenaLeaderboard).mockResolvedValue([]);
  // A fake install writes the gene and remembers its v2 ID beside it.
  vi.mocked(installGeneFromCloud).mockImplementation(async (ref: string, opts: { genesDir: string }) => {
    installs.push(ref);
    const r = REGISTRY.find((x) => x.id === ref)!;
    const dir = join(opts.genesDir, r.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phenotype.json"), JSON.stringify(cloudGene(r).phenotype));
    writeFileSync(join(dir, "fake-v2"), r.v2);
    return { gene: cloudGene(r), geneDir: dir, didSnapshot: false, contentHashCheck: { status: "match" as const } };
  });
  vi.mocked(downloadGeneWasm).mockResolvedValue(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  // The v2 ID of an installed gene is the one remembered beside it; of a candidate
  // being identified before install, the one its phenotype's name@version maps to.
  vi.mocked(geneIdV2).mockImplementation((genesRoot: string, name: string) => {
    const f = join(genesRoot, name, "fake-v2");
    if (existsSync(f)) return { id: readFileSync(f, "utf-8") };
    const ph = join(genesRoot, name, "phenotype.json");
    if (existsSync(join(genesRoot, name, "gene.ir.wasm")) && existsSync(ph)) {
      const { version } = JSON.parse(readFileSync(ph, "utf-8"));
      const r = REGISTRY.find((x) => x.name === name && x.version === version);
      if (r) return { id: r.v2 };
    }
    return { reason: "gene.ir.wasm does not exist" };
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.mocked(getGene).mockReset();
  vi.mocked(listGeneVersions).mockReset();
  vi.mocked(arenaLeaderboard).mockReset();
  vi.mocked(downloadGeneWasm).mockReset();
  vi.mocked(installGeneFromCloud).mockReset();
  vi.mocked(geneIdV2).mockReset();
  setOutputMode("human");
});

const leaf = (r: Row, role = r.name) => ({ Gene: { geneRef: { geneId: r.v2, role, optional: false } } });

/** A Blueprint as export writes it, for the given registry rows. */
function blueprint(rows: Row[], over: Partial<GenomeBlueprint> = {}, opts: { withCapabilities?: boolean } = {}): GenomeBlueprint {
  const bp: GenomeBlueprint = {
    blueprintFormat: 1,
    protocolVersion: { major: 0, minor: 9, patch: 2, supportedFeatures: ["GENE_COMPOSITION_ALGEBRA"] },
    snapshot: {
      genes: rows.map((r) => ({ geneId: r.v2, role: r.name, optional: false })),
      composition: rows.length === 1 ? leaf(rows[0]) : { Seq: { steps: rows.map((r) => leaf(r)) } },
      snapshotAt: "2026-10-20T00:00:00.000Z",
    },
    metadata: { name: "imported", createdAt: "2026-10-20T00:00:00.000Z" },
    resolutionHints: Object.fromEntries(
      rows.map((r) => [r.name, { owner: r.owner, name: r.name, version: r.version, cloudId: r.id, fidelity: r.fidelity }]),
    ),
    ...over,
  };
  if (opts.withCapabilities) {
    bp.capabilities = Object.fromEntries(
      rows.map((r) => [r.name, { domain: "text.x", inputSchemaCompat: IN, outputSchemaCompat: OUT, minFitness: 0.3 }]),
    );
  }
  return bp;
}

function writeBlueprint(bp: unknown): string {
  const file = join(root, `${randomUUID()}.rgenome`);
  writeFileSync(file, JSON.stringify(bp, null, 2));
  return file;
}

async function runImport(bp: unknown, cli: Record<string, unknown> = {}) {
  const out = captureOutput();
  try {
    const code = await runGenomeImport(writeBlueprint(bp), cli, { root, genesDir: "genes" });
    return { code, text: out.text() };
  } finally {
    out.restore();
  }
}

const agents = () =>
  existsSync(join(root, ".rotifer", "agents"))
    ? readdirSync(join(root, ".rotifer", "agents")).map((f) => JSON.parse(readFileSync(join(root, ".rotifer", "agents", f), "utf-8")))
    : [];

// ─────────────────────────────────────────────────────────────

describe("parse and validate", () => {
  it("accepts a Blueprint as export writes it and ignores unknown fields (§27.3)", () => {
    const bp = { ...blueprint([row("alpha"), row("beta")]), futureField: { anything: 1 } };
    const { plan } = parseBlueprint(JSON.stringify(bp));
    expect(plan).toEqual({ type: "Seq", roles: ["alpha", "beta"] });
  });

  it("refuses a newer blueprintFormat, a missing one, and non-JSON", () => {
    expect(() => parseBlueprint(JSON.stringify({ ...blueprint([row("alpha")]), blueprintFormat: 2 }))).toThrow("newer than this CLI");
    expect(() => parseBlueprint(JSON.stringify({ ...blueprint([row("alpha")]), blueprintFormat: undefined }))).toThrow("blueprintFormat");
    expect(() => parseBlueprint("{not json")).toThrow("Not a JSON Blueprint");
  });

  it("flattens a right-nested Par back to n-ary, with its merge strategy", () => {
    const rs = [row("alpha"), row("beta"), row("gamma"), row("delta", "3.0.0")];
    const bp = blueprint(rs, { bindingExtensions: { "rotifer-playground": { parMerge: "concat" } } });
    bp.snapshot.composition = {
      Par: { left: leaf(rs[0]), right: { Par: { left: leaf(rs[1]), right: { Par: { left: leaf(rs[2]), right: leaf(rs[3]) } } } } },
    };
    expect(compositionPlan(bp)).toEqual({ type: "Par", roles: ["alpha", "beta", "gamma", "delta"], parMerge: "concat" });
  });

  it("restores Cond with its predicate in the executor's CompareOp names, and TryCatch as Try", () => {
    const rs = [row("alpha"), row("beta")];
    const cond = blueprint(rs);
    cond.snapshot.composition = {
      Cond: { predicate: { field: "score", operator: "GTE", value: 10 }, ifTrue: leaf(rs[0]), ifFalse: leaf(rs[1]) },
    };
    expect(compositionPlan(cond)).toEqual({ type: "Cond", roles: ["alpha", "beta"], predicate: { field: "score", op: "Gte", value: 10 } });
    const tryBp = blueprint(rs);
    tryBp.snapshot.composition = { TryCatch: { body: leaf(rs[0]), handler: leaf(rs[1]) } };
    expect(compositionPlan(tryBp)).toEqual({ type: "Try", roles: ["alpha", "beta"] });
  });

  const outside: Array<[string, (bp: any, rs: Row[]) => void, string]> = [
    ["Par with a deadline", (bp, rs) => { bp.snapshot.composition = { Par: { left: leaf(rs[0]), right: leaf(rs[1]), deadline: 1000 } }; }, "Par with a deadline"],
    ["RemoteGene", (bp, rs) => { bp.snapshot.composition = { Seq: { steps: [{ RemoteGene: { agentId: "x", geneRef: leaf(rs[0]).Gene.geneRef } }, leaf(rs[1])] } }; }, "RemoteGene"],
    ["nested Seq inside Par", (bp, rs) => { bp.snapshot.composition = { Par: { left: { Seq: { steps: [leaf(rs[0])] } }, right: leaf(rs[1]) } }; }, "'Seq' appears where only a single gene may"],
    ["Cond with a nested branch", (bp, rs) => { bp.snapshot.composition = { Cond: { predicate: { field: "a", operator: "EQ", value: 1 }, ifTrue: { Seq: { steps: [leaf(rs[0])] } }, ifFalse: leaf(rs[1]) } }; }, "only a single gene"],
    ["unknown CompareOp", (bp, rs) => { bp.snapshot.composition = { Cond: { predicate: { field: "a", operator: "BETWEEN", value: 1 }, ifTrue: leaf(rs[0]), ifFalse: leaf(rs[1]) } }; }, "unknown CompareOp 'BETWEEN'"],
    ["leaves out of order", (bp, rs) => { bp.snapshot.composition = { Seq: { steps: [leaf(rs[1]), leaf(rs[0])] } }; }, "every gene of snapshot.genes once, in order"],
    // Body without a gene ID, so this case isolates the unknown operator; a gene ID under
    // an unknown operator is not a leaf position and is refused by the scan (T-20 N9, below).
    ["an unknown operator", (bp) => { bp.snapshot.composition = { Loop: { body: { times: 3 } } }; }, "'Loop' is not a §15.2 operator"],
    ["an optional gene", (bp) => { bp.snapshot.genes[0].optional = true; }, "is optional"],
  ];
  for (const [label, mutate, message] of outside) {
    it(`refuses ${label}`, () => {
      const rs = [row("alpha"), row("beta")];
      const bp = blueprint(rs);
      mutate(bp, rs);
      expect(() => parseBlueprint(JSON.stringify(bp))).toThrow(message);
    });
  }

  // T-10 #3: agent run would replace these with its defaults ("type" / "primary"),
  // so a Blueprint that says one thing would run another. Refuse them up front.
  for (const [label, predicate] of [
    ["an empty field", { field: "", operator: "EQ", value: "x" }],
    ["a null value", { field: "kind", operator: "EQ", value: null }],
  ] as const) {
    it(`refuses a Cond predicate with ${label}`, () => {
      const rs = [row("alpha"), row("beta")];
      const bp = blueprint(rs);
      bp.snapshot.composition = { Cond: { predicate, ifTrue: leaf(rs[0]), ifFalse: leaf(rs[1]) } } as never;
      expect(() => parseBlueprint(JSON.stringify(bp))).toThrow(label === "an empty field" ? "non-empty field" : "value must not be null");
    });
  }

  it("refuses a leaf whose geneId does not match snapshot.genes", () => {
    // An ID that is not in snapshot.genes is not exempt from the hex rule (T-20 N9),
    // so the scan refuses it first — and without printing it.
    const rs = [row("alpha"), row("beta")];
    const bp = blueprint(rs);
    bp.snapshot.composition = { Seq: { steps: [leaf(rs[0]), { Gene: { geneRef: { geneId: fakeV2("other"), role: "beta", optional: false } } }] } };
    expect(() => parseBlueprint(JSON.stringify(bp))).toThrow(/looks like a credential.*\/snapshot\/composition\/Seq\/steps\/1\/Gene\/geneRef\/geneId/);
    expect(() => parseBlueprint(JSON.stringify(bp))).not.toThrow(fakeV2("other"));
  });

  it("refuses a leaf whose listed geneId sits under another role", () => {
    const rs = [row("alpha"), row("beta")];
    const bp = blueprint(rs);
    bp.snapshot.composition = { Seq: { steps: [leaf(rs[0]), { Gene: { geneRef: { geneId: rs[0].v2, role: "beta", optional: false } } }] } };
    expect(() => parseBlueprint(JSON.stringify(bp))).toThrow("Composition leaf 'beta' does not match snapshot.genes");
  });

  it("re-runs the export credential scan and refuses a Blueprint that carries a key", () => {
    const bp = blueprint([row("alpha")]);
    bp.metadata.description = "deadbeef".repeat(8);
    expect(() => parseBlueprint(JSON.stringify(bp))).toThrow(/looks like a credential.*\/metadata\/description/);
    expect(() => parseBlueprint(JSON.stringify(bp))).not.toThrow("deadbeef".repeat(8));
  });

  it("refuses an author minVg below 0.5 and an unknown parMerge", () => {
    expect(() => parseBlueprint(JSON.stringify(blueprint([row("alpha")], { bindingExtensions: { "rotifer-playground": { minVg: 0.4 } } })))).toThrow("[0.5, 1.0)");
    const rs = [row("alpha"), row("beta")];
    const par = blueprint(rs, { bindingExtensions: { "rotifer-playground": { parMerge: "race" } } });
    par.snapshot.composition = { Par: { left: leaf(rs[0]), right: leaf(rs[1]) } };
    expect(() => parseBlueprint(JSON.stringify(par))).toThrow("parMerge 'race'");
  });
});

describe("#30-b lock mode: a wrong hash or a Wrapped gene must fail", () => {
  it("a geneId with one hex digit changed → exit 1 'geneId mismatch', nothing installed into genes/, no agent", async () => {
    const bp = blueprint([row("alpha")]);
    const tampered = bp.snapshot.genes[0].geneId.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    bp.snapshot.genes[0].geneId = tampered;
    (bp.snapshot.composition as any).Gene.geneRef.geneId = tampered;
    const { code, text } = await runImport(bp, { pinned: true });
    expect(code).toBe(1);
    expect(text).toContain("geneId mismatch for role 'alpha'");
    expect(existsSync(join(root, "genes", "alpha"))).toBe(false);
    expect(agents()).toEqual([]);
  });

  for (const fidelity of ["Wrapped", "wrapped"]) {
    it(`hints fidelity '${fidelity}' under --pinned → exit 1, Wrapped not supported`, async () => {
      const bp = blueprint([row("alpha")]);
      bp.resolutionHints!.alpha.fidelity = fidelity;
      const { code, text } = await runImport(bp, { pinned: true });
      expect(code).toBe(1);
      expect(text).toContain("does not support installing Wrapped genes");
      expect(installs).toEqual([]);
    });
  }

  it("an exact match installs by the Registry UUID and keeps the agent's composition", async () => {
    const rs = [row("alpha"), row("beta")];
    const bp = blueprint(rs);
    bp.snapshot.composition = {
      Cond: { predicate: { field: "lang", operator: "CONTAINS", value: "en" }, ifTrue: leaf(rs[0]), ifFalse: leaf(rs[1]) },
    };
    const { code } = await runImport(bp, { pinned: true });
    expect(code).toBe(0);
    expect(installs).toEqual(["id-alpha-1", "id-beta-1"]);
    const [agent] = agents();
    expect(agent.genome).toEqual(["alpha", "beta"]);
    // The imported predicate, not createAgentCore's default.
    expect(agent.composition).toMatchObject({ type: "Cond", predicate: { field: "lang", op: "Contains", value: "en" } });
    expect(existsSync(join(root, "genes", "alpha", "phenotype.json"))).toBe(true);
    expect(readdirSync(join(root, ".rotifer")).filter((d) => d.startsWith("import-staging"))).toEqual([]);
  });

  it("Par imports flat with its merge strategy", async () => {
    const rs = [row("alpha"), row("beta"), row("gamma")];
    const bp = blueprint(rs, { bindingExtensions: { "rotifer-playground": { parMerge: "merge" } } });
    bp.snapshot.composition = { Par: { left: leaf(rs[0]), right: { Par: { left: leaf(rs[1]), right: leaf(rs[2]) } } } };
    expect((await runImport(bp, { pinned: true })).code).toBe(0);
    expect(agents()[0].composition).toEqual({ type: "Par", branches: ["alpha", "beta", "gamma"], merge: "merge" });
  });

  it("without cloudId (or with a stale one) the version is found through listGeneVersions", async () => {
    const bp = blueprint([row("alpha")]);
    delete bp.resolutionHints!.alpha.cloudId;
    expect((await runImport(bp, { pinned: true })).code).toBe(0);
    expect(listGeneVersions).toHaveBeenCalledWith("alice", "alpha");
    expect(installs).toEqual(["id-alpha-1"]);

    rmSync(join(root, "genes", "alpha"), { recursive: true });
    const stale = blueprint([row("alpha")], { metadata: { name: "second", createdAt: "x" } });
    stale.resolutionHints!.alpha.cloudId = "id-alpha-2"; // points at 2.0.0, hints say 1.0.0
    expect((await runImport(stale, { pinned: true })).code).toBe(0);
    expect(installs.at(-1)).toBe("id-alpha-1");
  });

  it("a version the Registry no longer has fails, as does a role with no hints", async () => {
    const missing = blueprint([row("alpha")]);
    missing.resolutionHints!.alpha = { owner: "alice", name: "alpha", version: "9.9.9", fidelity: "Native" };
    const r1 = await runImport(missing, { pinned: true });
    expect(r1.code).toBe(1);
    expect(r1.text).toContain("alice/alpha@9.9.9 is not in the Registry");

    const noHints = blueprint([row("alpha")]);
    delete noHints.resolutionHints;
    const r2 = await runImport(noHints, { pinned: true });
    expect(r2.code).toBe(1);
    expect(r2.text).toContain("has no resolutionHints");
  });

  it("a different local gene with the same name is not overwritten", async () => {
    mkdirSync(join(root, "genes", "alpha"), { recursive: true });
    writeFileSync(join(root, "genes", "alpha", "phenotype.json"), "{}");
    writeFileSync(join(root, "genes", "alpha", "fake-v2"), fakeV2("someone else's alpha"));
    const { code, text } = await runImport(blueprint([row("alpha")]), { pinned: true });
    expect(code).toBe(1);
    expect(text).toContain("A different gene named 'alpha' already exists");
    expect(readFileSync(join(root, "genes", "alpha", "fake-v2"), "utf-8")).toBe(fakeV2("someone else's alpha"));
  });

  it("an identical local gene is reused without downloading", async () => {
    mkdirSync(join(root, "genes", "alpha"), { recursive: true });
    writeFileSync(join(root, "genes", "alpha", "phenotype.json"), "{}");
    writeFileSync(join(root, "genes", "alpha", "fake-v2"), row("alpha").v2);
    expect((await runImport(blueprint([row("alpha")]), { pinned: true })).code).toBe(0);
    expect(installs).toEqual([]);
  });

  it("refuses an agent name that is taken, unless --name picks another", async () => {
    expect((await runImport(blueprint([row("alpha")]), { pinned: true })).code).toBe(0);
    const again = await runImport(blueprint([row("alpha")]), { pinned: true });
    expect(again.code).toBe(1);
    expect(again.text).toContain("An agent named 'imported' already exists");
    expect((await runImport(blueprint([row("alpha")]), { pinned: true, name: "copy" })).code).toBe(0);
  });
});

describe("#30-c capability mode in import: thresholds and evidence", () => {
  it("--min-vg below 0.5 is an error", async () => {
    const { code, text } = await runImport(blueprint([row("alpha")], {}, { withCapabilities: true }), { minVg: "0.4" });
    expect(code).toBe(1);
    expect(text).toContain("--min-vg must be in [0.5, 1.0)");
  });

  it("the strictest of author suggestion, local flag and default 0.7 applies", () => {
    expect(effectiveMinVg(0.8, undefined)).toBe(0.8);
    expect(effectiveMinVg(undefined, 0.6)).toBe(0.7);
    expect(effectiveMinVg(0.75, 0.85)).toBe(0.85);
    expect(effectiveMinVg(undefined, undefined)).toBe(0.7);
  });

  it("Blueprint suggests 0.8 + local default → a 0.75 candidate is refused for V(g)", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([leaderRow(row("delta", "3.0.0"), { safety_score: 0.75 })]);
    const bp = blueprint([row("alpha")], { bindingExtensions: { "rotifer-playground": { minVg: 0.8 } } }, { withCapabilities: true });
    const r = await importGenome(writeBlueprint(bp), { isDryRun: true, now: NOW }, { root, genesDir: "genes" });
    expect(r.roles[0]).toMatchObject({ mode: "fallback", fallback: "no-admissible-candidate" });
    expect(r.roles[0].candidates![0].rejections[0].detail).toContain("threshold 0.8");
  });

  it("an admitted same-author candidate is selected; a newer version of the same gene is a self-heal upgrade", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([leaderRow(row("alpha", "2.0.0"))]);
    const bp = blueprint([row("alpha")], {}, { withCapabilities: true });
    const r = await importGenome(writeBlueprint(bp), { isDryRun: true, now: NOW }, { root, genesDir: "genes" });
    expect(r.roles[0]).toMatchObject({ mode: "capability", cloudId: "id-alpha-2", selfHealUpgrade: true, crossAuthor: false });
    expect(r.roles[0].evidence).toMatchObject({ tier: "verified", safety_score_source: "submitter-declared" });
    expect(installs).toEqual([]);
  });

  it("no admissible candidate → lock mode with fallback: no-admissible-candidate", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([leaderRow(row("alpha", "2.0.0"), { tier: "not_evaluated" })]);
    const r = await importGenome(writeBlueprint(blueprint([row("alpha")], {}, { withCapabilities: true })), { isDryRun: true, now: NOW }, { root, genesDir: "genes" });
    expect(r.roles[0]).toMatchObject({ mode: "fallback", fallback: "no-admissible-candidate", cloudId: "id-alpha-1" });
    expect(r.roles[0].candidates![0].rejections.map((x) => x.code)).toEqual(["not-verified"]);
  });

  it("evidence that cannot be read fails the import instead of falling back", async () => {
    vi.mocked(arenaLeaderboard).mockRejectedValue(new Error("network down"));
    const { code, text } = await runImport(blueprint([row("alpha")], {}, { withCapabilities: true }), { dryRun: true });
    expect(code).toBe(1);
    expect(text).toContain("could not read the Arena leaderboard");
  });

  it("a non-dry-run capability pick installs the chosen row and records its v2 in the ExecutionSnapshot", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([leaderRow(row("alpha", "2.0.0"))]);
    const r = await importGenome(writeBlueprint(blueprint([row("alpha")], {}, { withCapabilities: true })), { now: NOW }, { root, genesDir: "genes" });
    expect(installs).toEqual(["id-alpha-2"]);
    expect(r.executionSnapshot).toMatchObject({ resolvedDeps: { alpha: row("alpha", "2.0.0").v2 }, status: "ACTIVE" });
    expect(r.executionSnapshot!.genomeId).toMatch(/^bp1:[0-9a-f]{64}$/);
  });
});

describe("excludeGeneIds: an excluded top candidate is passed over at admission", () => {
  function excludingAlpha2(): GenomeBlueprint {
    const bp = blueprint([row("alpha")], {}, { withCapabilities: true });
    bp.capabilities!.alpha.excludeGeneIds = [row("alpha", "2.0.0").v2];
    return bp;
  }

  beforeEach(() => {
    // alpha@2.0.0 scores highest but is excluded; delta (same author) is next.
    vi.mocked(arenaLeaderboard).mockResolvedValue([
      leaderRow(row("alpha", "2.0.0"), { fitness_value: 0.95 }),
      leaderRow(row("delta", "3.0.0"), { fitness_value: 0.85 }),
    ]);
  });

  it("selects the next best, records why the top one was refused, and installs only the chosen row", async () => {
    const r = await importGenome(writeBlueprint(excludingAlpha2()), { now: NOW }, { root, genesDir: "genes" });
    expect(r.roles[0]).toMatchObject({ mode: "capability", cloudId: "id-delta-1", candidateGeneId: row("delta", "3.0.0").v2 });
    const refused = r.roles[0].candidates!.find((c) => c.cloudId === "id-alpha-2")!;
    expect(refused.rejections.map((x) => x.code)).toEqual(["excluded"]);
    expect(installs).toEqual(["id-delta-1"]);
    expect(agents()[0].genome).toEqual(["delta"]);
  });

  it("the dry-run resolution table shows the exclusion as the rejection reason", async () => {
    const { code, text } = await runImport(excludingAlpha2(), { dryRun: true });
    expect(code).toBe(0);
    expect(text).toContain("rejected alice/alpha@2.0.0");
    expect(text).toContain("excludeGeneIds");
    expect(installs).toEqual([]);
  });

  it("without the exclusion the top candidate is chosen (the control case)", async () => {
    const bp = blueprint([row("alpha")], {}, { withCapabilities: true });
    const r = await importGenome(writeBlueprint(bp), { isDryRun: true, now: NOW }, { root, genesDir: "genes" });
    expect(r.roles[0].cloudId).toBe("id-alpha-2");
  });

  it("installed content that differs from what was admitted fails the import", async () => {
    vi.mocked(installGeneFromCloud).mockImplementationOnce(async (_ref: string, opts: { genesDir: string }) => {
      const dir = join(opts.genesDir, "delta");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "phenotype.json"), "{}");
      writeFileSync(join(dir, "fake-v2"), fakeV2("swapped after admission"));
      return { gene: cloudGene(row("delta", "3.0.0")), geneDir: dir, didSnapshot: false, contentHashCheck: { status: "match" as const } };
    });
    const { code, text } = await runImport(excludingAlpha2(), {});
    expect(code).toBe(1);
    expect(text).toContain("not the " + row("delta", "3.0.0").v2 + " admitted");
    expect(agents()).toEqual([]);
  });
});

describe("T-10 #10: every capability pick is checked after install, exclusion list or not", () => {
  it("installed content that differs from the admitted v2 fails the import without any excludeGeneIds", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([leaderRow(row("delta", "3.0.0"))]);
    vi.mocked(installGeneFromCloud).mockImplementationOnce(async (_ref: string, opts: { genesDir: string }) => {
      const dir = join(opts.genesDir, "delta");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "phenotype.json"), "{}");
      writeFileSync(join(dir, "fake-v2"), fakeV2("swapped after admission"));
      return { gene: cloudGene(row("delta", "3.0.0")), geneDir: dir, didSnapshot: false, contentHashCheck: { status: "match" as const } };
    });
    const bp = blueprint([row("alpha")], {}, { withCapabilities: true });
    expect(bp.capabilities!.alpha.excludeGeneIds).toBeUndefined();
    const { code, text } = await runImport(bp, {});
    expect(code).toBe(1);
    expect(text).toContain("not the " + row("delta", "3.0.0").v2 + " admitted");
    expect(agents()).toEqual([]);
  });

  it("the resolution records the admitted v2 for every capability pick", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([leaderRow(row("delta", "3.0.0"))]);
    const r = await importGenome(writeBlueprint(blueprint([row("alpha")], {}, { withCapabilities: true })), { isDryRun: true, now: NOW }, { root, genesDir: "genes" });
    expect(r.roles[0]).toMatchObject({ mode: "capability", candidateGeneId: row("delta", "3.0.0").v2 });
  });
});

describe("#30-d cross-author substitution needs confirmation", () => {
  beforeEach(() => {
    // gamma (carol) is the only admissible candidate for alice's alpha.
    vi.mocked(arenaLeaderboard).mockResolvedValue([leaderRow(row("gamma"))]);
  });

  it("non-interactive without --yes → the role stays pinned and lists the refused substitute", async () => {
    const r = await importGenome(writeBlueprint(blueprint([row("alpha")], {}, { withCapabilities: true })), { now: NOW }, { root, genesDir: "genes" });
    expect(r.roles[0]).toMatchObject({ mode: "fallback", fallback: "cross-author-not-confirmed", cloudId: "id-alpha-1" });
    expect(r.roles[0].rejectedSubstitutions).toEqual([
      expect.objectContaining({ cloudId: "id-gamma-1", owner: "carol", reason: expect.stringContaining("--yes") }),
    ]);
    expect(installs).toEqual(["id-alpha-1"]);
  });

  it("--yes accepts it", async () => {
    const r = await importGenome(writeBlueprint(blueprint([row("alpha")], {}, { withCapabilities: true })), { isConfirmed: true, now: NOW }, { root, genesDir: "genes" });
    expect(r.roles[0]).toMatchObject({ mode: "capability", cloudId: "id-gamma-1", crossAuthor: true });
    expect(agents()[0].genome).toEqual(["gamma"]);
  });

  it("interactive: a 'no' keeps the original, a 'yes' takes the substitute", async () => {
    const no = await importGenome(writeBlueprint(blueprint([row("alpha")], {}, { withCapabilities: true })), { isDryRun: true, now: NOW, confirm: async () => false }, { root, genesDir: "genes" });
    expect(no.roles[0]).toMatchObject({ mode: "fallback", rejectedSubstitutions: [expect.objectContaining({ reason: "declined" })] });
    const yes = await importGenome(writeBlueprint(blueprint([row("alpha")], {}, { withCapabilities: true })), { isDryRun: true, now: NOW, confirm: async () => true }, { root, genesDir: "genes" });
    expect(yes.roles[0]).toMatchObject({ mode: "capability", cloudId: "id-gamma-1" });
  });
});

describe("output", () => {
  it("--json prints the resolution and an ExecutionSnapshot with v2 IDs", async () => {
    setOutputMode("json");
    const { code, text } = await runImport(blueprint([row("alpha"), row("beta")]), { pinned: true });
    expect(code).toBe(0);
    const parsed = JSON.parse(text);
    expect(parsed.executionSnapshot.resolvedDeps).toEqual({ alpha: row("alpha").v2, beta: row("beta").v2 });
    expect(parsed.roles.map((r: { cloudId: string }) => r.cloudId)).toEqual(["id-alpha-1", "id-beta-1"]);
  });

  it("--json failure is a JSON object with ok: false", async () => {
    setOutputMode("json");
    const { code, text } = await runImport({ blueprintFormat: 5 }, {});
    expect(code).toBe(1);
    expect(JSON.parse(text)).toMatchObject({ ok: false });
  });

  it("--dry-run installs nothing and creates no agent", async () => {
    const r = await importGenome(writeBlueprint(blueprint([row("alpha")])), { isPinned: true, isDryRun: true }, { root, genesDir: "genes" });
    expect(r.dryRun).toBe(true);
    expect(r.roles[0].geneId).toBeNull();
    expect(installs).toEqual([]);
    expect(agents()).toEqual([]);
  });

  it("GenomeImportError carries a hint", () => {
    expect(new GenomeImportError("m", "h").hint).toBe("h");
  });
});

describe("T-10 #1 (rework): a secret in the file never reaches an import error, whatever check fails first", () => {
  const SECRET = "deadbeef".repeat(8); // obviously fake, the shape of a 32-byte hex key

  async function bothModes(content: string) {
    const results: Array<{ code: number; text: string }> = [];
    for (const mode of ["human", "json"] as const) {
      setOutputMode(mode);
      const file = join(root, `${randomUUID()}.rgenome`);
      writeFileSync(file, content);
      const out = captureOutput();
      try {
        results.push({ code: await runGenomeImport(file, {}, { root, genesDir: "genes" }), text: out.text() });
      } finally {
        out.restore();
      }
    }
    setOutputMode("human");
    return results;
  }

  it("a secret used as a capabilities role name that snapshot.genes lacks", async () => {
    const bp = blueprint([row("alpha")], {}, { withCapabilities: true });
    bp.capabilities![SECRET] = bp.capabilities!.alpha;
    for (const { code, text } of await bothModes(JSON.stringify(bp))) {
      expect(code).toBe(1);
      expect(text).not.toContain(SECRET);
      expect(text).toContain("<redacted key #");
    }
  });

  it("a secret used as snapshot.genes[0].role with an invalid geneId", async () => {
    const bp = blueprint([row("alpha")]);
    bp.snapshot.genes[0] = { geneId: "not-a-v2-id", role: SECRET, optional: false };
    for (const { code, text } of await bothModes(JSON.stringify(bp))) {
      expect(code).toBe(1);
      expect(text).not.toContain(SECRET);
    }
  });

  it("malformed JSON is reported by position only, never with a quote of the input", async () => {
    for (const { code, text } of await bothModes(`{"blueprintFormat": 1, "x": ${SECRET}}`)) {
      expect(code).toBe(1);
      expect(text).toContain("Not a JSON Blueprint");
      expect(text).not.toContain("deadbeef");
    }
  });
});

describe("T-20: second-round red-team findings on import", () => {
  const SECRET_HEX = "deadbeef".repeat(8); // obviously fake, the shape of a 32-byte key

  describe("N1: non-finite numbers are refused anywhere in the file", () => {
    // JSON.parse turns 1e400 into Infinity; saving writes null; agent run then swaps in its default.
    const withNumber = (place: (bp: any) => void) => {
      const rs = [row("alpha"), row("beta")];
      const bp: any = blueprint(rs);
      bp.snapshot.composition = { Cond: { predicate: { field: "score", operator: "GT", value: 0 }, ifTrue: leaf(rs[0]), ifFalse: leaf(rs[1]) } };
      place(bp);
      return JSON.stringify(bp).replace(/"__HUGE__"/g, "1e400").replace(/"__NEG_HUGE__"/g, "-1e400");
    };

    it("Cond value 1e400", () => {
      expect(() => parseBlueprint(withNumber((bp) => { bp.snapshot.composition.Cond.predicate.value = "__HUGE__"; }))).toThrow(
        "not a finite number at /snapshot/composition/Cond/predicate/value",
      );
    });

    it("-1e400 in a field nothing else checks", () => {
      expect(() => parseBlueprint(withNumber((bp) => { bp.metadata.extra = { limits: [1, "__NEG_HUGE__"] }; }))).toThrow(
        "not a finite number at /metadata/extra/limits/1",
      );
    });

    it("the import command exits 1 and creates no agent", async () => {
      const text = withNumber((bp) => { bp.snapshot.composition.Cond.predicate.value = "__HUGE__"; });
      const file = join(root, `${randomUUID()}.rgenome`);
      writeFileSync(file, text);
      const out = captureOutput();
      let code: number;
      try {
        code = await runGenomeImport(file, { pinned: true }, { root, genesDir: "genes" });
      } finally {
        out.restore();
      }
      expect(code).toBe(1);
      expect(agents()).toEqual([]);
    });

    it("ordinary numbers still parse", () => {
      // 1e-300, not 1e300: integer-valued numbers beyond 2^53 are refused for another reason (T-22).
      expect(() => parseBlueprint(withNumber((bp) => { bp.snapshot.composition.Cond.predicate.value = 1e-300; }))).not.toThrow();
    });
  });

  describe("N9: the gene-ID exemption covers real leaves with listed IDs only", () => {
    it("a v2-shaped secret hidden in an extra geneRef inside a Gene body is refused, without echoing it", async () => {
      const rs = [row("alpha")];
      const bp: any = blueprint(rs);
      bp.snapshot.composition = { Gene: { geneRef: leaf(rs[0]).Gene.geneRef, ignored: { geneRef: { geneId: "v2:" + SECRET_HEX } } } };
      expect(() => parseBlueprint(JSON.stringify(bp))).toThrow(/looks like a credential.*\/snapshot\/composition\/Gene\/ignored\/geneRef\/geneId/);
      const { code, text } = await runImport(bp, { pinned: true });
      expect(code).toBe(1);
      expect(text).not.toContain(SECRET_HEX);
    });

    it("a listed ID under an operator outside the subset is not a leaf position, so the scan refuses it", () => {
      const rs = [row("alpha")];
      const bp: any = blueprint(rs);
      bp.snapshot.composition = { Loop: { body: leaf(rs[0]) } };
      expect(() => parseBlueprint(JSON.stringify(bp))).toThrow(/looks like a credential.*\/snapshot\/composition\/Loop\/body\/Gene\/geneRef\/geneId/);
    });

    it("the same trick deeper in a Seq step is refused too", () => {
      const rs = [row("alpha"), row("beta")];
      const bp: any = blueprint(rs);
      bp.snapshot.composition.Seq.steps[1].Gene.ignored = { geneRef: { geneId: "v2:" + SECRET_HEX } };
      expect(() => parseBlueprint(JSON.stringify(bp))).toThrow("looks like a credential");
    });

    it("real leaves with listed IDs still pass, in every operator", () => {
      const rs = [row("alpha"), row("beta"), row("gamma")];
      const compositions = [
        { Seq: { steps: rs.map((r) => leaf(r)) } },
        { Par: { left: leaf(rs[0]), right: { Par: { left: leaf(rs[1]), right: leaf(rs[2]) } } } },
      ];
      for (const composition of compositions) {
        const bp = blueprint(rs, { bindingExtensions: { "rotifer-playground": { parMerge: "first" } } });
        bp.snapshot.composition = composition as never;
        expect(() => parseBlueprint(JSON.stringify(bp))).not.toThrow();
      }
      const two = [row("alpha"), row("beta")];
      for (const composition of [
        { Cond: { predicate: { field: "a", operator: "EQ", value: 1 }, ifTrue: leaf(two[0]), ifFalse: leaf(two[1]) } },
        { TryCatch: { body: leaf(two[0]), handler: leaf(two[1]) } },
      ]) {
        const bp = blueprint(two);
        bp.snapshot.composition = composition as never;
        expect(() => parseBlueprint(JSON.stringify(bp))).not.toThrow();
      }
    });
  });
});

describe("T-22: integers JSON.parse cannot hold exactly are refused", () => {
  // 9007199254740993 is read as 9007199254740992 — a different value, decided before any check runs.
  const withNumber = (literal: string, place: (bp: any) => void) => {
    const rs = [row("alpha"), row("beta")];
    const bp: any = blueprint(rs);
    bp.snapshot.composition = { Cond: { predicate: { field: "score", operator: "EQ", value: 0 }, ifTrue: leaf(rs[0]), ifFalse: leaf(rs[1]) } };
    place(bp);
    return JSON.stringify(bp).replace(/"__N__"/g, literal);
  };
  const atCondValue = (bp: any) => { bp.snapshot.composition.Cond.predicate.value = "__N__"; };

  it("a Cond value above 2^53 is refused, naming its position", () => {
    expect(() => parseBlueprint(withNumber("9007199254740993", atCondValue))).toThrow(
      "integer outside the exactly representable range at /snapshot/composition/Cond/predicate/value",
    );
  });

  it("a negative one in a field nothing else checks is refused", () => {
    expect(() => parseBlueprint(withNumber("-9007199254740993", (bp) => { bp.metadata.extra = { ids: [1, "__N__"] }; }))).toThrow(
      "at /metadata/extra/ids/1",
    );
  });

  it("2^53 itself is refused: it cannot be told apart from 2^53 + 1", () => {
    expect(() => parseBlueprint(withNumber("9007199254740992", atCondValue))).toThrow("integer outside the exactly representable range");
  });

  it("the import command exits 1 and creates no agent", async () => {
    const file = join(root, `${randomUUID()}.rgenome`);
    writeFileSync(file, withNumber("9007199254740993", atCondValue));
    const out = captureOutput();
    let code: number;
    try {
      code = await runGenomeImport(file, { pinned: true }, { root, genesDir: "genes" });
    } finally {
      out.restore();
    }
    expect(code).toBe(1);
    expect(agents()).toEqual([]);
  });

  // CEO ruling: judge the parsed value, not its spelling. Any integer outside the
  // safe range is refused however it is written — so 9007199254740993e0 and
  // ...993.0 are caught, and 1e20 / 1.5e300 (integer-valued) are refused too.
  it("float spellings of an out-of-range integer are refused, and so are large integer-valued floats", () => {
    for (const literal of ["9007199254740993e0", "9007199254740993.0", "9007199254740993.5", "1e20", "1.5e300", "-1e20"]) {
      expect(() => parseBlueprint(withNumber(literal, atCondValue)), literal).toThrow("integer outside the exactly representable range");
    }
  });

  it("safe integers and fractional numbers are not refused", () => {
    for (const literal of ["9007199254740991", "-9007199254740991", "12", "0", "0.1", "1.5e3", "-2.5", "1e-7"]) {
      expect(() => parseBlueprint(withNumber(literal, atCondValue)), literal).not.toThrow();
    }
  });
});

describe("T-23: refuse what the executor or canonical JSON cannot honour (R3, R5)", () => {
  /** A two-gene Cond Blueprint; `predicate` replaces the default one. */
  const condBlueprint = (predicate: Record<string, unknown>) => {
    const rs = [row("alpha"), row("beta")];
    const bp: any = blueprint(rs);
    bp.snapshot.composition = { Cond: { predicate, ifTrue: leaf(rs[0]), ifFalse: leaf(rs[1]) } };
    return bp;
  };

  describe("R3: Cond forms the executor does not implement", () => {
    it("MATCHES is refused (the executor always evaluates it to false)", () => {
      expect(() => parseBlueprint(JSON.stringify(condBlueprint({ field: "kind", operator: "MATCHES", value: "^a" })))).toThrow(
        "MATCHES is not executed",
      );
    });

    it("CONTAINS with a non-string value is refused (the executor only handles strings)", () => {
      for (const value of [5, ["a"], { a: 1 }, true]) {
        expect(() => parseBlueprint(JSON.stringify(condBlueprint({ field: "kind", operator: "CONTAINS", value }))), JSON.stringify(value)).toThrow(
          "CONTAINS needs a string value",
        );
      }
    });

    it("a field path is refused: field is a top-level name only", () => {
      for (const field of ["a.b", "a/b", "outer.inner.leaf"]) {
        expect(() => parseBlueprint(JSON.stringify(condBlueprint({ field, operator: "EQ", value: 1 }))), field).toThrow("top-level field name");
      }
    });

    it("supported forms still parse", () => {
      for (const predicate of [
        { field: "kind", operator: "CONTAINS", value: "x" },
        { field: "score", operator: "GTE", value: 10 },
        { field: "flag_1", operator: "NEQ", value: false },
      ]) {
        expect(() => parseBlueprint(JSON.stringify(condBlueprint(predicate))), JSON.stringify(predicate)).not.toThrow();
      }
    });
  });

  describe("R5: input canonical JSON cannot represent", () => {
    it("a lone surrogate in a value is refused, naming its position", () => {
      const text = JSON.stringify({ ...blueprint([row("alpha")]), metadata: { name: "x", description: "__S__", createdAt: "t" } }).replace(
        '"__S__"',
        '"bad \\ud800 text"',
      );
      expect(() => parseBlueprint(text)).toThrow("unpaired surrogate at /metadata/description");
    });

    it("a lone surrogate in a key is refused without printing the key", () => {
      const text = JSON.stringify({ ...blueprint([row("alpha")]), extra: { __K__: 1 } }).replace('"__K__"', '"k\\udc00"');
      expect(() => parseBlueprint(text)).toThrow("unpaired surrogate at /extra/<key with an unpaired surrogate>");
    });

    it("a well-formed surrogate pair (an emoji) is fine", () => {
      const text = JSON.stringify({ ...blueprint([row("alpha")]), metadata: { name: "x", description: "__S__", createdAt: "t" } }).replace(
        '"__S__"',
        '"ok \\ud83d\\ude00"',
      );
      expect(() => parseBlueprint(text)).not.toThrow();
    });

    it("a duplicate key is refused, naming where it repeats", () => {
      const text = JSON.stringify(condBlueprint({ field: "kind", operator: "EQ", value: 1 })).replace(
        '"operator":"EQ"',
        '"operator":"EQ","operator":"NEQ"',
      );
      expect(() => parseBlueprint(text)).toThrow("duplicate key at /snapshot/composition/Cond/predicate/operator");
    });

    it("a duplicate spelled with an escape is still a duplicate", () => {
      const text = JSON.stringify(blueprint([row("alpha")])).replace('"blueprintFormat":1', '"blueprintFormat":1,"blueprint\\u0046ormat":1');
      expect(() => parseBlueprint(text)).toThrow("duplicate key at /blueprintFormat");
    });

    it("the same key in different objects, or quoted inside a string, is not a duplicate", () => {
      const bp = blueprint([row("alpha"), row("beta")]);
      bp.metadata.description = 'looks like {"a":1,"a":2} but is text';
      expect(() => parseBlueprint(JSON.stringify(bp))).not.toThrow();
    });
  });

  it("genomeId is known before anything is written: a dry run reports the same one the real import records", async () => {
    const file = writeBlueprint(blueprint([row("alpha"), row("beta")]));
    const dry = await importGenome(file, { isPinned: true, isDryRun: true }, { root, genesDir: "genes" });
    expect(installs).toEqual([]);
    expect(dry.genomeId).toMatch(/^bp1:[0-9a-f]{64}$/);
    const real = await importGenome(file, { isPinned: true }, { root, genesDir: "genes" });
    expect(real.executionSnapshot!.genomeId).toBe(dry.genomeId);
    expect(real.genomeId).toBe(dry.genomeId);
  });
});

describe("T-21b: RFC draft 5 reader rules (B3, B5)", () => {
  /** The text of a valid two-gene Blueprint after `mutate` edits it. */
  const edited = (mutate: (bp: any) => void) => {
    const bp: any = blueprint([row("alpha"), row("beta")], {}, { withCapabilities: true });
    mutate(bp);
    return JSON.stringify(bp);
  };

  it("B3: a Blueprint without composition is refused, for one gene and for several", () => {
    for (const rows of [[row("alpha")], [row("alpha"), row("beta")]]) {
      const bp: any = blueprint(rows);
      delete bp.snapshot.composition;
      expect(() => parseBlueprint(JSON.stringify(bp)), `${rows.length} gene(s)`).toThrow("no snapshot.composition");
    }
  });

  it("B3: the import command exits 1 and creates no agent", async () => {
    const bp: any = blueprint([row("alpha"), row("beta")]);
    delete bp.snapshot.composition;
    const { code, text } = await runImport(bp, { pinned: true });
    expect(code).toBe(1);
    expect(text).toContain("no snapshot.composition");
    expect(installs).toEqual([]);
    expect(agents()).toEqual([]);
  });

  const refused: Array<[string, (bp: any) => void, string]> = [
    ["no protocolVersion", (bp) => { delete bp.protocolVersion; }, "protocolVersion must be"],
    ["a protocolVersion that is a string", (bp) => { bp.protocolVersion = "0.9.2"; }, "protocolVersion must be"],
    ["a protocolVersion part that is not an integer", (bp) => { bp.protocolVersion.minor = 9.5; }, "protocolVersion must be"],
    ["a negative protocolVersion part", (bp) => { bp.protocolVersion.patch = -1; }, "protocolVersion must be"],
    ["no supportedFeatures", (bp) => { delete bp.protocolVersion.supportedFeatures; }, "protocolVersion must be"],
    ["a supportedFeatures entry that is not a string", (bp) => { bp.protocolVersion.supportedFeatures = [1]; }, "protocolVersion must be"],
    ["no metadata", (bp) => { delete bp.metadata; }, "metadata.createdAt"],
    ["no metadata.createdAt", (bp) => { delete bp.metadata.createdAt; }, "metadata.createdAt"],
    ["a metadata.name that is not a string", (bp) => { bp.metadata.name = 7; }, "metadata.name must be a string"],
    ["no snapshot.snapshotAt", (bp) => { delete bp.snapshot.snapshotAt; }, "snapshot.snapshotAt"],
    ["a gene without optional", (bp) => { delete bp.snapshot.genes[0].optional; }, "needs optional: true or false"],
    ["optional: \"yes\"", (bp) => { bp.snapshot.genes[1].optional = "yes"; }, "needs optional: true or false"],
    ["a capability without inputSchemaCompat", (bp) => { delete bp.capabilities.alpha.inputSchemaCompat; }, "has no inputSchemaCompat"],
    ["a capability without outputSchemaCompat", (bp) => { delete bp.capabilities.beta.outputSchemaCompat; }, "has no outputSchemaCompat"],
    ["a capability without minFitness", (bp) => { delete bp.capabilities.alpha.minFitness; }, "minFitness must be a number"],
    ["a bindingExtensions that is an array", (bp) => { bp.bindingExtensions = []; }, "bindingExtensions must be an object"],
    ["a bindingExtensions value that is not an object", (bp) => { bp.bindingExtensions = { "other-binding": "on" }; }, "bindingExtensions['other-binding'] must be an object"],
    ["an unknown parMerge outside a Par composition", (bp) => { bp.bindingExtensions = { "rotifer-playground": { parMerge: "zip" } }; }, "is not first, concat or merge"],
    ["a Cond field with [ or ]", (bp) => {
      bp.snapshot.composition = { Cond: { predicate: { field: "items[0]", operator: "EQ", value: 1 }, ifTrue: leaf(row("alpha")), ifFalse: leaf(row("beta")) } };
    }, "top-level field name"],
  ];
  for (const [label, mutate, message] of refused) {
    it(`B5: refuses ${label}`, () => {
      expect(() => parseBlueprint(edited(mutate))).toThrow(message);
    });
  }

  it("B5 controls: optional false, other bindings' unknown fields, any protocolVersion value and annotated metadata pass", () => {
    expect(() =>
      parseBlueprint(
        edited((bp) => {
          bp.protocolVersion = { major: 9, minor: 0, patch: 0, supportedFeatures: [] };
          bp.metadata.description = "d";
          bp.metadata.author = "a";
          bp.bindingExtensions = { "other-binding": { anything: [1] }, "rotifer-playground": { futureKnob: true, minVg: 0.8 } };
        }),
      ),
    ).not.toThrow();
  });
});

describe("T-21b: genomeId is bp1: + SHA-256 of the canonical execution projection (B4)", () => {
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const idOf = (bp: unknown) => parseBlueprint(JSON.stringify(bp)).genomeId;
  const rs = () => [row("alpha"), row("beta")];
  const parBp = (over: Partial<GenomeBlueprint> = {}) => {
    const bp: any = blueprint(rs(), over);
    bp.snapshot.composition = { Par: { left: leaf(rs()[0]), right: leaf(rs()[1]) } };
    return bp;
  };

  it("jcs reproduces the RFC 8785 vectors the Rust gene-ID tests use", () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, "../../crates/rotifer-core/tests/fixtures/gene-id-v2/vectors.json"), "utf-8"),
    ) as { vectors: Array<{ kind: string; name: string; value: unknown; expected: string }> };
    const vectors = fixture.vectors.filter((v) => v.kind === "jcs");
    expect(vectors.length).toBe(2);
    for (const v of vectors) expect(jcs(v.value), v.name).toBe(v.expected);
  });

  it("matches the projection written out by hand, for Gene, Seq, Par, Cond and TryCatch", () => {
    const [a, b] = rs();
    const single = blueprint([a]);
    expect(idOf(single)).toBe(`bp1:${sha(`{"Gene":"${a.v2}"}`)}`);
    expect(idOf(blueprint([a, b]))).toBe(`bp1:${sha(`{"Seq":[{"Gene":"${a.v2}"},{"Gene":"${b.v2}"}]}`)}`);
    expect(idOf(parBp())).toBe(`bp1:${sha(`{"Par":{"left":{"Gene":"${a.v2}"},"merge":"first","right":{"Gene":"${b.v2}"}}}`)}`);
    const cond: any = blueprint([a, b]);
    cond.snapshot.composition = { Cond: { predicate: { field: "score", operator: "GTE", value: 10 }, ifTrue: leaf(a), ifFalse: leaf(b) } };
    expect(idOf(cond)).toBe(
      `bp1:${sha(`{"Cond":{"field":"score","ifFalse":{"Gene":"${b.v2}"},"ifTrue":{"Gene":"${a.v2}"},"operator":"GTE","value":10}}`)}`,
    );
    const tryBp: any = blueprint([a, b]);
    tryBp.snapshot.composition = { TryCatch: { body: leaf(a), handler: leaf(b) } };
    expect(idOf(tryBp)).toBe(`bp1:${sha(`{"TryCatch":{"body":{"Gene":"${a.v2}"},"handler":{"Gene":"${b.v2}"}}}`)}`);
  });

  it("is unchanged by everything the projection leaves out", () => {
    const base = idOf(blueprint(rs(), {}, { withCapabilities: true }));
    const variants: Array<[string, (bp: any) => void]> = [
      ["role names", (bp) => {
        bp.snapshot.genes.forEach((g: any, i: number) => (g.role = `role${i}`));
        bp.snapshot.composition.Seq.steps.forEach((s: any, i: number) => (s.Gene.geneRef.role = `role${i}`));
        delete bp.capabilities;
        delete bp.resolutionHints;
      }],
      ["snapshotAt and metadata", (bp) => { bp.snapshot.snapshotAt = "2030-01-01T00:00:00Z"; bp.metadata = { name: "other", description: "d", createdAt: "x" }; }],
      ["capabilities, hints and minVg", (bp) => { delete bp.capabilities; delete bp.resolutionHints; bp.bindingExtensions = { "rotifer-playground": { minVg: 0.9 } }; }],
      ["protocolVersion and unknown fields", (bp) => { bp.protocolVersion = { major: 1, minor: 0, patch: 0, supportedFeatures: [] }; bp.future = { a: 1 }; bp.snapshot.later = 2; }],
      ["extra members inside operator bodies and geneRefs", (bp) => {
        bp.snapshot.composition.Seq.note = "ignored";
        bp.snapshot.composition.Seq.steps[0].Gene.note = "ignored";
        bp.snapshot.composition.Seq.steps[1].Gene.geneRef.label = "ignored";
      }],
      ["the order members are written in", (bp) => { bp.snapshot = { snapshotAt: bp.snapshot.snapshotAt, composition: bp.snapshot.composition, genes: bp.snapshot.genes }; }],
    ];
    for (const [label, mutate] of variants) {
      const bp: any = blueprint(rs(), {}, { withCapabilities: true });
      mutate(bp);
      expect(idOf(bp), label).toBe(base);
    }
  });

  it("an absent parMerge and an explicit \"first\" give the same ID; concat does not", () => {
    const absent = idOf(parBp());
    expect(idOf(parBp({ bindingExtensions: { "rotifer-playground": { parMerge: "first" } } }))).toBe(absent);
    expect(idOf(parBp({ bindingExtensions: { "rotifer-playground": { parMerge: "concat" } } }))).not.toBe(absent);
  });

  it("changes with what runs: a gene ID, the gene order, the Cond value or operator", () => {
    const [a, b] = rs();
    const base = idOf(blueprint([a, b]));
    expect(idOf(blueprint([a, row("gamma")]))).not.toBe(base);
    expect(idOf(blueprint([b, a]))).not.toBe(base);
    const cond = (operator: string, value: unknown) => {
      const bp: any = blueprint([a, b]);
      bp.snapshot.composition = { Cond: { predicate: { field: "score", operator, value }, ifTrue: leaf(a), ifFalse: leaf(b) } };
      return idOf(bp);
    };
    expect(cond("GTE", 10)).not.toBe(cond("GTE", 11));
    expect(cond("GTE", 10)).not.toBe(cond("GT", 10));
    expect(cond("EQ", 10)).not.toBe(cond("EQ", "10"));
  });

  it("computeGenomeId is what the import reports", async () => {
    const bp = blueprint(rs());
    const result = await importGenome(writeBlueprint(bp), { isPinned: true, isDryRun: true }, { root, genesDir: "genes" });
    expect(result.genomeId).toBe(computeGenomeId(bp));
  });
});

describe("T-21b: export → import → export round trip, one per composition", () => {
  /** A project whose genes are the Registry rows, as `install` leaves them. */
  function sourceProject(rows: Row[]): string {
    const src = join(root, "source-project");
    for (const r of rows) {
      const dir = join(src, "genes", r.name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "phenotype.json"), JSON.stringify(cloudGene(r).phenotype));
      writeFileSync(join(dir, "fake-v2"), r.v2);
      writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify({ cloud_id: r.id, owner: r.owner, version: r.version }));
    }
    return src;
  }

  const cases: Array<[string, Row[], Record<string, unknown>, Record<string, unknown>]> = [
    ["single Gene", [row("alpha")], { type: "Single" }, { type: "Single" }],
    ["Seq", [row("alpha"), row("beta"), row("gamma")], { type: "Seq" }, { type: "Seq" }],
    ["Par", [row("alpha"), row("beta"), row("gamma")], { type: "Par", merge: "concat" }, { type: "Par", branches: ["alpha", "beta", "gamma"], merge: "concat" }],
    ["Cond", [row("alpha"), row("beta")], { type: "Cond", predicate: { field: "lang", op: "Contains", value: "en" } }, { type: "Cond", predicate: { field: "lang", op: "Contains", value: "en" } }],
    ["Try", [row("alpha"), row("beta")], { type: "Try" }, { type: "Try" }],
  ];

  for (const [label, rows, composition, imported] of cases) {
    it(`${label}: the file imports, and the imported agent exports to the same composition and genomeId`, async () => {
      const src = sourceProject(rows);
      const original = writeAgent(src, "original", rows.map((r) => r.name), composition);
      const first = join(root, "first.rgenome");
      exportGenome({ root: src, genesDir: "genes", agent: original, output: first });

      const out = captureOutput();
      let code: number;
      try {
        code = await runGenomeImport(first, { pinned: true }, { root, genesDir: "genes" });
      } finally {
        out.restore();
      }
      expect(code, out.text()).toBe(0);
      const [agent] = agents();
      expect(agent.genome).toEqual(rows.map((r) => r.name));
      expect(agent.composition).toMatchObject(imported);

      const second = join(root, "second.rgenome");
      exportGenome({ root, genesDir: "genes", agent: findAgent(root, "original"), output: second });
      const a = parseBlueprint(readFileSync(first, "utf-8"));
      const b = parseBlueprint(readFileSync(second, "utf-8"));
      expect(b.blueprint.snapshot.composition).toEqual(a.blueprint.snapshot.composition);
      expect(b.blueprint.bindingExtensions).toEqual(a.blueprint.bindingExtensions);
      expect(b.genomeId).toBe(a.genomeId);
    });
  }
});

describe("T-25: red-team round 5 findings on the reader (N1, N2, N3)", () => {
  const condWith = (operator: string) => {
    const rs = [row("alpha"), row("beta")];
    const bp: any = blueprint(rs);
    bp.snapshot.composition = { Cond: { predicate: { field: "kind", operator, value: "x" }, ifTrue: leaf(rs[0]), ifFalse: leaf(rs[1]) } };
    return JSON.stringify(bp);
  };

  it("N1: an operator named after an Object.prototype member is refused, not run as Eq", () => {
    for (const operator of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
      expect(() => parseBlueprint(condWith(operator)), operator).toThrow(`unknown CompareOp '${operator}'`);
    }
  });

  it("N1: the import command exits 1 for one and creates no agent", async () => {
    const { code, text } = await runImport(JSON.parse(condWith("toString")), { pinned: true });
    expect(code).toBe(1);
    expect(text).toContain("unknown CompareOp 'toString'");
    expect(installs).toEqual([]);
    expect(agents()).toEqual([]);
  });

  it("N1 control: the seven executed operators still parse", () => {
    for (const operator of ["EQ", "NEQ", "GT", "GTE", "LT", "LTE", "CONTAINS"]) {
      expect(() => parseBlueprint(condWith(operator)), operator).not.toThrow();
    }
  });

  it("N2: an explicit null parMerge is refused, in a Par and outside one; only an absent one means first", () => {
    const rs = [row("alpha"), row("beta")];
    const par: any = blueprint(rs, { bindingExtensions: { "rotifer-playground": { parMerge: null } } as any });
    par.snapshot.composition = { Par: { left: leaf(rs[0]), right: leaf(rs[1]) } };
    expect(() => parseBlueprint(JSON.stringify(par))).toThrow("parMerge 'null' is not first, concat or merge");
    const seq = blueprint(rs, { bindingExtensions: { "rotifer-playground": { parMerge: null } } as any });
    expect(() => parseBlueprint(JSON.stringify(seq))).toThrow("parMerge 'null' is not first, concat or merge");
    delete par.bindingExtensions;
    expect(parseBlueprint(JSON.stringify(par)).plan.parMerge).toBe("first");
  });

  it("N3: leaves out of list order are refused even when the role names joined with NUL coincide", () => {
    const [a, b] = [row("alpha"), row("beta")];
    const bp: any = blueprint([a, b]);
    bp.snapshot.genes = [
      { geneId: a.v2, role: "a", optional: false },
      { geneId: b.v2, role: "a\u0000a", optional: false },
    ];
    delete bp.resolutionHints;
    bp.snapshot.composition = { Seq: { steps: [leaf(b, "a\u0000a"), leaf(a, "a")] } };
    expect(() => parseBlueprint(JSON.stringify(bp))).toThrow("every gene of snapshot.genes once, in order");
    // Control: the same roles in list order parse.
    bp.snapshot.composition = { Seq: { steps: [leaf(a, "a"), leaf(b, "a\u0000a")] } };
    expect(parseBlueprint(JSON.stringify(bp)).plan.roles).toEqual(["a", "a\u0000a"]);
  });
});

describe("T-26: a role named after an Object.prototype member is looked up as an own key only", () => {
  const NAMES = ["toString", "constructor", "__proto__", "hasOwnProperty"];

  /** alpha is importable; the second role has no hint and no capability entry of its own. */
  function withRole(name: string): GenomeBlueprint {
    const [a, b] = [row("alpha"), row("beta")];
    const bp = blueprint([a], {}, { withCapabilities: true });
    bp.snapshot.genes.push({ geneId: b.v2, role: name, optional: false });
    bp.snapshot.composition = { Seq: { steps: [leaf(a), leaf(b, name)] } };
    return bp;
  }

  for (const name of NAMES) {
    for (const [mode, cli] of [["--pinned", { pinned: true }], ["capability mode", {}], ["--dry-run", { pinned: true, dryRun: true }]] as const) {
      it(`role '${name}' (${mode}): a clear error, nothing installed or created`, async () => {
        const { code, text } = await runImport(withRole(name), cli);
        expect(code).toBe(1);
        expect(text).toContain(`Role '${name}' has no resolutionHints`);
        expect(text).not.toMatch(/TypeError|Cannot read properties/);
        expect(installs).toEqual([]);
        expect(agents()).toEqual([]);
        expect(readdirSync(join(root, "genes"))).toEqual([]);
      });
    }
  }

  it("the same names with their own hints still resolve", async () => {
    for (const name of NAMES) {
      const bp = withRole(name);
      bp.resolutionHints = { ...bp.resolutionHints, [name]: { owner: "bob", name: "beta", version: "1.0.0", cloudId: "id-beta-1", fidelity: "Hybrid" } };
      const result = await importGenome(writeBlueprint(bp), { isPinned: true, isDryRun: true }, { root, genesDir: "genes" });
      expect(result.roles.map((r) => r.role), name).toEqual(["alpha", name]);
      expect(result.roles[1].cloudId).toBe("id-beta-1");
    }
  });
});

describe("T-42: the hint for a role that must be pinned follows what the user actually passed", () => {
  /** alpha, hinted as Wrapped: it can only be imported through a Native/Hybrid substitute. */
  const wrapped = (opts: { withCapabilities?: boolean } = { withCapabilities: true }) => {
    const bp = blueprint([row("alpha")], {}, opts);
    bp.resolutionHints!.alpha.fidelity = "Wrapped";
    return bp;
  };

  it("with --pinned: tells the user to drop --pinned", async () => {
    const { code, text } = await runImport(wrapped(), { pinned: true });
    expect(code).toBe(1);
    expect(text).toContain("is a Wrapped gene");
    expect(text).toContain("Drop --pinned so capability mode can look for a Native/Hybrid substitute.");
  });

  it("without --pinned, nothing on the leaderboard: no mention of --pinned, says the search found no candidate", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([]);
    const { code, text } = await runImport(wrapped(), {});
    expect(code).toBe(1);
    expect(text).toContain("is a Wrapped gene");
    expect(text).not.toContain("--pinned");
    expect(text).toContain("Capability mode looked for a Native/Hybrid substitute in domain 'text.x' and admitted none: the Arena lists no candidates there.");
    expect(text).toContain("ask the author to publish a Native/Hybrid build");
    expect(installs).toEqual([]);
    expect(agents()).toEqual([]);
  });

  it("without --pinned, candidates all refused: says why, in words", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([
      leaderRow(row("alpha", "2.0.0"), { tier: "under_evaluation" }),
      leaderRow(row("gamma"), { tier: "not_evaluated" }),
    ]);
    const { code, text } = await runImport(wrapped(), {});
    expect(code).toBe(1);
    expect(text).not.toContain("--pinned");
    expect(text).toContain("admitted none: 2 candidates, refused as not in the verified Arena tier (2).");
  });

  it("without --pinned, no capability query in the Blueprint: says no substitute could be searched for", async () => {
    const { code, text } = await runImport(wrapped({ withCapabilities: false }), {});
    expect(code).toBe(1);
    expect(text).not.toContain("--pinned");
    expect(text).toContain("The Blueprint has no capability query for role 'alpha'");
    expect(text).toContain("export it again without --lock");
  });

  it("without --pinned, a cross-author substitute passed but was not accepted: points to --yes", async () => {
    vi.mocked(arenaLeaderboard).mockResolvedValue([leaderRow(row("gamma"))]);
    const { code, text } = await runImport(wrapped(), {});
    expect(code).toBe(1);
    expect(text).not.toContain("--pinned");
    expect(text).toContain("A substitute by another author passed admission (carol/gamma@1.0.0) but was not accepted. Re-run with --yes to accept it.");
  });

  it("a role with no resolutionHints: drop --pinned only when it was passed", async () => {
    const bp = blueprint([row("alpha")], {}, { withCapabilities: true });
    delete bp.resolutionHints;
    const pinnedRun = await runImport(bp, { pinned: true });
    expect(pinnedRun.text).toContain("has no resolutionHints");
    expect(pinnedRun.text).toContain("drop --pinned so capability mode can look for a substitute");
    vi.mocked(arenaLeaderboard).mockResolvedValue([]);
    const capabilityRun = await runImport(bp, {});
    expect(capabilityRun.text).toContain("has no resolutionHints");
    expect(capabilityRun.text).not.toContain("--pinned");
    expect(capabilityRun.text).not.toContain("import with capability mode");
    expect(capabilityRun.text).toContain("admitted none: the Arena lists no candidates there.");
  });
});
