import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import { scaffoldTestSuite } from "../../src/testsuite/scaffold.js";
import { classify } from "../../src/testsuite/run.js";
import { parseTestSuite } from "../../src/testsuite/load.js";

/**
 * §47.3 scaffolding, aimed at §47.5's shape.
 *
 * 2.1 turns §47.5 into a publishing gate, and a gate with no exit teaches
 * people to route around it. "You need a negative case" is only actionable if
 * something can write the first one.
 *
 * The property that matters most here is not that it emits cases — it is that
 * the cases it labels negative are ones the Gene's own inputSchema actually
 * rejects. A "negative" case whose input the schema happens to accept is
 * silently a positive case: classify() files it as one, the suite looks like it
 * covers §47.5 while covering half of it, and nothing says so.
 */

const INPUT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" }, strict: { type: "boolean" } },
  required: ["text"],
};
const OUTPUT_SCHEMA = {
  type: "object",
  properties: { score: { type: "number" } },
  required: ["score"],
};

function classifyScaffold(phenotype: { inputSchema?: unknown; outputSchema?: unknown }) {
  const { suite, warnings } = scaffoldTestSuite(phenotype);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validator = phenotype.inputSchema
    ? ajv.compile(phenotype.inputSchema as object)
    : null;
  return { suite, warnings, classified: classify(suite.testCases, validator) };
}

describe("scaffold produces a suite of the shape §47.5 requires", () => {
  it("emits at least one positive and at least one negative case", () => {
    const { classified } = classifyScaffold({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA });
    expect(classified.filter((c) => c.kind === "positive").length).toBeGreaterThanOrEqual(1);
    expect(classified.filter((c) => c.kind === "negative").length).toBeGreaterThanOrEqual(1);
  });

  it("every case it means as negative is one the inputSchema really rejects", () => {
    // The whole point. Without this, the generator can hand out cases that
    // quietly count toward the wrong half of the gate.
    const { suite, classified } = classifyScaffold({
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
    });
    // case 0 is the positive one; everything after it was generated as illegal
    const generatedAsNegative = classified.slice(1);
    expect(generatedAsNegative.length).toBeGreaterThan(0);
    expect(generatedAsNegative.every((c) => c.kind === "negative")).toBe(true);
    expect(suite.testCases.length).toBe(classified.length);
  });

  it("covers distinct ways of being illegal, not the same one repeatedly", () => {
    const { suite } = scaffoldTestSuite({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA });
    const negatives = suite.testCases.slice(1).map((c) => JSON.stringify(c.input));
    expect(new Set(negatives).size).toBe(negatives.length);
  });

  it("asserts the positive case against outputSchema, not a captured literal", () => {
    // A generated expectedOutput would be whatever the Gene returns today —
    // an assertion that it never changes, not that it is right.
    const { suite } = scaffoldTestSuite({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA });
    expect(suite.testCases[0].expectedSchema).toEqual(OUTPUT_SCHEMA);
    expect("expectedOutput" in suite.testCases[0]).toBe(false);
  });

  it("leaves negative cases undeclared so the author must decide what handling means", () => {
    const { suite } = scaffoldTestSuite({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA });
    for (const c of suite.testCases.slice(1)) {
      expect("expectedOutput" in c).toBe(false);
      expect(c.expectedSchema).toBeUndefined();
    }
  });

  it("sets the §47.5 property-test parameters, with a seed so runs are replayable", () => {
    const { suite } = scaffoldTestSuite({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA });
    expect(suite.config?.fuzzIterations).toBe(10);
    expect(typeof suite.config?.seed).toBe("number");
  });

  it("emits a suite the loader accepts", () => {
    // Round trip: a scaffold the format layer would reject is worse than none.
    const { suite } = scaffoldTestSuite({ inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA });
    expect(parseTestSuite(JSON.stringify(suite), "t.json").status).toBe("ok");
  });
});

describe("scaffold reports what it could not do", () => {
  it("drops and warns about a would-be negative the schema accepts", () => {
    // A permissive schema — nothing is illegal, so no honest negative case can
    // be generated. Saying so beats emitting cases that silently classify as
    // positive.
    const { warnings, classified } = classifyScaffold({
      inputSchema: { type: "object" },
      outputSchema: OUTPUT_SCHEMA,
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.join(" ")).toMatch(/would have been classified as a positive case/);
    expect(classified.every((c) => c.kind === "positive")).toBe(true);
  });

  it("warns when the generated positive input is not one the Gene accepts", () => {
    // Measured on json-validator: the generator could not satisfy its `data`
    // and `schema` fields, so classify() filed the "positive" case as negative
    // and the suite shipped with no positive case at all. Verifying negatives
    // but not the positive was an asymmetry, and it failed in the direction
    // that is harder to notice — the gate reports "positive NOT met" without
    // saying the scaffold is why.
    const STRICT = {
      type: "object",
      properties: { data: { type: "object" }, schema: { type: "object" } },
      required: ["data", "schema"],
    };
    const { warnings, classified } = classifyScaffold({
      inputSchema: STRICT,
      outputSchema: OUTPUT_SCHEMA,
    });
    const { notes } = scaffoldTestSuite({ inputSchema: STRICT, outputSchema: OUTPUT_SCHEMA });
    expect(classified[0].kind).toBe("negative");
    expect(warnings.join(" ")).toMatch(/no positive case/);
    expect(warnings.join(" ")).toMatch(/testCases\[0\]\.input/);
    expect(notes[0].rationale).toMatch(/NOT ACCEPTED/);
  });

  it("stays quiet about the positive case when the generator did satisfy the schema", () => {
    // Control: the warning must not fire on the ordinary path, or it becomes
    // noise every author learns to skip.
    const { warnings, classified } = classifyScaffold({
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
    });
    expect(classified[0].kind).toBe("positive");
    expect(warnings.join(" ")).not.toMatch(/no positive case/);
  });

  it("tells the author to supply an expectedOutput when the Gene declares no outputSchema", () => {
    const { notes, suite } = scaffoldTestSuite({ inputSchema: INPUT_SCHEMA });
    expect(suite.testCases[0].expectedSchema).toBeUndefined();
    expect(notes[0].rationale).toMatch(/expectedOutput you mean/);
  });
});
