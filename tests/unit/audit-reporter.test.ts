import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { express, display } from "../../genes/audit-reporter/index.js";

describe("Gene: audit-reporter", () => {
  it("generates clean report when no vulnerabilities found", () => {
    const result = express({
      vulnerabilities: [],
      riskScore: 100,
      summary: "No vulnerabilities detected",
    });

    expect(result.report).toContain("# Smart Contract Audit Report");
    expect(result.report).toContain("No findings to report");
    expect(result.report).toContain("Disclaimer");
    expect(result.executiveSummary).toContain("No vulnerabilities");
    expect(result.executiveSummary).toContain("100/100");
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toContain("No remediation");
  });

  it("generates report with multiple vulnerabilities", () => {
    const result = express({
      vulnerabilities: [
        {
          type: "Reentrancy",
          severity: "critical",
          location: "line 15",
          description: "External call before state update",
          recommendation: "Use checks-effects-interactions pattern",
        },
        {
          type: "Unlocked Pragma",
          severity: "low",
          location: "pragma",
          description: "Floating pragma",
          recommendation: "Lock pragma version",
        },
        {
          type: "Unchecked Call",
          severity: "high",
          location: "line 20",
          description: "Return value not checked",
          recommendation: "Check return value",
        },
      ],
      riskScore: 55,
      summary: "Found 3 issues",
    });

    expect(result.report).toContain("Reentrancy");
    expect(result.report).toContain("CRITICAL");
    expect(result.report).toContain("HIGH");
    expect(result.report).toContain("LOW");
    expect(result.report).toContain("55/100");
    expect(result.executiveSummary).toContain("3");
    expect(result.recommendations).toHaveLength(3);
    expect(result.recommendations[0]).toContain("CRITICAL");
  });

  it("returns correct output structure", () => {
    const result = express({
      vulnerabilities: [
        {
          type: "Selfdestruct",
          severity: "critical",
          location: "line 10",
          description: "selfdestruct found",
          recommendation: "Remove selfdestruct",
        },
      ],
      riskScore: 80,
      summary: "1 issue found",
    });

    expect(typeof result.report).toBe("string");
    expect(typeof result.executiveSummary).toBe("string");
    expect(Array.isArray(result.recommendations)).toBe(true);
    expect(result.report.startsWith("# Smart Contract Audit Report")).toBe(true);
    expect(result.report).toContain("## Findings");
    expect(result.report).toContain("## Recommendations");
    expect(result.report).toContain("## Disclaimer");
    expect(result.report).toContain("automated");
  });

  it("surfaces missing source input instead of reporting a clean audit", () => {
    const result = express({
      vulnerabilities: [],
      riskScore: 0,
      summary: "No Solidity source provided.",
    });

    expect(result.executiveSummary).toContain("No Solidity source provided.");
    expect(result.executiveSummary).toContain("Provide a Solidity file");
    expect(result.report).toContain("Risk Score: N/A");
    expect(result.recommendations[0]).toContain("--file <contract.sol>");
  });

  it("deduplicates identical recommendations", () => {
    const result = express({
      vulnerabilities: [
        {
          type: "Reentrancy",
          severity: "critical",
          location: "line 10",
          description: "First reentrancy",
          recommendation: "Use ReentrancyGuard",
        },
        {
          type: "Reentrancy",
          severity: "critical",
          location: "line 25",
          description: "Second reentrancy",
          recommendation: "Use ReentrancyGuard",
        },
      ],
      riskScore: 60,
      summary: "2 issues",
    });

    expect(result.recommendations).toHaveLength(1);
  });
});

describe("Gene: audit-reporter display()", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("prints header, boxed summary, and numbered recommendations", () => {
    display({
      report: "full",
      executiveSummary: "One line summary",
      recommendations: ["Fix A", "Fix B"],
    });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("Security Audit Report");
    expect(joined).toContain("One line summary");
    expect(joined).toContain("Fix A");
    expect(joined).toContain("Fix B");
    expect(joined).toMatch(/1\./);
    expect(joined).toMatch(/2\./);
  });

  it("wraps long executive summary to fit terminal width", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 50,
      configurable: true,
    });

    try {
      display({
        report: "full",
        executiveSummary:
          "No vulnerabilities were detected during this automated analysis. The contract scored 100/100 on the risk assessment.",
        recommendations: [],
      });
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
    }

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    const boxedLines = lines.filter((line) => line.includes("│"));

    expect(boxedLines.length).toBeGreaterThan(1);
    expect(lines.join("\n")).toContain("(none)");
  });

  it("includes full report when verbose", () => {
    display(
      {
        report: "VERBOSE_BODY_ONLY",
        executiveSummary: "s",
        recommendations: [],
      },
      { verbose: true }
    );
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("VERBOSE_BODY_ONLY");
    expect(joined).toContain("Full report");
  });

  it("omits full report when not verbose", () => {
    display({
      report: "HIDDEN_REPORT",
      executiveSummary: "s",
      recommendations: [],
    });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).not.toContain("HIDDEN_REPORT");
  });
});
