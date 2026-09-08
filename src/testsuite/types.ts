/**
 * TestSuite types, spec §4.2.
 *
 * The field set here is the spec's struct verbatim — no additions. That is
 * deliberate: §47.5 requires a publishing gate to count "at least 1 positive
 * case" and "at least 1 negative case", and the obvious way to support it
 * would be a `kind: "positive" | "negative"` discriminator. The spec has no
 * such field, and inventing one would put a concept in the file format that
 * the protocol does not define.
 *
 * It is not needed. §47.5 words the negative case as "gene can correctly
 * handle illegal input", and legality is already decided by the gene's own
 * `inputSchema`. So the classification is *derived* rather than declared —
 * see classify() in ./run.ts. A gene author writes test cases; whether each
 * one is positive or negative follows from the input.
 */

/** spec §4.2 TestConfig */
export interface TestConfig {
  /** Fuzz testing iteration count. §47.5 fixes the publishing gate at 10. */
  fuzzIterations?: number;
  /** Random seed, so a property run can be reproduced exactly. */
  seed?: number;
}

/** spec §4.2 TestCase */
export interface TestCase {
  /** Test input. MUST conform to inputSchema for a positive case. */
  input: unknown;
  /** Expected output, for exact matching. */
  expectedOutput?: unknown;
  /** Expected output Schema, for structural validation. */
  expectedSchema?: Record<string, unknown>;
  /** Per-case timeout, milliseconds. */
  timeout?: number;
}

/** spec §4.2 TestSuite */
export interface TestSuite {
  testCases: TestCase[];
  config?: TestConfig;
}

/** spec §47.1 test level */
export type TestLevel = "T1" | "T2" | "T3" | "T4";

/** spec §4.2 / §47.2 TestResult */
export interface TestResult {
  testId: string;
  level: TestLevel;
  passed: boolean;
  /** Milliseconds. */
  duration: number;
  details?: string;
  failureReason?: string;
  coverageHint?: number;
}

/**
 * How a case was classified, and why. Not part of the file format — this is
 * produced by the runner, and exists so `rotifer test` can report which of
 * §47.5's three T1 requirements a given case satisfied.
 */
export type CaseKind = "positive" | "negative";

export interface ClassifiedCase {
  index: number;
  kind: CaseKind;
  testCase: TestCase;
  /** Why it landed in that bucket — shown on failure so the author can tell
   * an intentionally-illegal input from an accidentally-illegal one. */
  reason: string;
}
