import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// The real v2 ID needs the native addon, which CI's unit lane may not load;
// these tests pin the export logic around it. tests/e2e/genome-export.test.ts
// covers the real addon end to end.
vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/utils/binding.js")>()),
  geneIdV2: vi.fn(),
}));

import { geneIdV2 } from "../../src/utils/binding.js";
import {
  buildBlueprint,
  runGenomeExport,
  DEFAULT_MIN_FITNESS,
  type AlgebraExpr,
  type GenomeBlueprint,
} from "../../src/commands/genome.js";
import { captureOutput, fakeV2, writeAgent, writeGene } from "./genome-test-helpers.js";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `genome-export-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  vi.mocked(geneIdV2).mockImplementation((_genesRoot, name) => ({ id: fakeV2(name) }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.mocked(geneIdV2).mockReset();
});

const ctx = () => ({ root, genesDir: "genes" });

function exportAgent(ref: string, opts: Record<string, unknown> = {}) {
  const out = captureOutput();
  const file = join(root, `${randomUUID()}.rgenome`);
  try {
    const code = runGenomeExport(ref, { output: file, ...opts }, ctx());
    return {
      code,
      file,
      text: out.text(),
      bp: existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as GenomeBlueprint) : null,
    };
  } finally {
    out.restore();
  }
}

const leaf = (name: string): AlgebraExpr => ({
  Gene: { geneRef: { geneId: fakeV2(name), role: name, optional: false } },
});

describe("#29-a Blueprint structure", () => {
  beforeEach(() => {
    writeGene(root, "alpha", {
      fidelity: "Native",
      domain: "text.clean",
      manifest: { cloud_id: "11111111-2222-3333-4444-555555555555", owner: "alice", version: "1.2.0" },
    });
    writeGene(root, "beta", {
      fidelity: "Hybrid",
      domain: "text.summarize",
      manifest: { owner: "bob", version: "0.3.0" },
    });
    writeAgent(root, "pipeline", ["alpha", "beta"], { type: "Seq" });
  });

  it("writes a GenomeSnapshot with only §25.1 fields and v2 gene IDs", () => {
    const { code, bp } = exportAgent("pipeline");
    expect(code).toBe(0);
    expect(bp).not.toBeNull();
    for (const key of Object.keys(bp!.snapshot)) {
      expect(["genes", "composition", "dataFlow", "snapshotAt"]).toContain(key);
    }
    expect(bp!.snapshot.genes).toHaveLength(2);
    for (const g of bp!.snapshot.genes) {
      expect(g.geneId).toMatch(/^v2:[0-9a-f]{64}$/);
      expect(g.optional).toBe(false);
    }
    expect(bp!.snapshot.genes.map((g) => g.role)).toEqual(["alpha", "beta"]);
    expect(bp!.blueprintFormat).toBe(1);
    expect(bp!.protocolVersion).toMatchObject({ major: 0, minor: 9, patch: 2 });
    expect(bp!.protocolVersion.supportedFeatures).toContain("GENE_COMPOSITION_ALGEBRA");
    expect(bp!.metadata.name).toBe("pipeline");
    expect(bp!.metadata.createdAt).toBe(bp!.snapshot.snapshotAt);
  });

  it("writes resolutionHints with owner/name/version/fidelity, and cloudId when known", () => {
    const { bp } = exportAgent("pipeline");
    expect(bp!.resolutionHints!.alpha).toEqual({
      owner: "alice",
      name: "alpha",
      version: "1.2.0",
      cloudId: "11111111-2222-3333-4444-555555555555",
      fidelity: "Native",
    });
    expect(bp!.resolutionHints!.beta).toEqual({ owner: "bob", name: "beta", version: "0.3.0", fidelity: "Hybrid" });
  });

  it("writes a CapabilityQuery per role from phenotype.json, minFitness defaulting to τ = 0.3", () => {
    const { bp } = exportAgent("pipeline");
    expect(DEFAULT_MIN_FITNESS).toBe(0.3);
    expect(Object.keys(bp!.capabilities!.alpha).sort()).toEqual(
      ["domain", "inputSchemaCompat", "minFitness", "outputSchemaCompat"],
    );
    expect(bp!.capabilities!.alpha).toMatchObject({
      domain: "text.clean",
      inputSchemaCompat: { type: "object", properties: { text: { type: "string" } } },
      outputSchemaCompat: { type: "object", properties: { result: { type: "string" } } },
      minFitness: 0.3,
    });
    expect(bp!.capabilities!.beta.domain).toBe("text.summarize");
  });

  it("--min-fitness overrides τ; --min-vg goes to bindingExtensions as the author's suggestion", () => {
    const { bp } = exportAgent("pipeline", { minFitness: "0.6", minVg: "0.8" });
    expect(bp!.capabilities!.alpha.minFitness).toBe(0.6);
    expect(bp!.bindingExtensions!["rotifer-playground"]).toEqual({ minVg: 0.8 });
  });

  it("--min-vg below 0.5 is refused (§5.1)", () => {
    const { code, bp, text } = exportAgent("pipeline", { minVg: "0.4" });
    expect(code).toBe(1);
    expect(bp).toBeNull();
    expect(text).toContain("--min-vg must be in [0.5, 1.0)");
  });

  it("--min-fitness outside [0, 1] or not a number is refused", () => {
    expect(exportAgent("pipeline", { minFitness: "1.5" }).code).toBe(1);
    expect(exportAgent("pipeline", { minFitness: "abc" }).text).toContain("--min-fitness must be a number");
  });

  it("--lock writes no capabilities", () => {
    const { code, bp } = exportAgent("pipeline", { lock: true });
    expect(code).toBe(0);
    expect(bp!.capabilities).toBeUndefined();
    expect(bp!.snapshot.genes).toHaveLength(2);
  });

  it("--description and the logged-in author land in metadata", () => {
    const out = captureOutput();
    const file = join(root, "meta.rgenome");
    try {
      runGenomeExport("pipeline", { output: file, description: "Cleans then summarizes" }, { ...ctx(), author: "carol" });
    } finally {
      out.restore();
    }
    const bp = JSON.parse(readFileSync(file, "utf-8")) as GenomeBlueprint;
    expect(bp.metadata).toMatchObject({ name: "pipeline", description: "Cleans then summarizes", author: "carol" });
  });

  it("finds the agent by id as well as by name", () => {
    const agent = writeAgent(root, "by-id", ["alpha"], { type: "Single" });
    expect(exportAgent(agent.id).code).toBe(0);
  });

  it("a local-only gene gets no hints and the export says the receiver can only substitute it", () => {
    writeGene(root, "local-only");
    writeAgent(root, "mixed", ["alpha", "local-only"], { type: "Seq" });
    const { code, bp, text } = exportAgent("mixed");
    expect(code).toBe(0);
    expect(bp!.resolutionHints!["local-only"]).toBeUndefined();
    expect(bp!.resolutionHints!.alpha).toBeDefined();
    expect(text).toContain("'local-only' was never published or installed from the Registry");
  });

  it("a Wrapped gene is exported, with a notice that it cannot be installed from the Registry", () => {
    writeGene(root, "wrapped-one", { fidelity: "Wrapped", manifest: { owner: "dan", version: "1.0.0" } });
    writeAgent(root, "with-wrapped", ["wrapped-one"], { type: "Single" });
    const { code, bp, text } = exportAgent("with-wrapped");
    expect(code).toBe(0);
    expect(bp!.resolutionHints!["wrapped-one"].fidelity).toBe("Wrapped");
    expect(text).toContain("'wrapped-one' is Wrapped");
  });

  it("a gene without a v2 ID fails the export with the reason and the command to run", () => {
    vi.mocked(geneIdV2).mockImplementation((_r, name) =>
      name === "beta" ? { reason: "gene.ir.wasm does not exist" } : { id: fakeV2(name) },
    );
    const { code, bp, text } = exportAgent("pipeline");
    expect(code).toBe(1);
    expect(bp).toBeNull();
    expect(text).toContain("Gene 'beta' has no v2 gene ID: gene.ir.wasm does not exist");
    expect(text).toContain("rotifer compile beta");
  });

  it("a gene missing from genes/ fails the export", () => {
    writeAgent(root, "ghost", ["nowhere"], { type: "Single" });
    const { code, text } = exportAgent("ghost");
    expect(code).toBe(1);
    expect(text).toContain("Gene 'nowhere' has no readable phenotype.json");
  });

  it("an unknown agent fails with exit code 1", () => {
    const { code, text } = exportAgent("no-such-agent");
    expect(code).toBe(1);
    expect(text).toContain("Agent 'no-such-agent' not found");
  });

  it("two agents with the same name must be told apart by id", () => {
    writeAgent(root, "pipeline", ["alpha"], { type: "Single" });
    const { code, text } = exportAgent("pipeline");
    expect(code).toBe(1);
    expect(text).toContain("2 agents are named 'pipeline'");
  });
});

describe("#29-b compositions inside the executable subset", () => {
  beforeEach(() => {
    for (const g of ["a", "b", "c"]) writeGene(root, g, { manifest: { owner: "o", version: "1.0.0" } });
  });

  it("Single → Gene(geneRef)", () => {
    writeAgent(root, "single", ["a"], { type: "Single" });
    const { code, bp } = exportAgent("single");
    expect(code).toBe(0);
    expect(bp!.snapshot.composition).toEqual(leaf("a"));
  });

  it("a one-gene agent with no composition is Single, as agent run treats it", () => {
    writeAgent(root, "implicit", ["a"], {});
    expect(exportAgent("implicit").bp!.snapshot.composition).toEqual(leaf("a"));
  });

  it("Seq → Seq(steps) in genome order", () => {
    writeAgent(root, "seq", ["a", "b", "c"], { type: "Seq" });
    const { bp } = exportAgent("seq");
    expect(bp!.snapshot.composition).toEqual({ Seq: { steps: [leaf("a"), leaf("b"), leaf("c")] } });
  });

  it("Par → right-nested Par(left, right) without deadline; merge goes to bindingExtensions", () => {
    writeAgent(root, "par", ["a", "b", "c"], { type: "Par", branches: ["a", "b", "c"], merge: "concat" });
    const { bp } = exportAgent("par");
    expect(bp!.snapshot.composition).toEqual({
      Par: { left: leaf("a"), right: { Par: { left: leaf("b"), right: leaf("c") } } },
    });
    expect(JSON.stringify(bp!.snapshot.composition)).not.toContain("deadline");
    expect(bp!.bindingExtensions!["rotifer-playground"].parMerge).toBe("concat");
  });

  it("Par without a merge strategy records agent run's default, 'first'", () => {
    writeAgent(root, "par-default", ["a", "b"], { type: "Par" });
    expect(exportAgent("par-default").bp!.bindingExtensions!["rotifer-playground"].parMerge).toBe("first");
  });

  it("Cond with agent create's default predicate → EQ on type == primary", () => {
    writeAgent(root, "cond", ["a", "b"], {
      type: "Cond",
      predicate: { field: "type", equals: "primary" },
      thenBranch: "a",
      elseBranch: "b",
    });
    const { bp } = exportAgent("cond");
    expect(bp!.snapshot.composition).toEqual({
      Cond: { predicate: { field: "type", operator: "EQ", value: "primary" }, ifTrue: leaf("a"), ifFalse: leaf("b") },
    });
  });

  it("Cond maps each executor CompareOp to the §15.2 name and prefers value over equals", () => {
    // buildBlueprint maps all eight; MATCHES is then refused before writing (T-21b, below).
    const pairs: Array<[string, string]> = [
      ["Eq", "EQ"], ["Neq", "NEQ"], ["Gt", "GT"], ["Gte", "GTE"],
      ["Lt", "LT"], ["Lte", "LTE"], ["Contains", "CONTAINS"], ["Matches", "MATCHES"],
    ];
    for (const [op, expected] of pairs) {
      const agent = writeAgent(root, `cond-${op}`, ["a", "b"], { type: "Cond", predicate: { field: "score", op, value: "10", equals: 99 } });
      const { blueprint: bp } = buildBlueprint({ root, genesDir: "genes", agent });
      expect((bp.snapshot.composition as { Cond: { predicate: unknown } }).Cond.predicate).toEqual({
        field: "score",
        operator: expected,
        value: "10",
      });
    }
  });

  it("Cond with every operator agent run executes is written to the file", () => {
    for (const [op, value] of [["Eq", 10], ["Neq", 10], ["Gt", 10], ["Gte", 10], ["Lt", 10], ["Lte", 10], ["Contains", "en"]] as const) {
      writeAgent(root, `cond-file-${op}`, ["a", "b"], { type: "Cond", predicate: { field: "score", op, value } });
      const { code, bp } = exportAgent(`cond-file-${op}`);
      expect(code, op).toBe(0);
      expect((bp!.snapshot.composition as { Cond: { predicate: { value: unknown } } }).Cond.predicate.value).toBe(value);
    }
  });

  it("Try → TryCatch(body, handler)", () => {
    writeAgent(root, "try", ["a", "b"], { type: "Try", primary: "a", fallback: "b" });
    expect(exportAgent("try").bp!.snapshot.composition).toEqual({ TryCatch: { body: leaf("a"), handler: leaf("b") } });
  });
});

describe("#29-b compositions outside the executable subset fail", () => {
  beforeEach(() => {
    for (const g of ["a", "b", "c"]) writeGene(root, g);
  });

  const cases: Array<[string, string[], Record<string, unknown>, string]> = [
    ["TryPool", ["a", "b"], { type: "TryPool" }, "Composition 'TryPool' cannot be exported"],
    ["unknown operator", ["a", "b"], { type: "Loop" }, "Composition 'Loop' cannot be exported"],
    ["Cond with 3 genes", ["a", "b", "c"], { type: "Cond" }, "needs exactly 2 genes, the genome has 3"],
    ["Try with 3 genes", ["a", "b", "c"], { type: "Try" }, "needs exactly 2 genes, the genome has 3"],
    ["Try with 1 gene", ["a"], { type: "Try" }, "needs exactly 2 genes, the genome has 1"],
    ["Par with 1 gene", ["a"], { type: "Par" }, "needs at least 2 genes, the genome has 1"],
    ["Single with 2 genes", ["a", "b"], { type: "Single" }, "needs exactly 1 gene, the genome has 2"],
    ["Cond with an unknown predicate op", ["a", "b"], { type: "Cond", predicate: { field: "x", op: "Between" } }, "unknown predicate operator 'Between'"],
    ["a gene listed twice", ["a", "a"], { type: "Seq" }, "Gene 'a' appears more than once"],
  ];

  for (const [label, genome, composition, message] of cases) {
    it(`${label} → exit 1, nothing written`, () => {
      writeAgent(root, "bad", genome, composition);
      const { code, bp, text } = exportAgent("bad");
      expect(code).toBe(1);
      expect(bp).toBeNull();
      expect(text).toContain(message);
    });
  }

  it("buildBlueprint throws for an empty genome", () => {
    const agent = writeAgent(root, "empty", [], { type: "Seq" });
    expect(() => buildBlueprint({ root, genesDir: "genes", agent })).toThrow("has an empty genome");
  });
});

describe("T-21b: export refuses what its own import would refuse, before writing", () => {
  beforeEach(() => {
    for (const g of ["a", "b"]) writeGene(root, g, { manifest: { owner: "o", version: "1.0.0" } });
  });

  const condCases: Array<[string, Record<string, unknown>, string]> = [
    ["MATCHES", { field: "kind", op: "Matches", value: "^a" }, "MATCHES is not executed"],
    ["CONTAINS with a number", { field: "kind", op: "Contains", value: 5 }, "CONTAINS needs a string value"],
    ["a field path with '.'", { field: "a.b", op: "Eq", value: 1 }, "top-level field name"],
    ["a field with '[' ']'", { field: "items[0]", op: "Eq", value: 1 }, "top-level field name"],
    ["an integer beyond 2^53", { field: "n", op: "Eq", value: 2 ** 53 + 2 }, "integer outside the exactly representable range"],
  ];
  for (const [label, predicate, message] of condCases) {
    it(`Cond ${label} → exit 1, nothing written`, () => {
      writeAgent(root, "bad", ["a", "b"], { type: "Cond", predicate });
      const { code, bp, text } = exportAgent("bad");
      expect(code).toBe(1);
      expect(bp).toBeNull();
      expect(text).toContain("would not import");
      expect(text).toContain(message);
    });
  }

  it("a phenotype schema with a lone surrogate or an unsafe integer → exit 1, nothing written", () => {
    writeGene(root, "c", { inputSchema: { type: "object", properties: { t: { type: "string", title: "bad \ud800" } } } });
    writeGene(root, "d", { outputSchema: { type: "object", properties: { n: { type: "integer", maximum: 1e20 } } } });
    for (const [gene, message] of [["c", "unpaired surrogate"], ["d", "integer outside the exactly representable range"]]) {
      writeAgent(root, `bad-${gene}`, [gene], { type: "Single" });
      const { code, bp, text } = exportAgent(`bad-${gene}`);
      expect(code, gene).toBe(1);
      expect(bp).toBeNull();
      expect(text).toContain(message);
    }
  });

  it("an unknown Par merge strategy → exit 1, nothing written", () => {
    writeAgent(root, "bad-par", ["a", "b"], { type: "Par", merge: "zip" });
    const { code, bp, text } = exportAgent("bad-par");
    expect(code).toBe(1);
    expect(bp).toBeNull();
    expect(text).toContain("is not first, concat or merge");
  });
});

describe("T-25: export refuses an operator named after an Object.prototype member (N1)", () => {
  beforeEach(() => {
    for (const g of ["a", "b"]) writeGene(root, g, { manifest: { owner: "o", version: "1.0.0" } });
  });

  for (const op of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
    it(`op '${op}' → exit 1, nothing written`, () => {
      writeAgent(root, `bad-${op}`, ["a", "b"], { type: "Cond", predicate: { field: "kind", op, value: "x" } });
      const { code, bp, text } = exportAgent(`bad-${op}`);
      expect(code).toBe(1);
      expect(bp).toBeNull();
      expect(text).toContain(`unknown predicate operator '${op}'`);
    });
  }
});
