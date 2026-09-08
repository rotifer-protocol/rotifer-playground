import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { randomUUID } from "node:crypto";
import type {
  ClassifiedCase,
  TestCase,
  TestResult,
  TestSuite,
} from "./types.js";
import { generateTestInput } from "./generate.js";

/** §47.5 fixes the publishing gate's property test at 10 random inputs. */
export const DEFAULT_FUZZ_ITERATIONS = 10;

/**
 * What running one input against the Gene produced. The runner is injected
 * rather than imported so this module stays free of the native binding: the
 * caller already owns a compiled Gene and a fuel policy, and the T1 rules are
 * about interpreting outcomes, not about producing them.
 */
export interface RunOutcome {
  /** The Gene ran to completion and returned an output. */
  success: boolean;
  output?: unknown;
  /** Present when success is false. A *controlled* rejection also lands here. */
  errorMessage?: string;
  /** True when the Gene did not reject but died — trap, fuel exhaustion,
   * timeout. §47.5's negative case is about handling illegal input
   * "correctly", and dying is not handling it. */
  crashed?: boolean;
  durationMs?: number;
}

export type GeneRunner = (input: unknown, timeoutMs?: number) => RunOutcome;

/**
 * Classify a case as positive or negative from the input alone.
 *
 * spec §4.2's TestCase has no field saying which it is, and §47.5 words the
 * negative case as "gene can correctly handle illegal input" — legality being
 * decided by the Gene's own inputSchema. So the classification is derived:
 * an input the schema accepts is a positive case, one it rejects is negative.
 *
 * The consequence worth stating: a positive case whose input is accidentally
 * malformed silently becomes a negative case. That is why the reason string
 * carries the validator's complaint — an author who meant it to be positive
 * sees exactly which field disqualified it.
 */
export function classify(
  testCases: TestCase[],
  inputValidator: ValidateFunction | null,
): ClassifiedCase[] {
  return testCases.map((testCase, index) => {
    if (!inputValidator) {
      // No inputSchema to judge against. Everything is a positive case, and
      // the §47.5 gate will report the missing negative rather than inventing
      // one — see requirementsMet().
      return {
        index,
        kind: "positive" as const,
        testCase,
        reason: "gene declares no inputSchema, so no input can be illegal",
      };
    }
    const isLegalInput = inputValidator(testCase.input);
    if (isLegalInput) {
      return { index, kind: "positive" as const, testCase, reason: "input conforms to inputSchema" };
    }
    const complaint = (inputValidator.errors ?? [])
      .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
      .join("; ");
    return {
      index,
      kind: "negative" as const,
      testCase,
      reason: `input violates inputSchema — ${complaint || "no detail"}`,
    };
  });
}

function fail(testId: string, started: number, reason: string, details?: string): TestResult {
  return {
    testId,
    level: "T1",
    passed: false,
    duration: Date.now() - started,
    failureReason: reason,
    ...(details ? { details } : {}),
  };
}

function pass(testId: string, started: number, details: string): TestResult {
  return { testId, level: "T1", passed: true, duration: Date.now() - started, details };
}

/**
 * A positive case passes when the Gene runs and its output satisfies whatever
 * the case asserts: `expectedOutput` exactly, `expectedSchema` structurally,
 * or — when the case asserts neither — the Gene's declared outputSchema.
 *
 * The fallback matters. Without it a case carrying only an input would pass on
 * any output at all, including one that violates the Gene's own contract, and
 * the suite would look populated while asserting nothing.
 */
