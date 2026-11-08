/**
 * The T1 property test feeds a gene generated inputs and requires output for
 * each. An input missing a required field is one the gene is right to refuse
 * (ADR-334), so the generator has to produce the required fields of every type.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateTestInput } from "../../src/testsuite/generate.js";

describe("generateTestInput stays reproducible for Arena S_r", () => {
  // Hashes taken from the generator as it was before required fields were
  // filled. A change here changes what Arena has been feeding existing genes.
  const PINNED = {
    properties: {
      count: { type: "integer", default: 7 },
      meta: { type: "object", properties: { a: { type: "string" } }, default: { a: "kept" } },
      prices: { type: "array", items: { type: "number" } },
      tags: { type: "array", items: { type: "string" } },
      rows: { type: "array", items: { type: "object", properties: { n: { type: "number" } } } },
      mode: { enum: ["a", "b", "c"] },
      label: { type: "string" },
      ratio: { type: "number", minimum: 5, maximum: 9 },
      on: { type: "boolean" },
    },
    required: ["count", "meta", "prices", "label"],
  };

  it.each([
    [0, "7edbdb95a58ac89941880be2fe66d9b949a3b68f0609f752be0bd1660d535d01"],
    [1, "5eff43c7d2c7d33a7650a853e26f48703b45e0559d757efe8ba6e7564c4b122f"],
    [7, "9ea519ad5fb2633ee576e55e817c22460063e65982f6705616d9c7237ecc9fb0"],
    [42, "d20ce4ce1dcea16e947a0169df3212bbe0df80a3173999ae45e59c0a10c5fcee"],
  ])("seed %i produces the same bytes as before", (seed, hash) => {
    const bytes = JSON.stringify(generateTestInput(PINNED, seed));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
  });

  it("appends filled fields after the fields the loop generated", () => {
    const input = generateTestInput(
      { properties: { n: { type: "integer" }, label: { type: "string" } }, required: ["n", "label"] },
      1,
    );
    expect(Object.keys(input)).toEqual(["label", "n"]);
  });
});

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
