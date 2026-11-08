/**
 * Input the schema allows does not crash a template gene.
 *
 * These schemas leave most nested fields optional, and a crash reaches the
 * caller as a wasm backtrace. A missing field reads as unknown; it is not
 * refused (ADR-334 D1) and it is not filled in with a plausible value.
 */
import { describe, expect, it } from "vitest";
import { express as optimize } from "../../genes/content-optimizer/index.js";
import { express as report } from "../../genes/uiux-reporter/index.js";

const SECTIONS = {
  readability: { score: 35, grade: "Dense", language: "English" },
  virality: { score: 20 },
  sentiment: { tone: "Neutral", score: 0 },
  structure: { paragraphs: 2, avgLength: 180, hasHeadings: false, codeBlocks: 0, links: 0, wordCount: 360 },
};

describe("content-optimizer", () => {
  it.each([
    ["readability.grade", { readability: { score: 35, language: "English" } }],
    ["readability.language", { readability: { score: 35, grade: "Dense" } }],
    ["sentiment.tone", { sentiment: { score: 0 } }],
  ])("reports the impact as unknown without %s", (field, change) => {
    const output = optimize({ ...SECTIONS, ...change }) as { estimatedImpact: string };
    expect(output.estimatedImpact).toContain("Unknown");
    expect(output.estimatedImpact).toContain(field);
  });

  it("answers when every section is empty", () => {
    const output = optimize({ readability: {}, virality: {}, sentiment: {}, structure: {} }) as { estimatedImpact: string };
    expect(output.estimatedImpact).toContain("Unknown");
  });

  it("skips a null factor and names none for a factor without a name", () => {
    const output = optimize({ ...SECTIONS, virality: { score: 20, factors: [null, { score: 3 }, { score: 4, name: 5 }] } }) as {
      optimizedSuggestions: string[];
    };
    const unnamed = output.optimizedSuggestions.filter((s) => s.startsWith("Improve an unnamed factor"));
    expect(unnamed).toHaveLength(2);
    expect(unnamed[0]).toContain("currently 3/100");
  });

  it("gives its usual estimate when those fields are present", () => {
    const output = optimize(SECTIONS) as { estimatedImpact: string };
    expect(output.estimatedImpact).not.toContain("Unknown");
  });
});

describe("uiux-reporter", () => {
  it("sorts a violation without a severity last, instead of crashing", () => {
    const output = report({
      score: 60,
      violations: [
        { rule: "no-severity", message: "m", category: "visual" },
        { rule: "serious", severity: "critical", message: "m", category: "visual" },
      ],
    }) as { prioritizedFixes: string[] };
    expect(output.prioritizedFixes).toEqual(["[CRITICAL] serious: m"]);
  });
});
