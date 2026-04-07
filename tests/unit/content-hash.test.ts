import { describe, it, expect } from "vitest";
import { contentHash, canonicalSerialize } from "../../src/utils/content-hash.js";

describe("contentHash", () => {
  it("produces consistent hash regardless of key order", () => {
    const a = { domain: "search", fidelity: "Wrapped", version: "0.1.0" };
    const b = { version: "0.1.0", domain: "search", fidelity: "Wrapped" };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("handles nested objects with different key orders", () => {
    const a = { inputSchema: { type: "object", properties: { q: { type: "string" } } }, domain: "search" };
    const b = { domain: "search", inputSchema: { properties: { q: { type: "string" } }, type: "object" } };
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("returns a 64-character hex string (sha256)", () => {
    const hash = contentHash({ domain: "test" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different phenotypes produce different hashes", () => {
    const a = contentHash({ domain: "search", version: "0.1.0" });
    const b = contentHash({ domain: "nlp", version: "0.1.0" });
    expect(a).not.toBe(b);
  });
});

describe("canonicalSerialize", () => {
  it("sorts keys alphabetically at all levels", () => {
    const input = { z: 1, a: { c: 3, b: 2 } };
    const result = canonicalSerialize(input);
    expect(result).toBe('{"a":{"b":2,"c":3},"z":1}');
  });

  it("preserves array order (arrays are not sorted)", () => {
    const input = { items: [3, 1, 2] };
    const result = canonicalSerialize(input);
    expect(result).toBe('{"items":[3,1,2]}');
  });

  it("handles null values", () => {
    const result = canonicalSerialize({ a: null, b: 1 });
    expect(result).toBe('{"a":null,"b":1}');
  });
});
