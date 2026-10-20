import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { toRustPhenotype } from "../../src/utils/rust-phenotype.js";

const nameToId = (name: string) => createHash("sha256").update(name).digest("hex");
const HEX = "177efba7f402d54251c8153fce9095957abd8a1fa2a031b8b2fec7c92c5e54cb";
const bytesOf = (hex: string) => Array.from(Buffer.from(hex, "hex"));

describe("toRustPhenotype", () => {
  it("converts irHash from 64-char hex to the same 32 bytes", () => {
    const out = toRustPhenotype({ irHash: HEX }, nameToId);
    expect(out.irHash).toEqual(bytesOf(HEX));
    expect((out.irHash as number[]).length).toBe(32);
  });

  it("omits an irHash that is not 32 bytes of hex, rather than inventing one", () => {
    expect(toRustPhenotype({ irHash: "ffc83c7b" }, nameToId)).not.toHaveProperty("irHash");
    expect(toRustPhenotype({ irHash: "z".repeat(64) }, nameToId)).not.toHaveProperty("irHash");
    expect(toRustPhenotype({ irHash: null }, nameToId)).not.toHaveProperty("irHash");
  });

  it("converts an ISO createdAt to the same instant in epoch ms, and keeps epoch ms", () => {
    expect(toRustPhenotype({ createdAt: "2026-04-02T02:44:47.982Z" }, nameToId).createdAt).toBe(
      Date.UTC(2026, 3, 2, 2, 44, 47, 982),
    );
    expect(toRustPhenotype({ createdAt: 1741906800000 }, nameToId).createdAt).toBe(1741906800000);
  });

  it("omits a createdAt that is not a date or a non-negative integer", () => {
    for (const createdAt of ["not a date", -1, 1.5, {}]) {
      expect(toRustPhenotype({ createdAt }, nameToId)).not.toHaveProperty("createdAt");
    }
  });

  it("converts dependencies given by name to the gene id the entries map uses, and keeps hex ids", () => {
    const out = toRustPhenotype({ dependencies: ["content-quality-analyzer", HEX] }, nameToId);
    expect(out.dependencies).toEqual([bytesOf(nameToId("content-quality-analyzer")), bytesOf(HEX)]);
  });

  it("passes every other field through unchanged", () => {
    const phenotype = {
      domain: "content.grammar",
      version: "1.2.0",
      fidelity: "Native",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      tags: ["a"],
    };
    expect(toRustPhenotype(phenotype, nameToId)).toEqual(phenotype);
  });
});
