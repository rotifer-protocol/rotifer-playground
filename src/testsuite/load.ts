import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TestSuite, TestCase, TestConfig } from "./types.js";

export const TESTSUITE_FILENAME = "testsuite.json";

export interface LoadOk {
  status: "ok";
  suite: TestSuite;
  path: string;
}

/** The file is absent. Stage 1 sets no gate, so this is not an error — the
 * caller decides. §47.5's gate (stage 2) is the thing that turns it into one. */
export interface LoadAbsent {
  status: "absent";
  path: string;
}

export interface LoadInvalid {
  status: "invalid";
  path: string;
  /** Field-level, e.g. `testCases[2].timeout: expected a number, got string`. */
  errors: string[];
}

export type LoadResult = LoadOk | LoadAbsent | LoadInvalid;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validation is hand-written rather than delegated to ajv on purpose: the
 * struct is six fields, and the value of this file is the error message. A
 * schema validator would answer "does not match schema" where the author
 * needs "testCases[2].timeout: expected a number, got string".
 *
 * Unknown fields are rejected rather than ignored. A typo'd `expectedOutputs`
 * that is silently dropped means a case that never asserts anything and still
 * reports as passing — the exact failure mode this whole plan exists to close.
 */
const CASE_FIELDS = new Set([
  "input",
  "expectedOutput",
  "expectedSchema",
  "timeout",
]);
const CONFIG_FIELDS = new Set(["fuzzIterations", "seed"]);
const SUITE_FIELDS = new Set(["testCases", "config"]);

function validateCase(raw: unknown, at: string, errors: string[]): void {
  if (!isPlainObject(raw)) {
    errors.push(`${at}: expected an object, got ${Array.isArray(raw) ? "array" : typeof raw}`);
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!CASE_FIELDS.has(key)) {
      errors.push(
        `${at}.${key}: unknown field (spec §4.2 TestCase has input, expectedOutput, expectedSchema, timeout)`,
      );
    }
  }
  if (!("input" in raw)) {
    errors.push(`${at}.input: required (spec §4.2 TestCase)`);
  }
  if ("expectedSchema" in raw && !isPlainObject(raw.expectedSchema)) {
    errors.push(`${at}.expectedSchema: expected a JSON Schema object, got ${typeof raw.expectedSchema}`);
  }
  if ("timeout" in raw) {
    const t = raw.timeout;
    if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) {
      errors.push(`${at}.timeout: expected a positive number of milliseconds, got ${JSON.stringify(t)}`);
    }
  }
}

function validateConfig(raw: unknown, errors: string[]): void {
  if (!isPlainObject(raw)) {
    errors.push(`config: expected an object, got ${typeof raw}`);
    return;
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_FIELDS.has(key)) {
      errors.push(`config.${key}: unknown field (spec §4.2 TestConfig has fuzzIterations, seed)`);
    }
  }
  for (const key of ["fuzzIterations", "seed"] as const) {
    if (key in raw) {
      const v = raw[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        errors.push(`config.${key}: expected a non-negative integer, got ${JSON.stringify(v)}`);
      }
    }
  }
}

export function parseTestSuite(text: string, path: string): LoadOk | LoadInvalid {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { status: "invalid", path, errors: [`not valid JSON — ${(e as Error).message}`] };
  }

  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return {
      status: "invalid",
      path,
      errors: [`expected an object at the top level, got ${Array.isArray(raw) ? "array" : typeof raw}`],
    };
  }

  for (const key of Object.keys(raw)) {
    if (!SUITE_FIELDS.has(key)) {
      errors.push(`${key}: unknown field (spec §4.2 TestSuite has testCases, config)`);
    }
  }

  if (!Array.isArray(raw.testCases)) {
    errors.push(`testCases: required, expected an array (spec §4.2 TestSuite)`);
  } else if (raw.testCases.length === 0) {
    errors.push(`testCases: must not be empty — a suite with no cases asserts nothing`);
  } else {
    raw.testCases.forEach((c, i) => validateCase(c, `testCases[${i}]`, errors));
  }

  if ("config" in raw) validateConfig(raw.config, errors);

  if (errors.length > 0) return { status: "invalid", path, errors };

  return {
    status: "ok",
    path,
    suite: {
      testCases: raw.testCases as TestCase[],
      ...(isPlainObject(raw.config) ? { config: raw.config as TestConfig } : {}),
    },
  };
}

export function loadTestSuite(geneDir: string): LoadResult {
  const path = join(geneDir, TESTSUITE_FILENAME);
  if (!existsSync(path)) return { status: "absent", path };
  return parseTestSuite(readFileSync(path, "utf-8"), path);
}
