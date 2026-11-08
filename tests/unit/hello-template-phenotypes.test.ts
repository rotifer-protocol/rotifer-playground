/**
 * A template gene's phenotype has to be one the sandbox can read.
 *
 * phenotype.json is parsed by rotifer-core only when a gene runs from WASM, so
 * a field of the wrong shape passes `compile` and fails the first real run. Two
 * reporter genes declared `dependencies` as gene names where the type is
 * Vec<GeneId>; they went unnoticed while they ran under Node, and would have
 * been published, immutably, as genes that can never run.
 *
 * The module below is deliberately empty: the phenotype is parsed first, so the
 * sandbox only reaches this module if it could read the phenotype.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "../../src/commands/hello.js";
import { tryLoadBinding } from "../../src/utils/binding.js";

const binding = tryLoadBinding();
const genesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "genes");
const EMPTY_WASM_MODULE = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

const templateGenes = [...new Set(TEMPLATES.flatMap((t) => t.genes))];

function sandboxError(gene: string): string {
  const phenotype = readFileSync(join(genesDir, gene, "phenotype.json"), "utf-8");
  try {
    binding!.executeGene(EMPTY_WASM_MODULE, "{}", JSON.stringify(JSON.parse(phenotype)));
    return "";
  } catch (err) {
    return (err as Error).message;
  }
}

describe("template genes have phenotypes the sandbox can read", () => {
  // A checkout without the native addon cannot ask. CI builds it, and there a
  // missing addon has to fail here rather than skip every case below.
  const cannotAsk = binding === null && !process.env.CI;

  it("covers the genes of every template", () => {
    expect(templateGenes.length).toBeGreaterThanOrEqual(TEMPLATES.length);
  });

  for (const gene of templateGenes) {
    it.skipIf(cannotAsk)(gene, () => {
      expect(sandboxError(gene)).not.toMatch(/invalid phenotype JSON/);
    });
  }
});
