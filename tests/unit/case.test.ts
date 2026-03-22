import { describe, it, expect } from "vitest";
import { toCamelCase } from "../../src/utils/case.js";

describe("toCamelCase", () => {
  it("converts snake_case keys to camelCase", () => {
    expect(toCamelCase({ input_schema: "x", output_schema: "y" })).toEqual({
      inputSchema: "x",
      outputSchema: "y",
    });
  });

  it("handles already camelCase keys (no-op)", () => {
    expect(toCamelCase({ inputSchema: "x" })).toEqual({ inputSchema: "x" });
  });

  it("handles nested objects recursively", () => {
    const input = {
      semantic_requirements: {
        time_model: "Async",
        cost_model: "FreeTier",
      },
    };
    expect(toCamelCase(input)).toEqual({
      semanticRequirements: {
        timeModel: "Async",
        costModel: "FreeTier",
      },
    });
  });

  it("handles arrays of objects", () => {
    const input = [{ gene_id: "a" }, { gene_id: "b" }];
    expect(toCamelCase(input)).toEqual([{ geneId: "a" }, { geneId: "b" }]);
  });

  it("handles arrays of primitives unchanged", () => {
    expect(toCamelCase([1, "two", true])).toEqual([1, "two", true]);
  });

  it("handles null", () => {
    expect(toCamelCase(null)).toBeNull();
  });

  it("handles undefined", () => {
    expect(toCamelCase(undefined)).toBeUndefined();
  });

  it("handles primitive values unchanged", () => {
    expect(toCamelCase("hello")).toBe("hello");
    expect(toCamelCase(42)).toBe(42);
    expect(toCamelCase(true)).toBe(true);
  });

  it("handles empty object", () => {
    expect(toCamelCase({})).toEqual({});
  });

  it("handles deeply nested mixed structure", () => {
    const input = {
      streaming_capability: null,
      semantic_requirements: {
        failure_semantics: "Retry",
        nested_array: [{ deep_key: 1 }],
      },
    };
    expect(toCamelCase(input)).toEqual({
      streamingCapability: null,
      semanticRequirements: {
        failureSemantics: "Retry",
        nestedArray: [{ deepKey: 1 }],
      },
    });
  });

  it("handles multi-underscore keys", () => {
    expect(toCamelCase({ max_memory_pages: 256 })).toEqual({
      maxMemoryPages: 256,
    });
  });

  it("preserves underscores before uppercase letters", () => {
    // regex `_([a-z])` only converts lowercase followers
    expect(toCamelCase({ Already_Good: "v" })).toEqual({ Already_Good: "v" });
    expect(toCamelCase({ all_lower: "v" })).toEqual({ allLower: "v" });
  });
});
