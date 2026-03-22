import * as path from "path";
import * as fs from "fs";

const GENES_DIR = path.resolve(__dirname, "../genes");

const TEST_INPUTS: Record<string, Record<string, unknown>> = {
  "grammar-checker": { text: "This is  a test.  the cat sat on the the mat." },
  "design-tokens": { primaryHue: 200, mode: "dark" },
  "citation-manager": { sources: [{ type: "book", authors: ["John Smith"], title: "AI", year: 2025, publisher: "MIT Press" }], style: "apa" },
  "readability-analyzer": { text: "The cat sat on the mat. It was a sunny day." },
  "seo-optimizer": { content: "<h1>Test</h1><p>This is a test page about search optimization.</p>", targetKeyword: "test" },
  "code-complexity": { code: "function a(x) { if(x>0) return x; return -x; }", language: "javascript" },
  "json-validator": { data: { name: "Test" }, schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  "markdown-formatter": { markdown: "# Title\n* item1\n* item2" },
  "text-summarizer": { text: "AI is transforming the world. Machine learning enables new capabilities. Deep learning pushes boundaries further." },
  "url-extractor": { text: "Go to https://example.com and https://test.org for more." },
  "genesis-web-search": { query: "test", maxResults: 2 },
  "genesis-web-search-lite": { query: "hello" },
  "genesis-code-format": { code: "function a(){return 1}", language: "javascript" },
  "genesis-file-read": { path: "./README.md" },
  "genesis-l0-constraint": { action: "delete_user", context: { user: "admin" } },
};

async function main() {
  const names = Object.keys(TEST_INPUTS);
  let pass = 0, fail = 0;

  console.log(`\n🧬 Verifying ${names.length} Native genes...\n`);

  for (const name of names) {
    try {
      const mod = await import(path.join(GENES_DIR, name, "index.ts"));
      if (typeof mod.express !== "function") throw new Error("No express() export");
      const start = performance.now();
      const result = await mod.express(TEST_INPUTS[name]);
      const ms = (performance.now() - start).toFixed(2);
      if (!result || typeof result !== "object") throw new Error("express() returned non-object");
      const keys = Object.keys(result);
      console.log(`  ✅ ${name.padEnd(26)} ${ms}ms  keys=[${keys.join(",")}]`);
      pass++;
    } catch (e: any) {
      console.log(`  ❌ ${name.padEnd(26)} ${e.message}`);
      fail++;
    }
  }

  console.log(`\n📊 Results: ${pass} passed, ${fail} failed out of ${names.length}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