export function runPositive(
  c: ClassifiedCase,
  run: GeneRunner,
  outputValidator: ValidateFunction | null,
  ajv: Ajv,
): TestResult {
  const started = Date.now();
  const id = `t1-positive-${c.index}`;
  const outcome = run(c.testCase.input, c.testCase.timeout);

  if (!outcome.success) {
    return fail(id, started, `Gene rejected a legal input: ${outcome.errorMessage ?? "no message"}`, c.reason);
  }

  if ("expectedOutput" in c.testCase) {
    const got = JSON.stringify(outcome.output);
    const want = JSON.stringify(c.testCase.expectedOutput);
    if (got !== want) {
      return fail(id, started, "output does not equal expectedOutput", `expected ${want}, got ${got}`);
    }
    return pass(id, started, "output matches expectedOutput exactly");
  }

  if (c.testCase.expectedSchema) {
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(c.testCase.expectedSchema);
    } catch (e) {
      return fail(id, started, `expectedSchema is not a valid JSON Schema: ${(e as Error).message}`);
    }
    if (!validate(outcome.output)) {
      return fail(id, started, "output does not conform to expectedSchema", JSON.stringify(validate.errors));
    }
    return pass(id, started, "output conforms to expectedSchema");
  }

  if (outputValidator) {
    if (!outputValidator(outcome.output)) {
      return fail(id, started, "output does not conform to the Gene's outputSchema", JSON.stringify(outputValidator.errors));
    }
    return pass(id, started, "output conforms to the Gene's outputSchema");
  }

  return fail(
    id,
    started,
    "case asserts nothing: no expectedOutput, no expectedSchema, and the Gene declares no outputSchema",
  );
}

/**
 * A negative case: the Gene is fed input its own inputSchema forbids.
 *
 * §47.5 asks that the Gene "correctly handle illegal input" without saying
 * what handling looks like, and measuring four real Genes shows why it cannot
 * be decided from the outcome alone:
 *
 *   grammar-checker   throws     — `not a function`, a TypeError from inside
 *   source-linker     returns    — echoes the illegal value straight back
 *   url-extractor     returns    — an empty result
 *   json-validator    returns    — `{ valid: false }`, which IS correct handling
 *
 * "Returned output" therefore cannot mean acceptance: for json-validator it is
 * the right answer, and for source-linker it is the bug. The difference is not
 * in the outcome, it is in what the author intended — so the author has to say,
 * using the fields spec §4.2 already provides.
 *
 * The rules, in order:
 *
 *   1. Crashed — fail. Dying is not handling, whatever was intended.
 *   2. Errored without crashing — pass. The Gene refused, deliberately.
 *   3. Returned, and the case declares expectedOutput/expectedSchema that
 *      matches — pass. This is the author saying "rejection looks like this".
 *   4. Returned, and the declaration does not match — fail.
 *   5. Returned, and the case declares nothing — fail, and say why. Silent
 *      acceptance and correct handling are indistinguishable here; refusing to
 *      guess is the whole point, since guessing "pass" is what lets a
 *      source-linker through.
 */
export function runNegative(
  c: ClassifiedCase,
  run: GeneRunner,
  ajv: Ajv,
): TestResult {
  const started = Date.now();
  const id = `t1-negative-${c.index}`;
  const outcome = run(c.testCase.input, c.testCase.timeout);

  if (outcome.crashed) {
    // ADR-333: a crash fails not because it is necessarily a bug, but because
    // it is necessarily unusable. A trap reaching the caller carries no
    // information — the caller cannot tell deliberate refusal from defect, so
    // nothing downstream can act on it correctly. §47.5 asks for "correctly
    // handle", and a signal the caller cannot handle is not handling completed.
    return fail(
      id,
      started,
      `Gene crashed on illegal input instead of handling it: ${outcome.errorMessage ?? "no message"}`,
      c.reason,
    );
  }

  if (!outcome.success) {
    return pass(id, started, `Gene refused illegal input: ${outcome.errorMessage ?? "no message"}`);
  }

  if ("expectedOutput" in c.testCase) {
    const got = JSON.stringify(outcome.output);
    const want = JSON.stringify(c.testCase.expectedOutput);
    return got === want
      ? pass(id, started, "Gene handled illegal input exactly as the case declares")
      : fail(id, started, "output does not equal the declared expectedOutput", `expected ${want}, got ${got}`);
  }

  if (c.testCase.expectedSchema) {
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(c.testCase.expectedSchema);
    } catch (e) {
      return fail(id, started, `expectedSchema is not a valid JSON Schema: ${(e as Error).message}`);
    }
    return validate(outcome.output)
      ? pass(id, started, "Gene handled illegal input in the declared shape")
      : fail(id, started, "output does not conform to the declared expectedSchema", JSON.stringify(validate.errors));
  }

  return fail(
    id,
    started,
    "Gene returned output for illegal input and the case declares no expected shape",
    `${c.reason}; output was ${JSON.stringify(outcome.output).slice(0, 200)}. ` +
      `If returning this is correct handling, declare it with expectedOutput or expectedSchema; ` +
      `otherwise the Gene is silently accepting input its own schema forbids.`,
  );
}

