/**
 * 用 citation-manager 基因执行与用户相同的任务（三条 APA 文献 → 格式化）.
 * 运行: npx vitest run tests/run-citation-manager-gene.test.ts
 */
import { describe, it } from "vitest";
import { express as citation } from "../genes/citation-manager/index.js";

const userTaskSources = [
  {
    type: "article" as const,
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
    type: "book" as const,
    authors: ["T. Brown"],
    title: "Machine learning fundamentals",
    year: 2019,
    publisher: "Academic Press",
  },
  {
    type: "website" as const,
    authors: ["World Health Organization"],
    title: "Digital health guidelines",
    year: 2023,
    url: "https://www.who.int/digital-health",
  },
];

describe("Run citation-manager gene: user task (APA refs -> format)", () => {
  it("formats user refs in APA, MLA, Chicago and logs result", async () => {
    console.log("\n=== citation-manager gene 输出（同一任务，三条文献）===\n");

    for (const style of ["apa", "mla", "chicago"] as const) {
      const result = await citation({ sources: userTaskSources, style });
      console.log(`--- ${style.toUpperCase()} ---`);
      console.log(result.bibliography);
      console.log("");
    }

    console.log("=== 说明 ===");
    console.log("该 gene 仅支持 style: apa | mla | chicago，不支持 GB/T 7714。");
    console.log("文内引用规则（如 GB 顺序编码制 [1]）也未在 gene 中实现。\n");
  });
});
