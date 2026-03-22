import { describe, it, expect } from "vitest";

import { express as readability } from "../../genes/readability-analyzer/index.js";
import { express as grammar } from "../../genes/grammar-checker/index.js";
import { express as citation } from "../../genes/citation-manager/index.js";
import { express as designTokens } from "../../genes/design-tokens/index.js";
import { express as seo } from "../../genes/seo-optimizer/index.js";

/* ──────────────────────── readability-analyzer ──────────────────────── */

describe("Native Gene: readability-analyzer", () => {
  it("analyzes normal English text", async () => {
    const result = await readability({
      text: "The cat sat on the mat. It was a sunny day. The birds were singing in the trees.",
    });
    expect(result.wordCount).toBe(18);
    expect(result.sentenceCount).toBe(3);
    expect(result.fleschKincaid).toBeGreaterThan(60);
    expect(result.gradeLevel).toBeLessThan(8);
    expect(result.avgSentenceLength).toBe(6);
    expect(result.avgSyllablesPerWord).toBeGreaterThan(0);
    expect(result.complexWordRatio).toBeGreaterThanOrEqual(0);
    expect(result.verdict).toBeTruthy();
  });

  it("handles complex academic text", async () => {
    const result = await readability({
      text: "The epistemological implications of quantum entanglement necessitate a fundamental reconsideration of our conventional understanding of causality, particularly when examining the phenomenon through the lens of contemporary philosophical discourse.",
    });
    expect(result.fleschKincaid).toBeLessThan(30);
    expect(result.gradeLevel).toBeGreaterThan(12);
    expect(result.complexWordRatio).toBeGreaterThan(0.2);
  });

  it("returns zero values for empty input", async () => {
    const result = await readability({ text: "" });
    expect(result.wordCount).toBe(0);
    expect(result.sentenceCount).toBe(0);
    expect(result.fleschKincaid).toBe(0);
    expect(result.verdict).toBe("No text provided");
  });
});

/* ──────────────────────── grammar-checker ──────────────────────── */

describe("Native Gene: grammar-checker", () => {
  it("detects common grammar issues", async () => {
    const result = await grammar({
      text: "he went to the  store.  the rain  started.",
    });
    expect(result.issues.length).toBeGreaterThan(0);
    const rules = result.issues.map((i) => i.rule);
    expect(rules).toContain("double-space");
    expect(rules).toContain("sentence-capitalization");
    expect(result.score).toBeLessThan(100);
    expect(result.summary).toContain("issue");
  });

  it("returns clean result for correct text", async () => {
    const result = await grammar({
      text: "The quick brown fox jumps over the lazy dog.",
    });
    expect(result.issues).toHaveLength(0);
    expect(result.score).toBe(100);
    expect(result.summary).toContain("Clean");
  });

  it("detects repeated words", async () => {
    const result = await grammar({
      text: "This is is a test sentence.",
    });
    const repeated = result.issues.find((i) => i.rule === "repeated-word");
    expect(repeated).toBeDefined();
  });

  it("enables strict rules when strict=true", async () => {
    const result = await grammar({
      text: "The report was completed by the team. It was very good.",
      strict: true,
    });
    const rules = result.issues.map((i) => i.rule);
    expect(rules.some((r) => r === "passive-voice" || r === "very-qualifier")).toBe(true);
  });

  it("handles empty input", async () => {
    const result = await grammar({ text: "" });
    expect(result.issues).toHaveLength(0);
    expect(result.score).toBe(100);
  });
});

/* ──────────────────────── citation-manager ──────────────────────── */

describe("Native Gene: citation-manager", () => {
  const sampleSources = [
    {
      type: "article" as const,
      authors: ["John Smith", "Jane Doe"],
      title: "The impact of AI on education",
      year: 2020,
      journal: "Journal of Educational Technology",
      volume: 15,
      issue: 3,
      pages: "45-60",
    },
    {
      type: "book" as const,
      authors: ["Thomas Brown"],
      title: "Machine Learning Fundamentals",
      year: 2019,
      publisher: "Academic Press",
    },
  ];

  it("formats citations in APA style", async () => {
    const result = await citation({ sources: sampleSources, style: "apa" });
    expect(result.formatted).toHaveLength(2);
    expect(result.style).toBe("apa");
    expect(result.sourceCount).toBe(2);
    expect(result.formatted[0]).toContain("(2020)");
    expect(result.formatted[0]).toContain("Smith");
    expect(result.bibliography).toContain("The impact of AI");
  });

  it("formats citations in MLA style", async () => {
    const result = await citation({ sources: sampleSources, style: "mla" });
    expect(result.formatted).toHaveLength(2);
    expect(result.style).toBe("mla");
    expect(result.formatted[1]).toContain("Machine Learning Fundamentals");
    expect(result.formatted[1]).toContain("2019");
  });

  it("formats citations in Chicago style", async () => {
    const result = await citation({ sources: sampleSources, style: "chicago" });
    expect(result.formatted).toHaveLength(2);
    expect(result.style).toBe("chicago");
  });

  it("handles empty sources", async () => {
    const result = await citation({ sources: [], style: "apa" });
    expect(result.formatted).toHaveLength(0);
    expect(result.bibliography).toBe("");
    expect(result.sourceCount).toBe(0);
  });

  it("formats website citations with URL", async () => {
    const result = await citation({
      sources: [
        {
          type: "website",
          authors: ["World Health Organization"],
          title: "COVID-19 Guidelines",
          year: 2023,
          url: "https://www.who.int/covid-19",
        },
      ],
      style: "apa",
    });
    expect(result.formatted[0]).toContain("https://www.who.int/covid-19");
  });
});

