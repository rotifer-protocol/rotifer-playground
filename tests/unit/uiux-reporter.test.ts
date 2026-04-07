import { describe, it, expect, vi } from "vitest";
import { express, display } from "../../genes/uiux-reporter/index.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Gene: uiux-reporter", () => {
  it("produces a clean report for a perfect score", () => {
    const result = express({
      score: 100,
      violations: [],
      passed: 15,
      total: 15,
    });

    expect(result.report).toContain("100/100");
    expect(result.report).toContain("Grade A");
    expect(result.prioritizedFixes).toHaveLength(0);
    expect(result.estimatedEffort).toContain("Quick fix");
  });

  it("prioritizes critical violations before warnings", () => {
    const result = express({
      score: 55,
      violations: [
        { rule: "low-priority", severity: "warning", message: "Minor issue", category: "visual" },
        { rule: "high-priority", severity: "critical", message: "Major problem", category: "accessibility" },
        { rule: "medium-info", severity: "info", message: "Suggestion", category: "consistency" },
      ],
      passed: 12,
      total: 15,
    });

    expect(result.prioritizedFixes.length).toBeGreaterThan(0);
    expect(result.prioritizedFixes[0]).toContain("[CRITICAL]");

    const warningIdx = result.prioritizedFixes.findIndex((f) => f.includes("[WARNING]"));
    const critIdx = result.prioritizedFixes.findIndex((f) => f.includes("[CRITICAL]"));
    if (warningIdx >= 0 && critIdx >= 0) {
      expect(critIdx).toBeLessThan(warningIdx);
    }

    expect(result.estimatedEffort).toBeDefined();
  });

  it("includes category breakdown for violations across categories", () => {
    const result = express({
      score: 60,
      violations: [
        { rule: "img-alt", severity: "critical", message: "Missing alt", category: "accessibility" },
        { rule: "deprecated-tags", severity: "warning", message: "Old tag", category: "semantics" },
        { rule: "inline-styles", severity: "info", message: "Too many", category: "consistency" },
      ],
      categories: { accessibility: 50, visual: 100, semantics: 70, consistency: 80 },
    });

    expect(result.report).toContain("Category Breakdown");
    expect(result.report).toContain("Accessibility");
    expect(result.report).toContain("Semantics");
    expect(result.report).toContain("Consistency");
    expect(result.report).toContain("score: 50/100");
  });

  it("returns correct output structure", () => {
    const result = express({ score: 75, violations: [] });

    expect(result.report).toBeTypeOf("string");
    expect(result.prioritizedFixes).toBeInstanceOf(Array);
    expect(result.estimatedEffort).toBeTypeOf("string");
  });

  it("display() prints report body and prioritized fixes", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = express({
      score: 88,
      violations: [
        { rule: "a", severity: "critical", message: "fix a", category: "accessibility" },
      ],
      passed: 14,
      total: 15,
    });
    display(result);
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("UI/UX Optimization Report");
    expect(joined).toContain("Prioritized fixes");
    expect(joined).toContain("[CRITICAL]");
    expect(joined).toContain("Estimated effort:");
    logSpy.mockRestore();
  });

  it("display() shows numbered list and effort for empty fixes", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    display({
      report: "# Title\n\nBody",
      prioritizedFixes: [],
      estimatedEffort: "Quick fix (~1 hour)",
    });
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("Title");
    expect(joined).toContain("(none)");
    expect(joined).toContain("Quick fix");
    logSpy.mockRestore();
  });

  it("display() numbers multiple prioritized fixes", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    display({
      report: "x",
      prioritizedFixes: ["first fix", "second fix"],
      estimatedEffort: "Moderate",
    });
    const lines = logSpy.mock.calls.map((c) => stripAnsi(String(c[0])));
    expect(lines.some((l) => l.includes("1.") && l.includes("first fix"))).toBe(true);
    expect(lines.some((l) => l.includes("2.") && l.includes("second fix"))).toBe(true);
    logSpy.mockRestore();
  });
});
