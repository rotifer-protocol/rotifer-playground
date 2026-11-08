/**
 * The published template genes refuse input their own inputSchema forbids
 * (ADR-334), and only that input.
 *
 * Illegal inputs are derived from each phenotype, so a field added to a schema
 * without a matching check in the gene fails here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { readErrorEnvelope } from "../../src/testsuite/gate.js";

interface Schema {
  type?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
}

const GENES = [
  "uiux-analyzer",
  "uiux-reporter",
  "content-quality-analyzer",
  "content-optimizer",
  "solidity-parser",
  "vuln-detector",
  "audit-reporter",
];

const genesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "genes");
const readJson = (gene: string, file: string) => JSON.parse(readFileSync(join(genesDir, gene, file), "utf-8"));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function illegalValue(schema: Schema): unknown {
  if (schema.enum) return "not-an-allowed-value";
  return schema.type === "string" ? 42 : "not-the-declared-type";
}

/** Every input one schema violation away from a legal one, with the field it breaks. */
function illegalInputs(legal: Record<string, any>, schema: Schema): Array<{ field: string; input: unknown }> {
  const cases: Array<{ field: string; input: unknown }> = [];
  for (const field of schema.required ?? []) {
    const input = clone(legal);
    delete input[field];
    cases.push({ field, input });
  }
  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    const input = clone(legal);
    input[field] = illegalValue(property);
    cases.push({ field, input });

    for (const [inner, innerProperty] of Object.entries(property.properties ?? {})) {
      const nested = clone(legal);
      nested[field] = { ...nested[field], [inner]: illegalValue(innerProperty) };
      cases.push({ field: `${field}.${inner}`, input: nested });
    }
    for (const [inner, innerProperty] of Object.entries(property.items?.properties ?? {})) {
      const nested = clone(legal);
      nested[field] = [{ [inner]: illegalValue(innerProperty) }];
      cases.push({ field: `${field}[0].${inner}`, input: nested });
    }
  }
  return cases;
}

describe.each(GENES)("%s", (gene) => {
  const schema: Schema = readJson(gene, "phenotype.json").inputSchema;
  const legal = readJson(gene, "testsuite.json").testCases[0].input;
  const express = async (input: unknown) => {
    const mod = await import(pathToFileURL(join(genesDir, gene, "index.ts")).href);
    return mod.express(input);
  };

  it("answers the legal input in its test suite", async () => {
    expect(readErrorEnvelope(await express(legal))).toBeNull();
  });

  for (const { field, input } of illegalInputs(legal, schema)) {
    it(`refuses, and names the field, when '${field}' breaks the schema`, async () => {
      const output = await express(input);
      expect(Object.keys(output)).toEqual(["__rotifer_error"]);
      expect(readErrorEnvelope(output)).toContain(field);
    });
  }

  it("refuses input that is not an object", async () => {
    expect(readErrorEnvelope(await express(null))).toContain("input must be an object");
  });

  for (const [field, property] of Object.entries(schema.properties ?? {})) {
    if (property.type !== "string" || !schema.required?.includes(field)) continue;
    it(`still answers an empty '${field}', which the schema allows`, async () => {
      expect(readErrorEnvelope(await express({ ...clone(legal), [field]: "" }))).toBeNull();
    });
  }
});
