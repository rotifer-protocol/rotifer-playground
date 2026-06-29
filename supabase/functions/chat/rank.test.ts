import { assertEquals } from "jsr:@std/assert@1";
import { isPaperSource, selectContextDocs, type RankDoc } from "./rank.ts";

const enLang = (s: string) => s.startsWith("src/content/docs/docs/");

function doc(source: string, similarity: number): RankDoc {
  return { source, similarity, content: source };
}

Deno.test("isPaperSource only matches the papers cache", () => {
  assertEquals(isPaperSource(".papers-cache/rotifer-philosophy-whitepaper.md"), true);
  assertEquals(isPaperSource("src/content/docs/docs/guides/architecture.md"), false);
  assertEquals(isPaperSource("content-catalog"), false);
});

Deno.test("papers are capped so canonical docs keep their slots", () => {
  // 4 highly-relevant paper chunks would otherwise fill the window and crowd
  // out the lower-scoring but authoritative docs.
  const docs: RankDoc[] = [
    doc(".papers-cache/rotifer-protocol-specification.md", 0.61),
    doc(".papers-cache/rotifer-philosophy-whitepaper.md", 0.60),
    doc(".papers-cache/rotifer-ir-specification.md", 0.59),
    doc(".papers-cache/rotifer-gene-vs-skill.md", 0.58),
    doc("src/content/docs/docs/guides/architecture.md", 0.50),
    doc("src/content/docs/docs/concepts/overview.md", 0.48),
    doc("src/content/docs/docs/getting-started.md", 0.45),
    doc("src/content/docs/docs/concepts/uraa.md", 0.43),
  ];

  const picked = selectContextDocs(docs, {
    isUserLang: enLang,
    maxContextDocs: 6,
    maxPaperDocs: 2,
  });

  assertEquals(picked.length, 6);
  assertEquals(picked.filter((d) => isPaperSource(d.source)).length, 2);
  // The authoritative docs that previously got crowded out are now present.
  const sources = picked.map((d) => d.source);
  assertEquals(sources.includes("src/content/docs/docs/guides/architecture.md"), true);
  assertEquals(sources.includes("src/content/docs/docs/concepts/overview.md"), true);
  assertEquals(sources.includes("src/content/docs/docs/getting-started.md"), true);
});

Deno.test("papers still surface (up to the cap) for paper-heavy questions", () => {
  const docs: RankDoc[] = [
    doc(".papers-cache/rotifer-philosophy-whitepaper.md", 0.70),
    doc("src/content/docs/docs/concepts/overview.md", 0.40),
  ];
  const picked = selectContextDocs(docs, {
    isUserLang: enLang,
    maxContextDocs: 6,
    maxPaperDocs: 2,
  });
  // The most relevant paper is kept; nothing is dropped when under the cap.
  assertEquals(picked.length, 2);
  assertEquals(picked[0].source, ".papers-cache/rotifer-philosophy-whitepaper.md");
});

Deno.test("same-language docs get the ranking boost", () => {
  const docs: RankDoc[] = [
    doc("src/content/docs/zh/docs/concepts/overview.md", 0.50),
    doc("src/content/docs/docs/concepts/overview.md", 0.52),
  ];
  // ZH reader: the slightly-lower ZH doc should win via the +0.05 boost.
  const picked = selectContextDocs(docs, {
    isUserLang: (s) => s.startsWith("src/content/docs/zh/"),
    maxContextDocs: 6,
    maxPaperDocs: 2,
  });
  assertEquals(picked[0].source, "src/content/docs/zh/docs/concepts/overview.md");
});
