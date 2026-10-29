/**
 * The L0 gate reads a phenotype as `wrap` writes it (#448).
 *
 * evaluateL0 handed phenotype.json to rotifer-core unconverted. wrap's ISO
 * createdAt failed Phenotype deserialization, so the gate came back
 * "unavailable" for every wrapped gene — and an unavailable gate lets a local
 * gene run unchecked (with a warning). It has to come back with a verdict.
 */
import { describe, expect, it } from "vitest";
import { evaluateL0 } from "../../src/utils/l0-gate.js";
import { tryLoadBinding } from "../../src/utils/binding.js";

const binding = tryLoadBinding();

const WRAPPED = {
  domain: "test.greeting",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
  outputSchema: { type: "object", properties: { greeting: { type: "string" } } },
  version: "0.1.0",
  fidelity: "Wrapped",
  transparency: "Open",
  author: "test",
  createdAt: "2026-10-29T16:05:14.575Z",
};

describe("evaluateL0 on a phenotype wrap wrote", () => {
  it.skipIf(binding === null)("reaches a verdict instead of 'unavailable'", () => {
    const outcome = evaluateL0(binding, WRAPPED);
    expect(outcome).toEqual({ kind: "pass" });
  });

  it.skipIf(binding === null)("and still refuses what L0 refuses", () => {
    const outcome = evaluateL0(binding, { ...WRAPPED, domain: "" });
    expect(outcome.kind).not.toBe("unavailable");
  });
});
