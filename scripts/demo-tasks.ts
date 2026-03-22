/**
 * Gene Task Simulation — 10 real-world scenarios
 *
 * Run: npx tsx scripts/demo-tasks.ts
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const genesDir = resolve(__dirname, "..", "genes");
const playgroundRoot = resolve(__dirname, "..");

// ─── Helpers ───────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let totalPass = 0;
let totalFail = 0;

async function runTask(
  id: number,
  geneName: string,
  title: string,
  input: unknown,
  validate: (output: any) => string[],
) {
  const label = `Task ${id}`;
  console.log(`\n${BOLD}${CYAN}━━━ ${label}: ${geneName} — ${title} ━━━${RESET}`);
  console.log(`${DIM}Input: ${JSON.stringify(input).slice(0, 120)}${RESET}`);

  try {
    const mod = await import(resolve(genesDir, geneName, "index.ts"));
    if (typeof mod.express !== "function") {
      throw new Error("Gene does not export express()");
    }

    const start = performance.now();
    const output = await mod.express(input);
    const elapsed = (performance.now() - start).toFixed(1);

    const errors = validate(output);

    if (errors.length === 0) {
      totalPass++;
      console.log(`${GREEN}✓ PASS${RESET} ${DIM}(${elapsed}ms)${RESET}`);
      console.log(`${DIM}Output: ${JSON.stringify(output).slice(0, 200)}${RESET}`);
    } else {
      totalFail++;
      console.log(`${RED}✗ FAIL${RESET} ${DIM}(${elapsed}ms)${RESET}`);
      for (const e of errors) console.log(`  ${RED}→ ${e}${RESET}`);
      console.log(`${DIM}Output: ${JSON.stringify(output).slice(0, 200)}${RESET}`);
    }
  } catch (err: any) {
    totalFail++;
    console.log(`${RED}✗ ERROR${RESET}: ${err.message}`);
  }
}

// ─── Task Definitions ──────────────────────────────────────────

async function main() {
  console.log(`${BOLD}Gene Task Simulation — 10 Scenarios${RESET}`);
  console.log(`${"═".repeat(50)}`);

  // Task 1: genesis-web-search
  await runTask(
    1,
    "genesis-web-search",
    "搜索 Rotifer Protocol 相关资料",
    { query: "Rotifer Protocol AI gene composition", maxResults: 3 },
    (o) => {
      const errs: string[] = [];
      if (!Array.isArray(o.results)) errs.push("results is not an array");
      else if (o.results.length !== 3) errs.push(`expected 3 results, got ${o.results.length}`);
      else {
        for (const r of o.results) {
          if (!r.title) errs.push("result missing title");
          if (!r.url) errs.push("result missing url");
          if (!r.snippet) errs.push("result missing snippet");
        }
      }
      if (typeof o.totalResults !== "number") errs.push("totalResults is not a number");
      if (typeof o.searchTime !== "number") errs.push("searchTime is not a number");
      return errs;
    },
  );

  // Task 2: genesis-web-search-lite
  await runTask(
    2,
    "genesis-web-search-lite",
    "快速问答: 什么是 WebAssembly",
    { query: "What is WebAssembly and why is it fast?" },
    (o) => {
      const errs: string[] = [];
      if (typeof o.answer !== "string" || o.answer.length === 0) errs.push("answer is empty or not a string");
      if (typeof o.source !== "string" || !o.source.startsWith("http")) errs.push("source is not a valid URL");
      return errs;
    },
  );

  // Task 3: genesis-file-read
  const readmePath = resolve(playgroundRoot, "README.md");
  await runTask(
    3,
    "genesis-file-read",
    "读取项目 README.md",
    { path: readmePath },
    (o) => {
      const errs: string[] = [];
      if (typeof o.content !== "string" || o.content.length === 0) errs.push("content is empty");
      if (typeof o.size !== "number" || o.size <= 0) errs.push("size should be > 0");
      if (o.encoding !== "utf-8") errs.push(`encoding expected utf-8, got ${o.encoding}`);
      return errs;
    },
  );

  // Task 4a: genesis-code-format (TypeScript — tab + trailing whitespace cleanup)
  await runTask(
    4,
    "genesis-code-format",
    "格式化凌乱的 TypeScript 代码",
    {
      code: "function greet(name: string) {\t\n\treturn `Hello, ${name}!`;   \n}\n\n\n\nconst x = 1;",
      language: "typescript",
    },
    (o) => {
      const errs: string[] = [];
      if (typeof o.formatted !== "string") errs.push("formatted is not a string");
      if (o.changed !== true) errs.push("changed should be true (tabs/trailing whitespace removed)");
      if (o.formatted.includes("\t")) errs.push("formatted still contains tabs");
      if (/[ \t]+$/m.test(o.formatted)) errs.push("formatted still has trailing whitespace");
      if (o.language !== "typescript") errs.push(`language expected typescript, got ${o.language}`);
      return errs;
    },
  );

  // Task 5: genesis-l0-constraint
  await runTask(
    5,
    "genesis-l0-constraint",
    "L0 约束合规检查",
    {
      geneId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      constraints: {
        maxMemoryBytes: 16777216,
        maxFuel: 500000,
        deniedHostFunctions: ["fs.write", "net.listen", "process.exit"],
      },
    },
    (o) => {
      const errs: string[] = [];
      if (typeof o.compliant !== "boolean") errs.push("compliant is not a boolean");
      if (!Array.isArray(o.violations)) errs.push("violations is not an array");
      if (typeof o.constraintSet !== "object") errs.push("constraintSet is not an object");
      return errs;
    },
  );

  // Task 6: grammar-checker
  await runTask(
    6,
    "grammar-checker",
    "英文语法错误检测",
    {
      text: "this is a test  sentence. the the dog is runing very fastly.",
      strict: true,
    },
    (o) => {
      const errs: string[] = [];
      if (!Array.isArray(o.issues) || o.issues.length === 0) errs.push("should detect grammar issues");
      if (typeof o.score !== "number") errs.push("score is not a number");
      else if (o.score >= 100) errs.push("score should be < 100 for text with errors");
      if (typeof o.summary !== "string" || !o.summary.toLowerCase().includes("issue"))
        errs.push('summary should mention "issue"');
      return errs;
    },
  );

  // Task 7: readability-analyzer
  await runTask(
    7,
    "readability-analyzer",
    "白皮书摘要可读性分析",
    {
      text: "The Rotifer Protocol defines a composable standard for packaging AI tool functions as typed, sandboxed units called Genes. Each Gene declares its input and output schemas through a Phenotype descriptor, enabling deterministic composition into multi-step Agent workflows. Genes compete in an Arena where fitness is evaluated across safety, resource efficiency, and correctness dimensions.",
    },
    (o) => {
      const errs: string[] = [];
      if (typeof o.fleschKincaid !== "number") errs.push("fleschKincaid is not a number");
      if (typeof o.gradeLevel !== "number" || o.gradeLevel <= 0) errs.push("gradeLevel should be > 0");
      if (typeof o.wordCount !== "number" || o.wordCount <= 0) errs.push("wordCount should be > 0");
      if (typeof o.verdict !== "string" || o.verdict.length === 0) errs.push("verdict is empty");
      return errs;
    },
  );

  // Task 8: seo-optimizer
  await runTask(
    8,
    "seo-optimizer",
    "博客文章 SEO 分析",
    {
      content:
        "<h1>Getting Started with Rotifer Protocol</h1><p>Rotifer Protocol is an open standard for composable AI genes. It allows developers to package tool functions as typed, sandboxed units. The Rotifer Protocol ecosystem includes a CLI, a cloud registry, and an arena for competitive evaluation.</p><h2>Installation</h2><p>Install the Rotifer Protocol CLI tool to begin developing genes locally. The Rotifer Protocol CLI supports gene creation, testing, and publishing workflows.</p>",
      targetKeyword: "Rotifer Protocol",
    },
    (o) => {
      const errs: string[] = [];
      if (typeof o.score !== "number") errs.push("score is not a number");
      if (typeof o.keywordDensity !== "number" || o.keywordDensity <= 0) errs.push("keywordDensity should be > 0");
      if (o.headingStructure?.h1Count !== 1) errs.push("h1Count should be 1");
      if (typeof o.wordCount !== "number" || o.wordCount <= 0) errs.push("wordCount should be > 0");
      return errs;
    },
  );

  // Task 9: citation-manager
  await runTask(
    9,
    "citation-manager",
    "APA 格式学术引用生成",
    {
      sources: [
        {
          type: "article",
          authors: ["Yann LeCun", "Yoshua Bengio", "Geoffrey Hinton"],
          title: "Deep Learning",
          year: 2015,
          journal: "Nature",
          volume: 521,
          issue: 7553,
          pages: "436-444",
        },
        {
          type: "book",
          authors: ["Stuart Russell", "Peter Norvig"],
          title: "Artificial Intelligence: A Modern Approach",
          year: 2020,
          publisher: "Pearson",
        },
        {
          type: "website",
          authors: ["Rotifer Protocol Contributors"],
          title: "Rotifer Protocol Documentation",
          year: 2026,
          url: "https://rotifer.dev/docs",
        },
      ],
      style: "apa",
    },
    (o) => {
      const errs: string[] = [];
      if (!Array.isArray(o.formatted)) errs.push("formatted is not an array");
      else if (o.formatted.length !== 3) errs.push(`expected 3 citations, got ${o.formatted.length}`);
      if (typeof o.bibliography !== "string" || o.bibliography.length === 0) errs.push("bibliography is empty");
      if (o.style !== "apa") errs.push(`style expected apa, got ${o.style}`);
      if (o.sourceCount !== 3) errs.push(`sourceCount expected 3, got ${o.sourceCount}`);
      return errs;
    },
  );

  // Task 10: design-tokens
  await runTask(
    10,
    "design-tokens",
    "暗色主题设计令牌生成",
    {
      primaryHue: 160,
      mode: "dark",
      density: "compact",
      borderRadius: "rounded",
    },
    (o) => {
      const errs: string[] = [];
      if (typeof o.css !== "string" || !o.css.includes(":root")) errs.push("css should contain :root");
      if (typeof o.totalTokens !== "number" || o.totalTokens < 30) errs.push("totalTokens should be >= 30");
      if (typeof o.tokens !== "object") errs.push("tokens is not an object");
      else if (!o.tokens["--color-primary"]) errs.push("tokens missing --color-primary");
      return errs;
    },
  );

  // ─── Summary ───────────────────────────────────────────────

  console.log(`\n${"═".repeat(50)}`);
  console.log(`${BOLD}Summary${RESET}: ${GREEN}${totalPass} PASS${RESET} / ${totalFail > 0 ? RED : DIM}${totalFail} FAIL${RESET} / 10 total`);

  if (totalFail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