/**
 * §47.4 Schema Legality, run as §47.5's third T1 requirement: generated inputs
 * must always produce output conforming to outputSchema.
 *
 * The seed is what makes a failure actionable — the same seed replays the same
 * inputs, so a property failure can be reproduced rather than merely observed.
 * When the suite gives no seed one is derived from nothing but a constant, so
 * two runs of an unseeded suite still agree; randomness across runs would make
 * the gate flaky and the flake would be blamed on the Gene.
 */
export function runProperty(
  suite: TestSuite,
  inputSchema: Record<string, unknown> | null,
  run: GeneRunner,
  outputValidator: ValidateFunction | null,
): TestResult {
  const started = Date.now();
  const id = "t1-property-schema-legality";
  const iterations = suite.config?.fuzzIterations ?? DEFAULT_FUZZ_ITERATIONS;
  const seed = suite.config?.seed ?? 1;

  if (iterations === 0) {
    return fail(id, started, "config.fuzzIterations is 0 — the property test asserts nothing");
  }
  if (!outputValidator) {
    return fail(id, started, "Gene declares no outputSchema, so schema legality cannot be asserted");
  }

  for (let i = 0; i < iterations; i++) {
    const input = generateTestInput(inputSchema, seed + i);
    const outcome = run(input);
    if (!outcome.success) {
      return fail(
        id,
        started,
        `iteration ${i + 1}/${iterations} did not produce output: ${outcome.errorMessage ?? "no message"}`,
        `reproduce with seed ${seed}, input ${JSON.stringify(input).slice(0, 200)}`,
      );
    }
    if (!outputValidator(outcome.output)) {
      return fail(
        id,
        started,
        `iteration ${i + 1}/${iterations} produced output violating outputSchema`,
        `reproduce with seed ${seed}, input ${JSON.stringify(input).slice(0, 200)}`,
      );
    }
  }
  return pass(id, started, `${iterations} generated inputs all produced schema-legal output (seed ${seed})`);
}

export interface T1Report {
  results: TestResult[];
  classified: ClassifiedCase[];
  /** The three §47.5 T1 requirements, each satisfied or not. */
  requirements: {
    positive: boolean;
    negative: boolean;
    property: boolean;
  };
  /** True only when all three hold. This is what stage 2's publish gate reads. */
  gatePassed: boolean;
}

export function runT1(
  suite: TestSuite,
  opts: {
    inputSchema: Record<string, unknown> | null;
    outputSchema: Record<string, unknown> | null;
    run: GeneRunner;
  },
): T1Report {
  const ajv = new Ajv({ allErrors: true, strict: false });
  let inputValidator: ValidateFunction | null = null;
  let outputValidator: ValidateFunction | null = null;
  try {
    if (opts.inputSchema) inputValidator = ajv.compile(opts.inputSchema);
  } catch {
    inputValidator = null;
  }
  try {
    if (opts.outputSchema) outputValidator = ajv.compile(opts.outputSchema);
  } catch {
    outputValidator = null;
  }

  const classified = classify(suite.testCases, inputValidator);
  const results: TestResult[] = [];

  for (const c of classified) {
    results.push(
      c.kind === "positive"
        ? runPositive(c, opts.run, outputValidator, ajv)
        : runNegative(c, opts.run, ajv),
    );
  }

  const property = runProperty(suite, opts.inputSchema, opts.run, outputValidator);
  results.push(property);

  const hasPassingPositive = classified.some(
    (c, i) => c.kind === "positive" && results[i].passed,
  );
  const hasPassingNegative = classified.some(
    (c, i) => c.kind === "negative" && results[i].passed,
  );

  const requirements = {
    positive: hasPassingPositive,
    negative: hasPassingNegative,
    property: property.passed,
  };

  return {
    results,
    classified,
    requirements,
    gatePassed: requirements.positive && requirements.negative && requirements.property,
  };
}

/** Stable id for a report, for callers that persist results. */
export function newTestRunId(): string {
  return randomUUID();
}
