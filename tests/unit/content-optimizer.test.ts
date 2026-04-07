import { describe, it, expect, vi } from "vitest";
import { express, display } from "../../genes/content-optimizer/index.js";

describe("Gene: content-optimizer", () => {
  it("suggests shorter sentences for Academic readability", () => {
    const result = express({
      readability: { score: 25, grade: "Academic", language: "English" },
      virality: { score: 50 },
      sentiment: { tone: "Neutral", score: 0 },
      structure: {
        paragraphs: 5,
        avgLength: 100,
        hasHeadings: true,
        codeBlocks: 1,
        links: 2,
        wordCount: 500,
      },
    });

    const hasShortenSuggestion = result.optimizedSuggestions.some(
      (s) => s.toLowerCase().includes("shorten") || s.toLowerCase().includes("sentence")
    );
    expect(hasShortenSuggestion).toBe(true);
    expect(result.priorityActions.length).toBeGreaterThanOrEqual(1);
  });

  it("suggests adding headings and code blocks when missing", () => {
    const result = express({
      readability: { score: 70, grade: "Standard", language: "English" },
      virality: { score: 60 },
      sentiment: { tone: "Positive", score: 0.5 },
      structure: {
        paragraphs: 4,
        avgLength: 80,
        hasHeadings: false,
        codeBlocks: 0,
        links: 0,
        wordCount: 400,
      },
    });

    const suggestions = result.optimizedSuggestions.join(" ").toLowerCase();
    expect(suggestions).toContain("heading");
    expect(suggestions).toContain("code");
    expect(result.priorityActions.length).toBeGreaterThanOrEqual(1);
  });

  it("returns Low impact for balanced content", () => {
    const result = express({
      readability: { score: 80, grade: "Standard", language: "English" },
      virality: { score: 70 },
      sentiment: { tone: "Positive", score: 0.4 },
      structure: {
        paragraphs: 6,
        avgLength: 100,
        hasHeadings: true,
        codeBlocks: 2,
        links: 3,
        wordCount: 800,
      },
    });

    expect(result.estimatedImpact).toContain("Low");
    expect(result.priorityActions).toBeInstanceOf(Array);
  });

  it("returns correct output structure", () => {
    const result = express({
      readability: { score: 50, grade: "Advanced", language: "English" },
      virality: { score: 30 },
      sentiment: { tone: "Neutral", score: 0 },
      structure: {
        paragraphs: 3,
        avgLength: 150,
        hasHeadings: false,
        codeBlocks: 0,
        links: 0,
        wordCount: 200,
      },
    });

    expect(result.optimizedSuggestions).toBeInstanceOf(Array);
    expect(result.priorityActions).toBeInstanceOf(Array);
    expect(result.priorityActions.length).toBeLessThanOrEqual(3);
    expect(result.estimatedImpact).toBeTypeOf("string");
  });

  describe("display", () => {
    it("prints header, priority checklist, and estimated impact", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display({
        optimizedSuggestions: ["s1", "s2"],
        priorityActions: ["first", "second"],
        estimatedImpact: "Moderate (+10)",
      });
      const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("Content Optimization");
      expect(text).toContain("first");
      expect(text).toContain("Moderate");
      spy.mockRestore();
    });

    it("includes all suggestions when verbose", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display(
        {
          optimizedSuggestions: ["alpha", "beta"],
          priorityActions: ["alpha"],
          estimatedImpact: "Low",
        },
        { verbose: true }
      );
      const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("All suggestions");
      expect(text).toContain("alpha");
      expect(text).toContain("beta");
      spy.mockRestore();
    });

    it("omits full suggestions list when not verbose", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display({
        optimizedSuggestions: ["hidden-detail"],
        priorityActions: ["visible"],
        estimatedImpact: "Low",
      });
      const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).not.toContain("All suggestions");
      expect(text).not.toContain("hidden-detail");
      spy.mockRestore();
    });
  });
});
