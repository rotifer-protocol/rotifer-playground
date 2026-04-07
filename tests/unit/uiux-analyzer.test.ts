import { describe, it, expect, vi } from "vitest";
import { express, display } from "../../genes/uiux-analyzer/index.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Gene: uiux-analyzer", () => {
  it("gives a high score for clean, well-formed HTML", () => {
    const html = `
      <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Clean Page</title>
      </head>
      <body>
        <main>
          <h1>Welcome</h1>
          <img src="hero.png" alt="Hero image">
          <form>
            <label for="name">Name</label>
            <input id="name" type="text" aria-label="Your name">
          </form>
        </main>
      </body>
      </html>
    `;

    const result = express({ html });

    expect(result.score).toBeGreaterThanOrEqual(85);
    const criticals = result.violations.filter((v) => v.severity === "critical");
    expect(criticals).toHaveLength(0);
  });

  it("catches accessibility violations", () => {
    const html = `
      <html>
      <head><title>Bad Page</title></head>
      <body>
        <img src="photo.png">
        <input type="text">
        <input type="email">
      </body>
      </html>
    `;

    const result = express({ html });

    const rules = result.violations.map((v) => v.rule);
    expect(rules).toContain("html-lang");
    expect(rules).toContain("meta-viewport");
    expect(rules).toContain("img-alt");
    expect(rules).toContain("input-label");
  });

  it("detects deprecated HTML tags", () => {
    const html = `
      <html lang="en">
      <head><meta name="viewport" content="width=device-width"></head>
      <body>
        <main>
          <h1>Title</h1>
          <center>Centered text</center>
          <font size="5">Large text</font>
        </main>
      </body>
      </html>
    `;

    const result = express({ html });

    const deprecated = result.violations.find((v) => v.rule === "deprecated-tags");
    expect(deprecated).toBeDefined();
    expect(deprecated!.message).toContain("center");
    expect(deprecated!.message).toContain("font");
    expect(deprecated!.category).toBe("semantics");
  });

  it("analyzes CSS for !important overuse, small fonts, and missing focus", () => {
    const html = `
      <html lang="en">
      <head><meta name="viewport" content="width=device-width"></head>
      <body><main><h1>Test</h1></main></body>
      </html>
    `;
    const css = `
      .a { color: red !important; }
      .b { color: blue !important; }
      .c { font-size: 10px !important; }
      .d { margin: 0 !important; }
      .e { font-size: 8px; }
    `;

    const result = express({ html, css });

    const cssRules = result.violations.map((v) => v.rule);
    expect(cssRules).toContain("important-overuse");
    expect(cssRules).toContain("min-font-size");
    expect(cssRules).toContain("focus-styles");
  });

  it("calculates score deduction correctly", () => {
    const html = `
      <html>
      <body>
        <img src="x.png">
      </body>
      </html>
    `;

    const result = express({ html });

    const criticalCount = result.violations.filter((v) => v.severity === "critical").length;
    const warningCount = result.violations.filter((v) => v.severity === "warning").length;
    const infoCount = result.violations.filter((v) => v.severity === "info").length;
    const expectedScore = Math.max(0, 100 - 5 * criticalCount - 3 * warningCount - 1 * infoCount);

    expect(result.score).toBe(expectedScore);
  });

  it("returns correct output structure", () => {
    const result = express({ html: "<html lang='en'><body></body></html>" });

    expect(result.score).toBeTypeOf("number");
    expect(result.violations).toBeInstanceOf(Array);
    expect(result.warnings).toBeInstanceOf(Array);
    expect(result.passed).toBeTypeOf("number");
    expect(result.total).toBeTypeOf("number");
    expect(result.categories).toBeDefined();
    expect(result.categories.accessibility).toBeTypeOf("number");
    expect(result.categories.visual).toBeTypeOf("number");
    expect(result.categories.semantics).toBeTypeOf("number");
    expect(result.categories.consistency).toBeTypeOf("number");
  });

  it("display() prints score, categories, and severity counts", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = express({ html: "<html><body><img src=x></body></html>" });
    display(result);
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("UI/UX Analysis");
    expect(joined).toContain("Score:");
    expect(joined).toContain("Category breakdown");
    expect(joined).toContain("Severity");
    expect(joined).toContain("critical:");
    logSpy.mockRestore();
  });

  it("display() default truncates violations per category with hint", () => {
    const violations = Array.from({ length: 6 }, (_, i) => ({
      rule: `rule-${i}`,
      severity: "warning" as const,
      message: `msg ${i}`,
      category: "accessibility" as const,
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    display({
      score: 70,
      violations,
      warnings: violations,
      passed: 5,
      total: 20,
      categories: { accessibility: 50, visual: 100, semantics: 100, consistency: 100 },
    });
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("3/6");
    expect(joined).toContain("more (use verbose)");
    logSpy.mockRestore();
  });

  it("display() verbose shows all violations in a crowded category", () => {
    const violations = Array.from({ length: 5 }, (_, i) => ({
      rule: `r-${i}`,
      severity: "info" as const,
      message: `m${i}`,
      category: "consistency" as const,
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    display(
      {
        score: 95,
        violations,
        warnings: [],
        passed: 10,
        total: 15,
        categories: { accessibility: 100, visual: 100, semantics: 100, consistency: 60 },
      },
      { verbose: true }
    );
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("r-0");
    expect(joined).toContain("r-4");
    expect(joined).not.toContain("more (use verbose)");
    logSpy.mockRestore();
  });
});
