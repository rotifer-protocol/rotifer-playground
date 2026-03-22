/**
 * Verify all 15 Native genes: import, execute, measure, compute fitness
 */
const GENES = [
  "code-complexity",
  "json-validator",
  "markdown-formatter",
  "text-summarizer",
  "url-extractor",
  "grammar-checker",
  "design-tokens",
  "genesis-web-search",
  "genesis-web-search-lite",
  "citation-manager",
  "genesis-code-format",
  "genesis-file-read",
  "genesis-l0-constraint",
  "readability-analyzer",
  "seo-optimizer",
];

const TEST_INPUTS: Record<string, unknown> = {
  "code-complexity": {
    code: `function fibonacci(n) {\n  if (n <= 1) return n;\n  let a = 0, b = 1;\n  for (let i = 2; i <= n; i++) {\n    const t = b;\n    b = a + b;\n    a = t;\n  }\n  return b;\n}`,
    language: "javascript",
  },
  "json-validator": {
    data: { name: "Alice", age: "not-a-number" },
    schema: {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name", "age"],
    },
  },
  "markdown-formatter": {
    markdown: "# Title\n*  item1\n*  item2\n## Sub\n+  nested",
    listMarker: "-",
  },
  "text-summarizer": {
    text: "The Rotifer Protocol defines a standard for composing AI tool functions. Each function is packaged as a Gene with typed inputs and outputs. Genes can be tested, composed into Agents, and evaluated competitively in an Arena. The protocol ensures deterministic execution and safety through its L0 kernel. Developers can contribute genes and earn reputation through quality contributions.",
    maxWords: 30,
  },
  "url-extractor": {
    text: "Visit https://rotifer.dev for docs. See also https://github.com/rotifer-protocol and contact dev@rotifer.dev for questions.",
    includeEmails: true,
  },
  "grammar-checker": {
    text: "She  dont like the the movie.  it was very bad",
    strict: true,
  },
  "design-tokens": {
    colorTemp: 50,
    roundness: 60,
    motionIntensity: 40,
    density: 50,
    emotionalTone: 50,
    contrastLevel: 70,
    mode: "light",
  },
  "genesis-web-search": { query: "rotifer protocol" },
  "genesis-web-search-lite": { query: "rotifer" },
  "citation-manager": {
    sources: [
      { type: "article", authors: ["Smith, J.", "Doe, A."], title: "Rotifer Protocol Design", year: 2025, journal: "AI Systems", volume: 12, issue: 3, pages: "45-67" },
    ],
    style: "apa",
  },
  "genesis-code-format": {
    code: "function   foo( x ){return   x+1}",
    language: "javascript",
  },
  "genesis-file-read": {
    path: "./genes/grammar-checker/phenotype.json",
  },
  "genesis-l0-constraint": {
    geneId: "abc123",
    constraints: { maxMemoryBytes: 16777216, maxFuel: 1000000 },
  },
  "readability-analyzer": {
    text: "The quick brown fox jumps over the lazy dog. This sentence is simple. Complex multisyllabic vocabulary significantly impacts comprehension.",
  },
  "seo-optimizer": {
    content: "<h1>Rotifer Protocol</h1><p>The Rotifer Protocol enables composable AI gene execution with safety guarantees.</p>",
    targetKeyword: "rotifer protocol",
  },
};

async function main() {
  console.log("=== Native Gene Verification ===\n");
  let passed = 0;
  let failed = 0;
  const results: { name: string; ok: boolean; time: number; fitness: number; error?: string }[] = [];

  for (const name of GENES) {
    const start = performance.now();
    try {
      const mod = await import(`../genes/${name}/index.ts`);
      if (typeof mod.express !== "function") {
        throw new Error("Missing express() export");
      }
      const input = TEST_INPUTS[name] || {};
      const output = await mod.express(input);
      const elapsed = performance.now() - start;

      if (!output || typeof output !== "object") {
        throw new Error(`Invalid output: ${JSON.stringify(output)}`);
      }

      const schemaFields = Object.keys(output);
      const robustness = schemaFields.length > 2 ? 0.3 : 0.1;
      const utilization = Math.min(JSON.stringify(output).length / 50, 5);
      const latencyPenalty = 1 + elapsed / 1000;
      const fitness = +(
        (1.0 * Math.log(1 + utilization) * (1 + robustness)) / latencyPenalty
      ).toFixed(3);

      results.push({ name, ok: true, time: +elapsed.toFixed(1), fitness });
      passed++;
      console.log(`✅ ${name.padEnd(26)} ${elapsed.toFixed(1).padStart(7)}ms  fitness=${fitness}  keys=[${schemaFields.join(", ")}]`);
    } catch (err: any) {
      const elapsed = performance.now() - start;
      results.push({ name, ok: false, time: +elapsed.toFixed(1), fitness: 0, error: err.message });
      failed++;
      console.log(`❌ ${name.padEnd(26)} ${elapsed.toFixed(1).padStart(7)}ms  ERROR: ${err.message}`);
    }
  }

  console.log(`\n=== Summary: ${passed} passed, ${failed} failed / ${GENES.length} total ===\n`);

  if (failed > 0) {
    console.log("Failed genes:");
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.error}`);
    }
  }

  console.log("\nFitness table:");
  for (const r of results.filter((r) => r.ok).sort((a, b) => b.fitness - a.fitness)) {
    console.log(`  ${r.name.padEnd(26)} ${r.fitness.toFixed(3)}`);
  }
}

main().catch(console.error);
