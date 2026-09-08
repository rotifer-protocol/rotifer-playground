import Ajv from "ajv";
import type { TestCase, TestSuite } from "./types.js";
import { generateTestInput } from "./generate.js";
import { DEFAULT_FUZZ_ITERATIONS } from "./run.js";

/**
 * §47.3 Phenotype-driven scaffolding, aimed at §47.5's shape.
 *
 * This exists because 2.1 turns §47.5 into a publishing gate, and a gate with
 * no exit teaches people to route around it. Being told "you need a negative
 * case" is only actionable if something can write the first one for you.
 *
 * What it cannot do is make a Gene correct. A scaffolded suite is a starting
 * point whose assertions the author still has to mean — the generated negative
 * cases in particular encode a guess about what rejection should look like, and
 * that guess is left blank on purpose (see below).
 */

const SCAFFOLD_SEED = 1;

interface ScaffoldNote {
  /** Which §47.5 requirement this case is there to satisfy. */
  requirement: "positive" | "negative";
  /** Why this input is legal or illegal, for the comment block. */
  rationale: string;
}

export interface ScaffoldResult {
  suite: TestSuite;
  notes: ScaffoldNote[];
  /** Cases the generator meant to be illegal but could not make illegal —
   * see makeIllegalInputs. Empty is the normal case. */
  warnings: string[];
}

/**
 * Build inputs that the Gene's own inputSchema rejects.
 *
 * Each strategy targets a different way a caller gets it wrong, because a
 * negative case that only ever tests one of them proves little:
 *
 *   - a required field missing entirely
 *   - a field present with the wrong type
 *   - an empty object, the degenerate call
 *
 * Every candidate is then run through the validator before being kept. A
 * "negative" case whose input the schema happens to accept is silently a
 * positive case — classify() would file it as one, the suite would look like it
 * covers §47.5 while covering half of it, and nothing would say so.
 */
function makeIllegalInputs(
  inputSchema: Record<string, unknown> | null,
  isIllegal: (v: unknown) => boolean,
): { inputs: { value: unknown; rationale: string }[]; warnings: string[] } {
  const inputs: { value: unknown; rationale: string }[] = [];
  const warnings: string[] = [];
  const candidates: { value: unknown; rationale: string }[] = [];

  const properties = (inputSchema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = (inputSchema?.required ?? []) as string[];
  const legal = generateTestInput(inputSchema, SCAFFOLD_SEED);

  if (required.length > 0) {
    const dropped = { ...legal };
    delete dropped[required[0]];
    candidates.push({
      value: dropped,
      rationale: `required field "${required[0]}" is missing`,
    });
  }

  const firstTyped = Object.entries(properties).find(([, p]) => typeof p.type === "string");
  if (firstTyped) {
    const [key, prop] = firstTyped;
    // A value of a type the field cannot hold. Numbers are wrong for
    // everything except number/integer, where a string is wrong instead.
    const wrong = prop.type === "number" || prop.type === "integer" ? "not-a-number" : 42;
    candidates.push({
      value: { ...legal, [key]: wrong },
      rationale: `"${key}" is declared ${String(prop.type)} but given ${JSON.stringify(wrong)}`,
    });
  }

  candidates.push({ value: {}, rationale: "empty object — the degenerate call" });

  for (const c of candidates) {
    if (isIllegal(c.value)) {
      inputs.push(c);
    } else {
      warnings.push(
        `dropped a would-be negative case (${c.rationale}): the Gene's inputSchema accepts it, ` +
          `so it would have been classified as a positive case`,
      );
    }
  }
  return { inputs, warnings };
}

export function scaffoldTestSuite(phenotype: {
  inputSchema?: unknown;
  outputSchema?: unknown;
}): ScaffoldResult {
  const inputSchema = (phenotype.inputSchema as Record<string, unknown>) ?? null;
  const outputSchema = (phenotype.outputSchema as Record<string, unknown>) ?? null;

  const ajv = new Ajv({ allErrors: true, strict: false });
  let isIllegal: (v: unknown) => boolean = () => false;
  if (inputSchema) {
    try {
      const validate = ajv.compile(inputSchema);
      isIllegal = (v) => !validate(v);
    } catch {
      isIllegal = () => false;
    }
  }

  const testCases: TestCase[] = [];
  const notes: ScaffoldNote[] = [];

  // Positive case. It asserts against outputSchema rather than a literal
  // expectedOutput: a generated literal would be whatever the Gene happens to
  // return today, which is an assertion that the Gene never changes, not that
  // it is right.
  const legal = generateTestInput(inputSchema, SCAFFOLD_SEED);
  testCases.push({
    input: legal,
    ...(outputSchema ? { expectedSchema: outputSchema } : {}),
  });
  notes.push({
    requirement: "positive",
    rationale: outputSchema
      ? "generated from inputSchema; asserts the output conforms to outputSchema"
      : "generated from inputSchema; the Gene declares no outputSchema, so replace this with an expectedOutput you mean",
  });

  const { inputs: illegal, warnings } = makeIllegalInputs(inputSchema, isIllegal);
  for (const c of illegal) {
    // No expectedOutput / expectedSchema on purpose. If the Gene answers
    // illegal input rather than refusing it — json-validator returning
    // { valid: false } is the honest version of this — the author has to say
    // what that answer should be. Guessing here would hand out a case that
    // passes on whatever the Gene already does, which is not a test.
    testCases.push({ input: c.value });
    notes.push({ requirement: "negative", rationale: c.rationale });
  }

  return {
    suite: {
      testCases,
      config: { fuzzIterations: DEFAULT_FUZZ_ITERATIONS, seed: SCAFFOLD_SEED },
    },
    notes,
    warnings,
  };
}
