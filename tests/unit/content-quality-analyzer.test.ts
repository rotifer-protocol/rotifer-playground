import { describe, it, expect, vi } from "vitest";
import { express, display } from "../../genes/content-quality-analyzer/index.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Gene: content-quality-analyzer", () => {
  it("analyzes a well-written English paragraph", () => {
    const result = express({
      text: "How to Build Better AI Agents\n\nArtificial intelligence agents are transforming the way we build software. Modern frameworks allow developers to compose modular capabilities into powerful autonomous systems. This article explores practical patterns for building reliable agents.",
    });

    expect(result.readability.language).toBe("English");
    expect(result.readability.score).toBeTypeOf("number");
    expect(result.readability.score).toBeGreaterThan(0);
    expect(result.readability.grade).toBeTypeOf("string");
    expect(result.sentiment.tone).toBeTypeOf("string");
    expect(result.structure.wordCount).toBeGreaterThan(20);
    expect(result.structure.hasHeadings).toBe(false);
  });

  it("detects Chinese language text", () => {
    const result = express({
      text: "这是一篇关于人工智能技术的深度分析文章。随着大语言模型的快速发展，越来越多的开发者开始关注如何将AI技术应用到实际产品中。",
    });

    expect(result.readability.language).toBe("Chinese");
    expect(result.readability.score).toBeTypeOf("number");
    expect(result.structure.wordCount).toBeGreaterThan(10);
  });

  it("handles empty text without crashing", () => {
    const result = express({ text: "" });

    expect(result.readability).toBeDefined();
    expect(result.readability.score).toBeTypeOf("number");
    expect(result.virality).toBeDefined();
    expect(result.sentiment).toBeDefined();
    expect(result.structure).toBeDefined();
    expect(result.structure.wordCount).toBe(0);
    expect(result.recommendations).toBeInstanceOf(Array);
  });

  it("detects structure in technical markdown with code blocks and headings", () => {
    const text = [
      "## Getting Started",
      "",
      "Install the CLI:",
      "",
      "```bash",
      "npm install -g rotifer",
      "```",
      "",
      "## Usage",
      "",
      "Run the following command:",
      "",
      "```typescript",
      "const gene = await rotifer.load('my-gene');",
      "const result = gene.express({ input: 'hello' });",
      "```",
    ].join("\n");

    const result = express({ text });

    expect(result.structure.hasHeadings).toBe(true);
    expect(result.structure.codeBlocks).toBe(2);
  });

  it("scores virality higher for text with numbers, questions, and code", () => {
    const plainText = "This is a simple article about software development practices.";
    const richText = [
      "# 5 Reasons Why AI Agents Will Replace Traditional APIs?",
      "",
      "Have you ever wondered why modern AI frameworks are gaining traction?",
      "",
      "```typescript",
      "const agent = new Agent();",
      "```",
      "",
      "Step 1: Define your agent's capabilities.",
    ].join("\n");

    const plainResult = express({ text: plainText });
    const richResult = express({ text: richText });

    expect(richResult.virality.score).toBeGreaterThan(plainResult.virality.score);
  });

  it("returns complete output structure", () => {
    const result = express({ text: "Hello world." });

    expect(result.readability).toMatchObject({
      score: expect.any(Number),
      grade: expect.any(String),
      language: expect.any(String),
    });
    expect(result.virality).toMatchObject({
      score: expect.any(Number),
      factors: expect.any(Array),
    });
    expect(result.sentiment).toMatchObject({
      tone: expect.any(String),
      score: expect.any(Number),
    });
    expect(result.structure).toMatchObject({
      paragraphs: expect.any(Number),
      avgLength: expect.any(Number),
      hasHeadings: expect.any(Boolean),
      codeBlocks: expect.any(Number),
      links: expect.any(Number),
      wordCount: expect.any(Number),
    });
    expect(result.recommendations).toBeInstanceOf(Array);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("display() prints dashboard sections for express() output", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = express({ text: "Hello world." });
    display(out);
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("Content quality");
    expect(joined).toContain("Readability");
    expect(joined).toContain("Virality");
    expect(joined).toContain("Sentiment");
    expect(joined).toContain("Structure");
    expect(joined).toContain("Recommendations");
    logSpy.mockRestore();
  });

  it("display() verbose includes factor detail lines", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = express({
      text: [
        "# 3 Tips for Better Code?",
        "",
        "Amazing breakthrough!",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n"),
    });
    display(out, { verbose: true });
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toMatch(/Title Appeal|Emotional/);
    expect(joined).toMatch(/contains number|exclamation|code block/i);
    logSpy.mockRestore();
  });

  it("display() default caps virality factors with hint when many", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    display({
      readability: { score: 80, grade: "Standard", language: "English" },
      virality: {
        score: 50,
        factors: [
          { name: "A", score: 15, detail: "d0" },
          { name: "B", score: 12, detail: "d1" },
          { name: "C", score: 10, detail: "d2" },
          { name: "D", score: 8, detail: "d3" },
        ],
      },
      sentiment: { tone: "Neutral", score: 0 },
      structure: {
        paragraphs: 2,
        avgLength: 40,
        hasHeadings: true,
        codeBlocks: 0,
        links: 0,
        wordCount: 100,
      },
      recommendations: ["r1"],
    });
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("more (use verbose)");
    expect(joined).not.toContain("D ");
    logSpy.mockRestore();
  });
});
