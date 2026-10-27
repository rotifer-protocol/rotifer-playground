import { describe, it, expect } from "vitest";
import { outcomeFromSandbox } from "../../src/testsuite/gate.js";
import { runT1 } from "../../src/testsuite/run.js";

/**
 * ADR-334: a Gene refuses input with the single-key `__rotifer_error` envelope,
 * the sandbox turns it into GeneResult::Error{ INVALID_INPUT }, and the napi
 * binding reports it as `INVALID_INPUT: <message>`. ADR-334 counts that as a
 * non-crash refusal — a negative case passes.
 *
 * The Node path already read it that way (readErrorEnvelope). The sandbox
 * adapter shared by `rotifer test` and `rotifer publish` called every failure a
 * crash, so a compiled Gene that refused correctly failed its negative case and
 * could not satisfy §47.5 T1 (found publishing tavily-web-search, T-98).
 */
describe("outcomeFromSandbox", () => {
  it("reads an INVALID_INPUT refusal as a refusal, not a crash", () => {
    const o = outcomeFromSandbox({ success: false, errorMessage: "INVALID_INPUT: query is required: a non-empty string" });
    expect(o.success).toBe(false);
    expect(o.crashed).toBeFalsy();
    expect(o.errorMessage).toBe("INVALID_INPUT: query is required: a non-empty string");
  });

  it("still reads anything else as a crash", () => {
    for (const errorMessage of [
      "execution failed: wasm trap: unreachable",
      "execution failed: gene returned error code: -5",
      "L0 gate blocked: …",
      "missing credential: the environment variable X is not set.",
      "invalid input: INVALID_INPUT: is not at the start",
    ]) {
      expect(outcomeFromSandbox({ success: false, errorMessage }).crashed, errorMessage).toBe(true);
    }
    expect(outcomeFromSandbox({ success: false }).crashed).toBe(true);
  });

  it("passes success through", () => {
    expect(outcomeFromSandbox({ success: true, output: { ok: 1 }, durationMs: 3 })).toEqual({
      success: true,
      output: { ok: 1 },
      durationMs: 3,
    });
  });

  it("lets a compiled Gene that refuses illegal input satisfy the negative requirement", () => {
    const schema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    // Stands in for the sandbox: refuses a missing query, answers otherwise.
    const sandbox = (input: unknown) => {
      const q = (input as { query?: unknown }).query;
      return typeof q === "string"
        ? { success: true, output: { echo: q } }
        : { success: false, errorMessage: "INVALID_INPUT: query is required" };
    };
    const report = runT1(
      {
        testCases: [
          { input: { query: "x" }, expectedSchema: { type: "object", required: ["echo"] } },
          { input: {} },
        ],
      },
      {
        inputSchema: schema,
        outputSchema: { type: "object" },
        run: (input) => outcomeFromSandbox(sandbox(input)),
      },
    );
    expect(report.requirements.negative).toBe(true);
  });
});
