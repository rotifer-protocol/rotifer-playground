/**
 * The T1 property test feeds a gene generated inputs and requires output for
 * each. An input missing a required field is one the gene is right to refuse
 * (ADR-334), so the generator has to produce the required fields of every type.
 */
import { describe, expect, it } from "vitest";
import { generateTestInput } from "../../src/testsuite/generate.js";

describe("generateTestInput fills required fields", () => {
  it("fills a required object from its own properties", () => {
    const input = generateTestInput(
      {
        properties: { stats: { type: "object", properties: { name: { type: "string" }, score: { type: "number" } } } },
        required: ["stats"],
      },
      3,
    );
    expect(input).toEqual({ stats: { name: "test-3", score: 4 } });
  });

  it("recurses into a required object's own required fields", () => {
    const input = generateTestInput(
      {
        properties: {
          outer: {
            type: "object",
            properties: { inner: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } },
            required: ["inner"],
          },
        },
        required: ["outer"],
      },
      2,
    );
    expect(input).toEqual({ outer: { inner: { n: 3 } } });
  });

  it("leaves out a required object that declares no properties to fill", () => {
    expect(generateTestInput({ properties: { meta: { type: "object" } }, required: ["meta"] }, 1)).toEqual({});
  });

  it("keeps a required integer whole and inside its bounds", () => {
    const schema = {
      properties: {
        low: { type: "integer", minimum: 0.5 },
        capped: { type: "integer", minimum: 5, maximum: 6 },
        plain: { type: "integer" },
      },
      required: ["low", "capped", "plain"],
    };
    expect(generateTestInput(schema, 10)).toEqual({ low: 11, capped: 6, plain: 11 });
  });

  it("leaves optional objects and integers out, as before", () => {
    const input = generateTestInput(
      { properties: { name: { type: "string" }, meta: { type: "object", properties: {} }, n: { type: "integer" } }, required: ["name"] },
      1,
    );
    expect(input).toEqual({ name: "test-1" });
  });

  it("does not change an input that already had every required field", () => {
    const schema = {
      properties: {
        prices: { type: "array", items: { type: "number" } },
        label: { type: "string" },
        flag: { type: "boolean" },
      },
      required: ["prices", "label"],
    };
    const withoutRequired = generateTestInput({ properties: schema.properties }, 4);
    expect(JSON.stringify(generateTestInput(schema, 4))).toBe(JSON.stringify(withoutRequired));
  });

  it("does not fill the elements of an array, whose required list it is not given", () => {
    const input = generateTestInput(
      {
        properties: {
          rows: { type: "array", items: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } },
        },
        required: ["rows"],
      },
      1,
    );
    expect(input.rows[0]).toEqual({});
  });
});
