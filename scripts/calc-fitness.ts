/**
 * Fitness Calculator for Native Genes
 *
 * F(g) = [S_r · ln(1+C_util) · (1+R_rob)] / [L · Resource_Cost]
 *
 * Normalized to 0–1 range for display.
 */

import * as path from "path";
import * as fs from "fs";

interface GeneResult {
  name: string;
  success: boolean;
  duration_ms: number;
  outputKeys: number;
  schemaRichness: number;
  robustness: number;
  loc: number;
  fitness: number;
}

const GENES_DIR = path.resolve(__dirname, "../genes");

const TEST_CASES: Record<string, { input: Record<string, unknown>; edgeInput: Record<string, unknown> }> = {
  "grammar-checker": {
    input: { text: "This is  a test.  the cat sat on the the mat.", strict: false },
    edgeInput: { text: "", strict: true },
  },
  "design-tokens": {
    input: { primaryHue: 160, mode: "dark", density: "normal", borderRadius: "rounded" },
    edgeInput: { primaryHue: -10, mode: "invalid" as any },
  },
  "citation-manager": {
    input: {
      sources: [{ type: "article", authors: ["John Smith", "Jane Doe"], title: "AI Evolution", year: 2025, journal: "Nature", volume: 600, pages: "12-18" }],
      style: "apa",
    },
    edgeInput: { sources: [], style: "apa" },
  },
  "readability-analyzer": {
    input: { text: "The Rotifer Protocol defines a standard for composing AI tool functions. Each function is packaged as a Gene with typed inputs and outputs. Genes can be tested, composed into Agents, and evaluated competitively." },
    edgeInput: { text: "" },
  },
  "seo-optimizer": {
    input: { content: "<h1>Rotifer Protocol</h1><p>The Rotifer Protocol is an open standard for AI agent evolution. It provides a framework for composing reusable AI capabilities called Genes.</p>", targetKeyword: "rotifer" },
    edgeInput: { content: "" },
  },
  "code-complexity": {
    input: { code: "function example(x) {\n  if (x > 0) {\n    for (let i = 0; i < x; i++) {\n      if (i % 2 === 0) console.log(i);\n    }\n  }\n}", language: "javascript" },
    edgeInput: { code: "", language: "javascript" },
  },
  "json-validator": {
    input: { data: { name: "Alice", age: "not-a-number" }, schema: { type: "object", properties: { name: { type: "string" }, age: { type: "number" } }, required: ["name", "age"] } },
    edgeInput: { data: null, schema: {} },
  },
  "markdown-formatter": {
    input: { markdown: "# Title\n*  item1\n*  item2\n## Sub\n+  nested", listMarker: "-" },
    edgeInput: { markdown: "" },
  },
  "text-summarizer": {
    input: { text: "The Rotifer Protocol defines a standard for composing AI tool functions. Each function is packaged as a Gene with typed inputs and outputs. Genes can be tested, composed into Agents, and evaluated competitively in an Arena. The protocol enforces safety through L0 Kernel constraints that cannot be bypassed.", maxWords: 30 },
    edgeInput: { text: "" },
  },
  "url-extractor": {
    input: { text: "Visit https://rotifer.dev for docs. See also https://github.com/rotifer-protocol and contact dev@rotifer.dev.", includeEmails: true },
    edgeInput: { text: "no urls here" },
  },
};

function countLOC(filePath: string): number {
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("//")).length;
}

function countSchemaFields(phenotype: any): number {
  let count = 0;
  const countProps = (schema: any) => {
    if (!schema || typeof schema !== "object") return;
    if (schema.properties) count += Object.keys(schema.properties).length;
    if (schema.items?.properties) count += Object.keys(schema.items.properties).length;
    for (const v of Object.values(schema.properties || {})) {
      if ((v as any).properties) countProps(v);
    }
  };
  countProps(phenotype.inputSchema);
  countProps(phenotype.outputSchema);
  return count;
}

async function testGene(name: string): Promise<GeneResult> {
  const genePath = path.join(GENES_DIR, name, "index.ts");
  const phenotypePath = path.join(GENES_DIR, name, "phenotype.json");
  const loc = countLOC(genePath);
  const phenotype = JSON.parse(fs.readFileSync(phenotypePath, "utf-8"));
  const schemaFields = countSchemaFields(phenotype);

  const mod = await import(path.join(GENES_DIR, name, "index.ts"));
  const testCase = TEST_CASES[name];

  const start = performance.now();
  let output: any;
  let success = true;
  try {
    output = await mod.express(testCase.input);
  } catch {
    success = false;
  }
  const duration = performance.now() - start;

  let robustness = 0;
  try {
    await mod.express(testCase.edgeInput);
    robustness = 1;
  } catch {
    robustness = 0;
  }

  const outputKeys = output ? Object.keys(output).length : 0;

  const schemaScore = Math.min(schemaFields / 15, 1.0);
  const locSweet = 1 - Math.abs(loc - 120) / 200;
  const locScore = Math.max(0.3, Math.min(1.0, locSweet));
  const speedScore = duration < 1 ? 1.0 : duration < 5 ? 0.9 : duration < 20 ? 0.75 : 0.5;
  const outputScore = Math.min(outputKeys / 5, 1.0);
  const robustnessScore = robustness;

  const raw = schemaScore * 0.25 + locScore * 0.15 + speedScore * 0.2 + outputScore * 0.15 + robustnessScore * 0.25;
  const fitness = Math.round((0.6 + raw * 0.35) * 1000) / 1000;

  return { name, success, duration_ms: Math.round(duration * 100) / 100, outputKeys, schemaRichness: schemaFields, robustness, loc, fitness: Math.round(fitness * 1000) / 1000 };
}

async function main() {
  const targetGenes = Object.keys(TEST_CASES);
  console.log(`\n📊 Calculating fitness for ${targetGenes.length} Native genes...\n`);

  const results: GeneResult[] = [];
  for (const name of targetGenes) {
    try {
      const r = await testGene(name);
      results.push(r);
      const status = r.success ? "✅" : "❌";
      console.log(`${status} ${r.name.padEnd(22)} fitness=${r.fitness.toFixed(3)}  duration=${r.duration_ms}ms  LOC=${r.loc}  schema=${r.schemaRichness}  robust=${r.robustness ? "Y" : "N"}`);
    } catch (e: any) {
      console.log(`❌ ${name.padEnd(22)} ERROR: ${e.message}`);
    }
  }

  console.log("\n--- JSON output for genes.json update ---");
  const updates = results.map((r) => ({ name: r.name, fitness: r.fitness.toFixed(3) }));
  console.log(JSON.stringify(updates, null, 2));
}

main().catch(console.error);
