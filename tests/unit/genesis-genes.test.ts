import { describe, it, expect } from "vitest";

import { express as webSearch } from "../../genes/genesis-web-search/index.js";
import { express as webSearchLite } from "../../genes/genesis-web-search-lite/index.js";
import { express as fileRead } from "../../genes/genesis-file-read/index.js";
import { express as codeFormat } from "../../genes/genesis-code-format/index.js";
import { express as l0Constraint } from "../../genes/genesis-l0-constraint/index.js";

describe("Genesis Gene: web-search", () => {
  it("returns expected number of results", async () => {
    const result = await webSearch({ query: "rotifer protocol", maxResults: 3 });
    expect(result.results).toHaveLength(3);
    expect(result.totalResults).toBe(3);
    expect(result.searchTime).toBeGreaterThanOrEqual(0);
  });

  it("defaults to 5 results", async () => {
    const result = await webSearch({ query: "test" });
    expect(result.results).toHaveLength(5);
  });

  it("includes query in result titles", async () => {
    const result = await webSearch({ query: "hello" });
    expect(result.results[0].title).toContain("hello");
  });
});

describe("Genesis Gene: web-search-lite", () => {
  it("returns a single answer", async () => {
    const result = await webSearchLite({ query: "what is rotifer" });
    expect(result.answer).toBeTruthy();
    expect(result.source).toContain("example.com");
  });
});

describe("Genesis Gene: file-read", () => {
  it("reads a real file", async () => {
    const result = await fileRead({ path: import.meta.filename });
    expect(result.content).toContain("Genesis Gene");
    expect(result.size).toBeGreaterThan(0);
    expect(result.encoding).toBe("utf-8");
  });

  it("supports base64 encoding", async () => {
    const result = await fileRead({ path: import.meta.filename, encoding: "base64" });
    expect(result.encoding).toBe("base64");
    const decoded = Buffer.from(result.content, "base64").toString("utf-8");
    expect(decoded).toContain("Genesis Gene");
  });
});

describe("Genesis Gene: code-format", () => {
  it("formats JSON", async () => {
    const result = await codeFormat({
      code: '{"a":1,"b":2}',
      language: "json",
    });
    expect(result.formatted).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(result.changed).toBe(true);
  });

  it("normalizes whitespace in TypeScript", async () => {
    const result = await codeFormat({
      code: "const x = 1;\t\nconst y = 2;   \n\n\n\nconst z = 3;",
      language: "typescript",
    });
    expect(result.formatted).not.toContain("\t");
    expect(result.changed).toBe(true);
  });

  it("reports unchanged when already formatted", async () => {
    const result = await codeFormat({ code: "const x = 1;", language: "typescript" });
    expect(result.changed).toBe(false);
  });
});

describe("Genesis Gene: l0-constraint", () => {
  it("passes for valid gene ID", async () => {
    const validId = "a".repeat(64);
    const result = await l0Constraint({ geneId: validId });
    expect(result.compliant).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("fails for invalid gene ID", async () => {
    const result = await l0Constraint({ geneId: "bad-id" });
    expect(result.compliant).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("detects excessive memory limit", async () => {
    const result = await l0Constraint({
      geneId: "a".repeat(64),
      constraints: { maxMemoryBytes: 512 * 1024 * 1024 },
    });
    expect(result.compliant).toBe(false);
    expect(result.violations.some((v) => v.includes("Memory limit"))).toBe(true);
  });

  it("returns default constraints", async () => {
    const result = await l0Constraint({ geneId: "a".repeat(64) });
    expect(result.constraintSet.maxMemoryBytes).toBe(16 * 1024 * 1024);
    expect(result.constraintSet.maxFuel).toBe(1_000_000);
    expect(result.constraintSet.deniedHostFunctions).toContain("fs.write");
  });
});
