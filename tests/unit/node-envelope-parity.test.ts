import { describe, it, expect } from "vitest";
import { readErrorEnvelope } from "../../src/testsuite/gate.js";

/**
 * ADR-334's refusal envelope is recognised in two places that share no code:
 * `parse_error_envelope` in the Rust core (for compiled Genes) and
 * `readErrorEnvelope` here (for the Node path used by Wrapped and uncompiled
 * Genes).
 *
 * They must agree, because which path a Gene takes depends on its fidelity
 * rather than on its code. A Gene that refuses would otherwise be read as
 * refusing when compiled and as answering when run under Node — the same source
 * producing two different verdicts.
 *
 * This was not hypothetical. The Rust side was implemented first, the probe
 * Gene had no compiled artifact so it ran under Node, and the gate reported
 * "returned output for illegal input" against a Gene that had plainly refused.
 * The cases below are the Rust tests' cases, restated.
 */
describe("the Node path recognises the envelope exactly as the Rust core does", () => {
  it("reads a lone __rotifer_error as a refusal, carrying the message", () => {
    expect(readErrorEnvelope({ __rotifer_error: { message: "text must be a string" } }))
      .toBe("INVALID_INPUT: text must be a string");
  });

  it("refuses without a message rather than falling through to success", () => {
    expect(readErrorEnvelope({ __rotifer_error: {} })).toMatch(/^INVALID_INPUT: /);
  });

  it("does not read refusal out of output that merely contains the key", () => {
    // The single-key rule. Without it a stray field would silently turn a
    // result into an error.
    expect(readErrorEnvelope({ __rotifer_error: { message: "x" }, score: 1 })).toBeNull();
  });

  it("leaves the shapes Genes actually return alone", () => {
    for (const shape of [{ score: 1 }, {}, [1, 2, 3], "a string", null, 42]) {
      expect(readErrorEnvelope(shape), `misread ${JSON.stringify(shape)}`).toBeNull();
    }
  });
});
