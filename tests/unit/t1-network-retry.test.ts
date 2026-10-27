import { describe, it, expect } from "vitest";
import { runT1 } from "../../src/testsuite/run.js";
import type { RunOutcome } from "../../src/testsuite/run.js";
import { generateTestInput } from "../../src/testsuite/generate.js";

/**
 * §47.5 T1's property test feeds 10 generated inputs and needs schema-legal
 * output from each. For a Hybrid gene one of those runs can fail on the
 * network alone: publishing tavily-web-search was blocked by a single -5 at
 * iteration 7 that 20 later runs never reproduced (T-98). A failed request
 * produced no output, so it says nothing about schema legality either way.
 *
 * So: a Hybrid gene's iteration that fails only with a host network code
 * (-4 timeout, -5 network, -7 host request limit) is run once more, with the
 * same input; failing again fails the property. Anything else, and every
 * non-Hybrid gene, is never retried. A retry is always reported.
 */

const inputSchema = {
  type: "object",
  properties: { query: { type: "string", minLength: 1 } },
  required: ["query"],
};
const outputSchema = { type: "object", required: ["results"] };
const suite = {
  testCases: [
    { input: { query: "x" }, expectedSchema: { type: "object", required: ["results"] } },
    { input: {} },
  ],
};

const net = (code: number, cause = "TLS error (api.example.com)") =>
  `execution failed: gene returned error code: ${code} (last network failure: ${cause})`;

/** The input the property test feeds at 1-based iteration `n` (seed 1). */
const iterationInput = (n: number) => JSON.stringify(generateTestInput(inputSchema, 1 + n - 1));

/**
 * A runner that refuses illegal input, answers legal input, and fails the
 * property input of iteration `at` with the queued messages first.
 */
function runner(at: number, failures: string[]) {
  const calls = new Map<string, number>();
  const queue = [...failures];
  const run = (input: unknown): RunOutcome => {
    const key = JSON.stringify(input);
    calls.set(key, (calls.get(key) ?? 0) + 1);
    if (typeof (input as { query?: unknown }).query !== "string") {
      return { success: false, errorMessage: "INVALID_INPUT: query is required" };
    }
    if (key === iterationInput(at) && queue.length > 0) {
      return { success: false, crashed: true, errorMessage: queue.shift()! };
    }
    return { success: true, output: { results: [] } };
  };
  return { run, callsAt: (n: number) => calls.get(iterationInput(n)) ?? 0 };
}

const property = (fidelity: string, run: (input: unknown) => RunOutcome) => {
  const report = runT1(suite, { inputSchema, outputSchema, run, fidelity });
  return { report, result: report.results.find((r) => r.testId === "t1-property-schema-legality")! };
};

describe("T1 property test: one retry for a Hybrid gene's network failure", () => {
  it("passes when the retry succeeds, and says which iteration was retried and why", () => {
    const r = runner(7, [net(-5)]);
    const { report, result } = property("Hybrid", r.run);
    expect(result.passed, result.failureReason).toBe(true);
    expect(report.gatePassed).toBe(true);
    expect(r.callsAt(7)).toBe(2);
    expect(result.details).toContain("iteration 7 was retried once after -5");
    expect(result.details).toContain("TLS error (api.example.com)");
  });

  it("retries -4 and -7 the same way", () => {
    for (const code of [-4, -7]) {
      const r = runner(3, [`execution failed: gene returned error code: ${code}`]);
      const { result } = property("Hybrid", r.run);
      expect(result.passed, `${code}: ${result.failureReason}`).toBe(true);
      expect(result.details).toContain(`iteration 3 was retried once after ${code}`);
    }
  });

  it("fails when the retry fails too, and reports both attempts", () => {
    const r = runner(7, [net(-5), net(-5, "connection failed (api.example.com)")]);
    const { report, result } = property("Hybrid", r.run);
    expect(result.passed).toBe(false);
    expect(report.gatePassed).toBe(false);
    expect(r.callsAt(7)).toBe(2);
    expect(result.failureReason).toContain("iteration 7/10 did not produce output after one retry");
    expect(result.failureReason).toContain("TLS error (api.example.com)");
    expect(result.failureReason).toContain("connection failed (api.example.com)");
  });

  it("does not retry a failure that is not a host network code", () => {
    for (const message of [
      "execution failed: gene returned error code: -3",
      "execution failed: gene returned error code: -50",
      "execution failed: gene returned error code: -201",
      "execution failed: wasm trap: unreachable",
    ]) {
      const r = runner(2, [message]);
      const { result } = property("Hybrid", r.run);
      expect(result.passed, message).toBe(false);
      expect(r.callsAt(2), message).toBe(1);
      expect(result.failureReason).not.toContain("retry");
    }
  });

  it("does not retry a gene that is not Hybrid", () => {
    for (const fidelity of ["Native", "Wrapped"]) {
      const r = runner(7, [net(-5)]);
      const { result } = property(fidelity, r.run);
      expect(result.passed, fidelity).toBe(false);
      expect(r.callsAt(7), fidelity).toBe(1);
    }
  });

  it("reports nothing about retries when none happened", () => {
    const r = runner(7, []);
    const { result } = property("Hybrid", r.run);
    expect(result.passed).toBe(true);
    expect(result.details).not.toContain("retried");
  });
});
