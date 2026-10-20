import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { canonicalSerialize, contentHash } from "../../src/utils/content-hash.js";

/**
 * Fixed vectors for content hash v1 (docs/content-hash-v1.md). The algorithm
 * is frozen: stored content_hash values depend on it, including its two
 * quirks (integer-like keys first in numeric order; a `__proto__` key
 * dropped). Any change to src/utils/content-hash.ts that changes a value here
 * changes the hash of real stored phenotypes, and must not land.
 */

interface Vector {
  name: string;
  phenotype: Record<string, unknown>;
  canonical: string;
  hash: string;
}

const VECTORS: Vector[] = [
  {
    name: "nested object: keys sorted at every level",
    phenotype: { domain: "search", inputSchema: { type: "object", properties: { q: { type: "string" } } }, version: "0.1.0" },
    canonical: '{"domain":"search","inputSchema":{"properties":{"q":{"type":"string"}},"type":"object"},"version":"0.1.0"}',
    hash: "cff03e8e7acc8a315aad4e7b75999f4f6221c70b47229746c841de7de0b15dac",
  },
  {
    name: "integer-like object keys: first, in numeric order (not lexicographic)",
    phenotype: { b: 1, "10": "ten", "2": "two", a: 0 },
    canonical: '{"2":"two","10":"ten","a":0,"b":1}',
    hash: "d19d5a233fdcba9edb48df766223621769218377fd724b18fc3458d504c9e875",
  },
  {
    name: "__proto__ key: dropped",
    phenotype: JSON.parse('{"domain":"x","__proto__":{"polluted":true},"version":"1"}'),
    canonical: '{"domain":"x","version":"1"}',
    hash: "a605c4fcc40ed8f2321113c841aa06f39c703255022124d54e83ca95b7f7f642",
  },
  {
    name: "array: order kept, objects inside sorted",
    phenotype: { tags: ["z", "a", { y: 1, x: 2 }], domain: "d" },
    canonical: '{"domain":"d","tags":["z","a",{"x":2,"y":1}]}',
    hash: "f419a457a37ff4eed1845face256077b7d527397ac53686f36e7cf29471cffad",
  },
  {
    name: "non-ASCII string: written as is, hashed as UTF-8",
    phenotype: { description: "语法检查 — café ✓", domain: "content.grammar" },
    canonical: '{"description":"语法检查 — café ✓","domain":"content.grammar"}',
    hash: "e00c5575f6b4786bdf872e66dcbdeff97dbabab52515c44588792f909f658350",
  },
];

describe("content hash v1 fixed vectors", () => {
  for (const v of VECTORS) {
    it(v.name, () => {
      expect(canonicalSerialize(v.phenotype)).toBe(v.canonical);
      expect(contentHash(v.phenotype)).toBe(v.hash);
    });
  }

  it("each pinned hash is SHA-256 over the UTF-8 bytes of its canonical string", () => {
    for (const v of VECTORS) {
      expect(createHash("sha256").update(Buffer.from(v.canonical, "utf-8")).digest("hex")).toBe(v.hash);
    }
  });

  it("adding a __proto__ key does not change the hash", () => {
    const base = { domain: "x", version: "1" };
    const withProto = JSON.parse('{"domain":"x","__proto__":{"anything":1},"version":"1"}');
    expect(contentHash(withProto)).toBe(contentHash(base));
  });
});
