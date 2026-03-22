import { resolve } from "path";
import { readdirSync, existsSync, readFileSync } from "fs";

const GENES_DIR = resolve(__dirname, "../genes");

interface TestInput {
  [key: string]: any;
}

const TEST_INPUTS: Record<string, TestInput> = {
  "code-complexity": {
    code: 'function example(x) {\n  if (x > 0) {\n    for (let i = 0; i < x; i++) {\n      if (i % 2 === 0) console.log(i);\n    }\n  }\n}',
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
    text: "The Rotifer Protocol defines a standard for composing AI tool functions. Each function is packaged as a Gene with typed inputs and outputs. Genes can be tested, composed into Agents, and evaluated competitively in an Arena. The protocol includes safety mechanisms and fitness evaluation.",
    maxWords: 30,
  },
  "url-extractor": {
    text: "Visit https://rotifer.dev for docs. See also https://github.com/rotifer-protocol and contact dev@rotifer.dev.",
    includeEmails: true,
  },
  "grammar-checker": {
    text: "This is  a test.  the quick brown fox jumped.",
    strict: false,
  },
  "design-tokens": {
    theme: "dark",
    brand: { primary: "#22c55e" },
  },
  "citation-manager": {
    sources: [
      { type: "book", authors: ["John Smith"], title: "AI Systems", year: 2024, publisher: "TechPress" },
    ],
    style: "apa",
  },
  "readability-analyzer": {
    text: "The Rotifer Protocol defines a formal standard for the composition of AI tool functions into complex agents. Each atomic function is packaged as a Gene.",
  },
  "seo-optimizer": {
    content: "# Rotifer Protocol\n\nThe Rotifer Protocol is a framework for composable AI agents.\n\n## Features\n\n- Gene composition\n- L0 safety\n- Fitness evaluation",
    targetKeyword: "Rotifer Protocol",
  },
  "genesis-web-search": { query: "rotifer protocol", maxResults: 3 },
  "genesis-web-search-lite": { query: "AI agent" },
  "genesis-code-format": { code: "function hello(){return 'world'}", language: "javascript" },
  "genesis-file-read": { path: "./README.md" },
  "genesis-l0-constraint": { action: "delete_all_user_data", context: { user: "admin" } },
};

async function main() {
  const dirs = readdirSync(GENES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(GENES_DIR, d.name, "index.ts")))
    .map((d) => d.name)
    .sort();

  console.log(`Found ${dirs.length} Native genes with index.ts\n`);

  let pass = 0;
  let fail = 0;

  for (const name of dirs) {
    const input = TEST_INPUTS[name];
    if (!input) {
      console.log(`⚠ ${name}: no test input defined, skipping`);
      continue;
    }

    try {
      const mod = await import(resolve(GENES_DIR, name, "index.ts"));
      if (typeof mod.express !== "function") {
        console.log(`✗ ${name}: no express() function exported`);
        fail++;
        continue;
      }

      const start = performance.now();
      const result = await mod.express(input);
      const ms = (performance.now() - start).toFixed(2);

      if (result && typeof result === "object") {
        const keys = Object.keys(result);
        console.log(`✓ ${name} (${ms}ms) → {${keys.join(", ")}}`);
        pass++;
      } else {
        console.log(`✗ ${name}: returned non-object: ${typeof result}`);
        fail++;
      }
    } catch (err) {
      console.log(`✗ ${name}: ${(err as Error).message}`);
      fail++;
    }
  }

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed, ${dirs.length} total ===`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
