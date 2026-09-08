import { describe, it, expect } from "vitest";
import { parseTestSuite } from "../../src/testsuite/load.js";
import { runT1, classify, DEFAULT_FUZZ_ITERATIONS } from "../../src/testsuite/run.js";
import type { RunOutcome, GeneRunner } from "../../src/testsuite/run.js";
import type { TestSuite } from "../../src/testsuite/types.js";
import Ajv from "ajv";

/**
 * spec §47.5 makes T1 a MUST for DRAFT→PUBLISHED: at least one positive case,
 * at least one negative case, and a schema-legality property test over 10
 * generated inputs. None of it existed in the CLI — `rotifer test` covered
 * §47.3 scaffolding only — which is how 62 Native genes reached the registry
 * and why the two republished on 2026-09-07 went out without satisfying a MUST.
 *
 * The cases below are grouped by the thing that can go wrong, and each is
 * written so that deleting the rule it covers turns exactly it red.
 */

const INPUT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
const OUTPUT_SCHEMA = {
  type: "object",
  properties: { score: { type: "number" } },
  required: ["score"],
};

/** A well-behaved Gene: answers legal input, rejects anything else. */
const wellBehaved: GeneRunner = (input) => {
  const ok =
    typeof input === "object" && input !== null &&
    typeof (input as Record<string, unknown>).text === "string" &&
    Object.keys(input as object).every((k) => k === "text");
  return ok
    ? { success: true, output: { score: 1 } }
    : { success: false, errorMessage: "input does not conform to inputSchema" };
};

function suiteOf(cases: TestSuite["testCases"], config?: TestSuite["config"]): TestSuite {
  return { testCases: cases, ...(config ? { config } : {}) };
}

const LEGAL = { text: "hello" };
const ILLEGAL = { text: 42 };

describe("TestSuite file format (spec §4.2)", () => {
  it("rejects an unknown field instead of ignoring it", () => {
    // A typo'd assertion field that gets dropped produces a case which asserts
    // nothing and still reports as passing — the failure this plan exists to close.
    const r = parseTestSuite(
      JSON.stringify({ testCases: [{ input: LEGAL, expectedOutputs: { score: 1 } }] }),
      "t.json",
    );
    expect(r.status).toBe("invalid");
    expect((r as { errors: string[] }).errors.join(" ")).toMatch(/expectedOutputs.*unknown field/);
  });

  it("names the offending field and index, not just 'invalid'", () => {
    const r = parseTestSuite(
      JSON.stringify({ testCases: [{ input: LEGAL }, { input: LEGAL, timeout: "soon" }] }),
      "t.json",
    );
    expect((r as { errors: string[] }).errors[0]).toMatch(/testCases\[1\]\.timeout/);
  });

  it("rejects an empty testCases array", () => {
    const r = parseTestSuite(JSON.stringify({ testCases: [] }), "t.json");
    expect(r.status).toBe("invalid");
    expect((r as { errors: string[] }).errors.join(" ")).toMatch(/asserts nothing/);
  });

  it("accepts a suite using exactly the spec's fields", () => {
    const r = parseTestSuite(
      JSON.stringify({
        testCases: [{ input: LEGAL, expectedOutput: { score: 1 }, timeout: 500 }],
        config: { fuzzIterations: 10, seed: 7 },
      }),
      "t.json",
    );
    expect(r.status).toBe("ok");
  });
});

describe("positive/negative classification is derived, not declared", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validator = ajv.compile(INPUT_SCHEMA);

  it("splits cases by whether the input conforms to inputSchema", () => {
    const got = classify([{ input: LEGAL }, { input: ILLEGAL }], validator);
    expect(got.map((c) => c.kind)).toEqual(["positive", "negative"]);
  });

  it("explains why a case landed in the negative bucket", () => {
    // An author who meant this to be positive needs to see which field
    // disqualified it, not merely that it was reclassified.
    const [c] = classify([{ input: ILLEGAL }], validator);
    expect(c.reason).toMatch(/violates inputSchema/);
    expect(c.reason).toMatch(/text/);
  });
});

