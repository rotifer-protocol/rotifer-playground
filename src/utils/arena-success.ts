import Ajv, { type ValidateFunction } from "ajv";

/**
 * What counts as a successful run when measuring S_r for the Arena.
 *
 * "Success" used to mean the sandbox came back clean: exit code 0 and output
 * that parsed as JSON. That let a Gene whose `express()` returned an empty
 * object — a whole class of published artifacts did, silently — score S_r = 1
 * and top the leaderboard, because `{}` is valid JSON. It is not a valid
 * output for a Gene whose phenotype declares seven required fields.
 *
 * The phenotype's `outputSchema` is the contract the Gene itself published.
 * A run succeeds when the sandbox succeeded *and* the output honours that
 * contract — the same "produces legal output" the publishing gate (spec
 * §47.5 T1) already demands, and what `rotifer test` has checked as Test 7 all
 * along. `arena submit` just never did.
 *
 * A Gene with no outputSchema (or an empty one) constrains nothing, so any
 * sandbox success still counts; the contract is the Gene's to declare.
 */

export type OutputValidator = (output: unknown) => boolean;

/** null when the value conforms; otherwise the first violation, naming the field. */
export type SchemaCheck = (value: unknown) => string | null;

/**
 * Compile one of a phenotype's schemas into a check. Returns null when the
 * schema is absent, empty, or not compilable — the schema constrains nothing,
 * and the caller says so if it matters. The Arena's verdict
 * (compileOutputValidator) and `rotifer run`'s (#451) both come from here, so
 * they cannot disagree about what violates a Gene's contract.
 */
export function compileSchemaCheck(schema: unknown): SchemaCheck | null {
  if (!schema || typeof schema !== "object" || Object.keys(schema as object).length === 0) return null;
  let validate: ValidateFunction;
  try {
    validate = new Ajv({ allErrors: false, strict: false }).compile(schema as object);
  } catch {
    return null;
  }
  return (value: unknown) => {
    if (validate(value) === true) return null;
    const err = validate.errors?.[0];
    if (!err) return "does not match the schema";
    const path = err.instancePath.replace(/^\//, "").replace(/\//g, ".");
    if (err.keyword === "required") {
      const missing = (err.params as { missingProperty?: string }).missingProperty;
      return `${path ? path + "." : ""}${missing} is required`;
    }
    if (err.keyword === "additionalProperties") {
      const extra = (err.params as { additionalProperty?: string }).additionalProperty;
      return `${path ? path + "." : ""}${extra} is not allowed`;
    }
    return `${path || "(the value)"} ${err.message ?? "does not match the schema"}`;
  };
}

/**
 * Compile a phenotype's outputSchema into a validator. Returns null when the
 * schema is absent, empty, or not compilable — in which case the caller falls
 * back to sandbox success alone, and should say so.
 */
export function compileOutputValidator(phenotype: { outputSchema?: unknown }): OutputValidator | null {
  const check = compileSchemaCheck(phenotype.outputSchema);
  return check ? (output: unknown) => check(output) === null : null;
}

export interface RunOutcome {
  /** The sandbox's own verdict: exit 0, output parsed. */
  sandboxSuccess: boolean;
  output: unknown;
}

/** Sandbox success alone is not success; the output has to be what was promised. */
export function isRunSuccessful(run: RunOutcome, validateOutput: OutputValidator | null): boolean {
  if (!run.sandboxSuccess) return false;
  if (!validateOutput) return true;
  return validateOutput(run.output);
}
