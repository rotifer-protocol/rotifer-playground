/**
 * Run citation-manager gene with the same task as the user.
 * Execute from playground: npx vitest run scripts/run-citation-manager-gene.test.ts
 * Or: node scripts/run-citation-manager-gene.mjs  (after building genes to .js if needed)
 *
 * Gene only supports APA | MLA | Chicago (no GB/T 7714).
 */

import { express as citationExpress } from "../genes/citation-manager/index.js";

const sources = [
  {
    type: "article",
    authors: ["J. D. Smith", "M. K. Johnson"],
    title: "The impact of AI on education",
    year: 2020,
    journal: "Journal of Educational Technology",
    volume: 15,
    issue: 3,
    pages: "45-60",
    doi: "10.1234/jet.2020.45",
  },
  {
    type: "book",
    authors: ["T. Brown"],
    title: "Machine learning fundamentals",
    year: 2019,
    publisher: "Academic Press",
  },
  {
    type: "website",
    authors: ["World Health Organization"],
    title: "Digital health guidelines",
    year: 2023,
    url: "https://www.who.int/digital-health",
  },
];

async function main() {
  console.log("=== citation-manager gene 输出（同一任务，三条文献）===\n");

  for (const style of ["apa", "mla", "chicago"]) {
    const result = await citationExpress({ sources, style });
    console.log(`--- ${style.toUpperCase()} ---`);
    console.log(result.bibliography);
    console.log("");
  }

  console.log("=== 说明 ===");
  console.log("该 gene 仅支持 style: apa | mla | chicago，不支持 GB/T 7714。");
  console.log("文内引用规则（如 GB 顺序编码制 [1]）也未在 gene 中实现。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