/* ──────────────────────── design-tokens ──────────────────────── */

describe("Native Gene: design-tokens", () => {
  it("generates tokens with default parameters", async () => {
    const result = await designTokens({});
    expect(result.css).toContain(":root");
    expect(result.css).toContain("--color-primary");
    expect(result.css).toContain("--space-");
    expect(result.css).toContain("--radius-");
    expect(result.css).toContain("--font-sans");
    expect(result.css).toContain("--shadow-");
    expect(result.totalTokens).toBeGreaterThan(30);
    expect(Object.keys(result.tokens).length).toBe(result.totalTokens);
  });

  it("generates light mode tokens", async () => {
    const result = await designTokens({ primaryHue: 140, mode: "light" });
    expect(result.css).toContain("hsl(140");
    expect(result.tokens["--color-bg"]).toContain("99%");
  });

  it("generates dark mode tokens", async () => {
    const result = await designTokens({ primaryHue: 220, mode: "dark" });
    expect(result.tokens["--color-bg"]).toContain("5%");
  });

  it("respects density parameter", async () => {
    const compact = await designTokens({ density: "compact" });
    const spacious = await designTokens({ density: "spacious" });
    const compactSpace = parseInt(compact.tokens["--space-2"]);
    const spaciousSpace = parseInt(spacious.tokens["--space-2"]);
    expect(compactSpace).toBeLessThan(spaciousSpace);
  });

  it("respects borderRadius parameter", async () => {
    const sharp = await designTokens({ borderRadius: "sharp" });
    const pill = await designTokens({ borderRadius: "pill" });
    expect(sharp.tokens["--radius-sm"]).toBe("2px");
    expect(pill.tokens["--radius-sm"]).toBe("9999px");
  });
});

/* ──────────────────────── seo-optimizer ──────────────────────── */

describe("Native Gene: seo-optimizer", () => {
  it("analyzes HTML content with keyword", async () => {
    const html = `
      <title>Best Python Tutorials 2025</title>
      <meta name="description" content="Learn Python programming with these comprehensive tutorials covering basics to advanced topics.">
      <h1>Best Python Tutorials for Beginners</h1>
      <p>Python is one of the most popular programming languages. Learning Python can open many career opportunities.</p>
      <h2>Getting Started with Python</h2>
      <p>To get started with Python, you need to install it first. Python is available for all platforms.</p>
      <h2>Advanced Python Topics</h2>
      <p>After learning Python basics, you can explore advanced topics like machine learning and web development.</p>
    `;
    const result = await seo({ content: html, targetKeyword: "Python" });
    expect(result.score).toBeGreaterThan(50);
    expect(result.keywordDensity).toBeGreaterThan(0);
    expect(result.headingStructure.h1Count).toBe(1);
    expect(result.headingStructure.h2Count).toBe(2);
    expect(result.headingStructure.hasProperHierarchy).toBe(true);
    expect(result.metaAnalysis.hasMetaDescription).toBe(true);
    expect(result.metaAnalysis.titleLength).toBeGreaterThan(0);
    expect(result.readabilityScore).toBeGreaterThan(0);
    expect(result.wordCount).toBeGreaterThan(0);
  });

  it("flags missing H1 and thin content", async () => {
    const result = await seo({ content: "Short text." });
    const rules = result.issues.map((i) => i.rule);
    expect(rules).toContain("missing-h1");
    expect(result.headingStructure.h1Count).toBe(0);
    expect(result.score).toBeLessThan(100);
  });

  it("detects keyword stuffing", async () => {
    const words = Array(100).fill("keyword").join(" ");
    const result = await seo({ content: `<h1>${words}</h1>`, targetKeyword: "keyword" });
    expect(result.keywordDensity).toBeGreaterThan(3);
    const stuffing = result.issues.find((i) => i.rule === "keyword-stuffing");
    expect(stuffing).toBeDefined();
  });

  it("handles empty content", async () => {
    const result = await seo({ content: "" });
    expect(result.score).toBe(0);
    expect(result.wordCount).toBe(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("analyzes markdown headings", async () => {
    const md = `# Main Title\n\nSome content here about the topic.\n\n## Section One\n\nMore content.\n\n## Section Two\n\nEven more content.`;
    const result = await seo({ content: md });
    expect(result.headingStructure.h1Count).toBe(1);
    expect(result.headingStructure.h2Count).toBe(2);
  });
});