describe("§47.5 T1 gate", () => {
  it("passes when a suite has a legal case, an illegal case, and a sound Gene", () => {
    const report = runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: wellBehaved,
    });
    expect(report.requirements).toEqual({ positive: true, negative: true, property: true });
    expect(report.gatePassed).toBe(true);
  });

  it("fails when the suite has no negative case", () => {
    const report = runT1(suiteOf([{ input: LEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: wellBehaved,
    });
    expect(report.requirements.negative).toBe(false);
    expect(report.gatePassed).toBe(false);
  });

  it("fails when the suite has no positive case", () => {
    const report = runT1(suiteOf([{ input: ILLEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: wellBehaved,
    });
    expect(report.requirements.positive).toBe(false);
    expect(report.gatePassed).toBe(false);
  });

  it("fails when the Gene returns output for illegal input and the case declares nothing", () => {
    // Measured on real Genes, "returned output" cannot mean acceptance:
    // json-validator answering { valid: false } is correct handling, while
    // source-linker echoing the illegal value back is the bug. Indistinguishable
    // from the outcome — so an undeclared case fails rather than guessing.
    const permissive: GeneRunner = () => ({ success: true, output: { score: 1 } });
    const report = runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: permissive,
    });
    expect(report.requirements.negative).toBe(false);
    expect(report.results[1].failureReason).toMatch(/declares no expected shape/);
    expect(report.results[1].details).toMatch(/silently accepting/);
  });

  it("passes when the author declares what correct handling looks like", () => {
    // The json-validator shape: illegal input is answered, not refused.
    const validatorLike: GeneRunner = (input) =>
      typeof (input as Record<string, unknown>).text === "string"
        ? { success: true, output: { score: 1 } }
        : { success: true, output: { score: 0 } };
    const report = runT1(
      suiteOf([{ input: LEGAL }, { input: ILLEGAL, expectedOutput: { score: 0 } }]),
      { inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA, run: validatorLike },
    );
    expect(report.requirements.negative).toBe(true);
    expect(report.gatePassed).toBe(true);
  });

  it("fails when the declared handling shape does not match what the Gene did", () => {
    const validatorLike: GeneRunner = () => ({ success: true, output: { score: 99 } });
    const report = runT1(
      suiteOf([{ input: LEGAL }, { input: ILLEGAL, expectedOutput: { score: 0 } }]),
      { inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA, run: validatorLike },
    );
    expect(report.requirements.negative).toBe(false);
  });

  it("passes when the Gene refuses illegal input outright", () => {
    const report = runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: wellBehaved,
    });
    expect(report.requirements.negative).toBe(true);
  });

  it("fails the negative case when the Gene crashes rather than rejects", () => {
    // Dying is not handling. Distinguished from a controlled rejection by the
    // crashed flag, so the two failure modes report differently.
    const brittle: GeneRunner = (input) =>
      (input as Record<string, unknown>).text === "hello"
        ? { success: true, output: { score: 1 } }
        : ({ success: false, crashed: true, errorMessage: "wasm trap: unreachable" } as RunOutcome);
    const report = runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: brittle,
    });
    expect(report.requirements.negative).toBe(false);
    expect(report.results[1].failureReason).toMatch(/crashed on illegal input/);
  });

  it("fails a positive case that asserts nothing at all", () => {
    // No expectedOutput, no expectedSchema, and no outputSchema to fall back
    // on: such a case passes on any output whatsoever, so it must not count.
    const report = runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: null,
      run: wellBehaved,
    });
    expect(report.requirements.positive).toBe(false);
    expect(report.results[0].failureReason).toMatch(/asserts nothing/);
  });

  it("checks a positive case against the Gene's outputSchema when it asserts neither", () => {
    const wrongShape: GeneRunner = () => ({ success: true, output: { scores: 1 } });
    const report = runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: wrongShape,
    });
    expect(report.results[0].passed).toBe(false);
    expect(report.results[0].failureReason).toMatch(/outputSchema/);
  });
});

describe("§47.4 schema-legality property test", () => {
  it("runs 10 iterations by default, as §47.5 specifies", () => {
    let calls = 0;
    const counting: GeneRunner = (input) => {
      calls++;
      return wellBehaved(input);
    };
    runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }]), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: counting,
    });
    // two declared cases plus the property iterations
    expect(calls - 2).toBe(DEFAULT_FUZZ_ITERATIONS);
  });

  it("is reproducible: the same seed feeds the same inputs", () => {
    const seen: string[][] = [];
    for (const _ of [0, 1]) {
      const inputs: string[] = [];
      runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }], { seed: 99 }), {
        inputSchema: INPUT_SCHEMA,
        outputSchema: OUTPUT_SCHEMA,
        run: (input) => {
          inputs.push(JSON.stringify(input));
          return wellBehaved(input);
        },
      });
      seen.push(inputs);
    }
    expect(seen[0]).toEqual(seen[1]);
  });

  it("reports the seed on failure so the run can be replayed", () => {
    const flaky: GeneRunner = (input) =>
      typeof (input as Record<string, unknown>).text === "string" &&
      (input as Record<string, string>).text.endsWith("3")
        ? { success: true, output: { score: "not a number" } }
        : wellBehaved(input);
    const report = runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }], { seed: 1 }), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: flaky,
    });
    expect(report.requirements.property).toBe(false);
    const prop = report.results[report.results.length - 1];
    expect(prop.details).toMatch(/reproduce with seed 1/);
  });

  it("does not count a zero-iteration property test as satisfied", () => {
    const report = runT1(suiteOf([{ input: LEGAL }, { input: ILLEGAL }], { fuzzIterations: 0 }), {
      inputSchema: INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      run: wellBehaved,
    });
    expect(report.requirements.property).toBe(false);
  });
});
