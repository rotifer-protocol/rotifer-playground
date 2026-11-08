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
import { express as audit } from "../../genes/audit-reporter/index.js";

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

describe("names a plain object already answers for", () => {
  const PROTOTYPE_NAMES = ["toString", "constructor", "__proto__", "valueOf", "hasOwnProperty", "isPrototypeOf"];
  const violation = { rule: "r", severity: "info", message: "m" };
  const reportOf = (input: unknown) => (report(input as never) as { report: string }).report;

  it.each(PROTOTYPE_NAMES)("uiux-reporter groups a category named %s", (category) => {
    const output = reportOf({ score: 1, categories: {}, violations: [{ ...violation, category }] });
    expect(output).toContain(`### ${category.charAt(0).toUpperCase() + category.slice(1)}\n`);
    expect(output).not.toContain("(score:");
  });

  it("uiux-reporter still shows a score the input gives for such a category", () => {
    const output = reportOf({ score: 1, categories: { toString: 80 }, violations: [{ ...violation, category: "toString" }] });
    expect(output).toContain("### ToString (score: 80/100)");
  });

  it("uiux-reporter ranks a severity named constructor as unknown, after the known ones", () => {
    const output = reportOf({
      score: 1,
      violations: [
        { ...violation, severity: "constructor" },
        { ...violation, severity: "critical" },
      ],
    });
    expect(output).toMatch(/\| 1 \| critical \|/);
  });

  it.each(["constructor", "__proto__", "Constructor"])("content-optimizer treats a factor named %s as unknown", (name) => {
    const output = optimize({ ...SECTIONS, virality: { score: 50, factors: [{ name, score: 1 }] } }) as {
      optimizedSuggestions: unknown[];
    };
    expect(output.optimizedSuggestions.every((s) => typeof s === "string")).toBe(true);
    expect(output.optimizedSuggestions).toContain(`Improve "${name}" factor (currently 1/100) — strengthen this dimension`);
  });

  it.each(["constructor", "__proto__", "toString"])("audit-reporter prints a severity named %s as given", (severity) => {
    const output = audit({
      riskScore: 10,
      summary: "s",
      vulnerabilities: [{ type: "t", severity, location: "l", description: "d", recommendation: "r" }],
    }) as { report: string; recommendations: string[] };
    expect(output.recommendations).toEqual([`[${severity}] t: r`]);
    expect(output.report).toContain(`| 1 | ${severity} | t |`);
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
