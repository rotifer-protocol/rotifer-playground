import { describe, expect, it } from "vitest";
import { compileOutputValidator, isRunSuccessful } from "../../src/utils/arena-success.js";

/**
 * S_r regression: an empty `{}` from a Gene that promised seven fields used
 * to count as success because the sandbox exited 0 and `{}` parses. Every
 * published Native artifact with an `async express()` did exactly that and
 * scored S_r = 1. The Gene's own outputSchema is the contract; a run that
 * breaks it is not a success.
 */

// evolve-life's real outputSchema, trimmed to its required fields.
const EVOLVE_LIFE_SCHEMA = {
  type: "object",
  required: ["final_grid", "alive_count", "peak_population", "stabilized_at", "extinction", "generations_computed", "cells_processed"],
  properties: {
    final_grid: { type: "array" },
    alive_count: { type: "number" },
    peak_population: { type: "number" },
    stabilized_at: { type: "number" },
    extinction: { type: "boolean" },
    generations_computed: { type: "number" },
    cells_processed: { type: "number" },
  },
};

const REAL_OUTPUT = {
  final_grid: [[0, 1], [1, 0]],
  alive_count: 2,
  peak_population: 3,
  stabilized_at: -1,
  extinction: false,
  generations_computed: 100,
  cells_processed: 400,
};

describe("compileOutputValidator", () => {
  it("compiles a real outputSchema", () => {
    expect(compileOutputValidator({ outputSchema: EVOLVE_LIFE_SCHEMA })).not.toBeNull();
  });

  it("returns null when the schema is absent, empty, or not an object", () => {
    expect(compileOutputValidator({})).toBeNull();
    expect(compileOutputValidator({ outputSchema: {} })).toBeNull();
    expect(compileOutputValidator({ outputSchema: "nope" })).toBeNull();
    expect(compileOutputValidator({ outputSchema: null })).toBeNull();
  });

  it("returns null rather than throwing on an uncompilable schema", () => {
    expect(compileOutputValidator({ outputSchema: { type: "definitely-not-a-type" } })).toBeNull();
  });
});

describe("isRunSuccessful", () => {
  const validate = compileOutputValidator({ outputSchema: EVOLVE_LIFE_SCHEMA })!;

  it("the async-express artifact: sandbox ok, output {} — is NOT a success", () => {
    expect(isRunSuccessful({ sandboxSuccess: true, output: {} }, validate)).toBe(false);
  });

  it("a real result that honours the contract is a success", () => {
    expect(isRunSuccessful({ sandboxSuccess: true, output: REAL_OUTPUT }, validate)).toBe(true);
  });

  it("a partial result (missing required fields) is not a success", () => {
    const { cells_processed: _drop, ...partial } = REAL_OUTPUT;
    expect(isRunSuccessful({ sandboxSuccess: true, output: partial }, validate)).toBe(false);
  });

  it("wrong types are not a success either", () => {
    expect(isRunSuccessful({ sandboxSuccess: true, output: { ...REAL_OUTPUT, alive_count: "2" } }, validate)).toBe(false);
  });

  it("sandbox failure is failure regardless of output", () => {
    expect(isRunSuccessful({ sandboxSuccess: false, output: REAL_OUTPUT }, validate)).toBe(false);
  });

  it("with no usable schema, sandbox success is all that can be asked", () => {
    expect(isRunSuccessful({ sandboxSuccess: true, output: {} }, null)).toBe(true);
    expect(isRunSuccessful({ sandboxSuccess: false, output: {} }, null)).toBe(false);
  });
});
