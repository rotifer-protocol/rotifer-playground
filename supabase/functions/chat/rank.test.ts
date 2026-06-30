import { assertEquals } from "jsr:@std/assert@1";
import { isDocSource, selectContextDocs, type RankDoc } from "./rank.ts";

const enLang = (s: string) => s.startsWith("src/content/docs/docs/");

function doc(source: string, similarity: number): RankDoc {
  return { source, similarity, content: source };
}

Deno.test("isDocSource only matches authoritative docs", () => {
  assertEquals(isDocSource("src/content/docs/docs/guides/architecture.md"), true);
  assertEquals(isDocSource("src/content/docs/zh/docs/intro.md"), true);
  assertEquals(isDocSource(".papers-cache/rotifer-philosophy-whitepaper.md"), false);
  assertEquals(isDocSource("blog/open-mesh"), false);
  assertEquals(isDocSource("content-catalog"), false);
});

Deno.test("non-doc sources are capped so canonical docs keep their slots", () => {
  // Highly-relevant papers + blogs would otherwise fill the window and crowd
  // out the lower-scoring but authoritative docs.
  const docs: RankDoc[] = [
    doc(".papers-cache/rotifer-protocol-specification.md", 0.61),
    doc("blog/why-bindings-matter", 0.60),
    doc(".papers-cache/rotifer-ir-specification.md", 0.59),
    doc("blog/binding-deep-dive", 0.58),
    doc("src/content/docs/docs/guides/architecture.md", 0.50),
    doc("src/content/docs/docs/concepts/overview.md", 0.48),
    doc("src/content/docs/docs/concepts/ir.md", 0.45),
  ];

  const picked = selectContextDocs(docs, {
    isUserLang: enLang,
    maxContextDocs: 6,
    maxNonDocDocs: 3,
  });

  assertEquals(picked.length, 6);
  assertEquals(picked.filter((d) => !isDocSource(d.source)).length, 3); // non-docs capped
  assertEquals(picked.filter((d) => isDocSource(d.source)).length, 3); // docs keep ≥3
  const sources = picked.map((d) => d.source);
  assertEquals(sources.includes("src/content/docs/docs/guides/architecture.md"), true);
  assertEquals(sources.includes("src/content/docs/docs/concepts/overview.md"), true);
});

Deno.test("docs are never skipped — they may take the whole window", () => {
  const docs: RankDoc[] = [
    doc("src/content/docs/docs/a.md", 0.7),
    doc("src/content/docs/docs/b.md", 0.6),
    doc("src/content/docs/docs/c.md", 0.5),
    doc("src/content/docs/docs/d.md", 0.4),
    doc("blog/x", 0.3),
  ];
  const picked = selectContextDocs(docs, {
    isUserLang: enLang,
    maxContextDocs: 6,
    maxNonDocDocs: 3,
  });
  assertEquals(picked.length, 5);
  assertEquals(picked.filter((d) => isDocSource(d.source)).length, 4);
});

Deno.test("non-docs still surface (up to the cap) for non-doc questions", () => {
  const docs: RankDoc[] = [
    doc("blog/open-mesh", 0.70),
    doc(".papers-cache/rotifer-philosophy-whitepaper.md", 0.66),
    doc("content-catalog", 0.50),
    doc("src/content/docs/docs/concepts/overview.md", 0.40),
  ];
  const picked = selectContextDocs(docs, {
    isUserLang: enLang,
    maxContextDocs: 6,
    maxNonDocDocs: 3,
  });
  // All 3 non-docs fit under the cap; nothing dropped.
  assertEquals(picked.length, 4);
  assertEquals(picked[0].source, "blog/open-mesh");
});

Deno.test("same-language docs get the ranking boost", () => {
  const docs: RankDoc[] = [
    doc("src/content/docs/zh/docs/concepts/overview.md", 0.50),
    doc("src/content/docs/docs/concepts/overview.md", 0.52),
  ];
  const picked = selectContextDocs(docs, {
    isUserLang: (s) => s.startsWith("src/content/docs/zh/"),
    maxContextDocs: 6,
    maxNonDocDocs: 3,
  });
  assertEquals(picked[0].source, "src/content/docs/zh/docs/concepts/overview.md");
});
