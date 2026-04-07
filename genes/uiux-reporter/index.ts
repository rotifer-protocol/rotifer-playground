interface Violation {
  rule: string;
  severity: string;
  message: string;
  category: string;
}

interface ReporterInput {
  score: number;
  violations: Violation[];
  passed?: number;
  total?: number;
  categories?: Record<string, number>;
}

interface ReporterOutput {
  report: string;
  prioritizedFixes: string[];
  estimatedEffort: string;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

function severityRank(s: string): number {
  return SEVERITY_ORDER[s.toLowerCase()] ?? 3;
}

function scoreToGrade(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

function estimateEffort(count: number): string {
  if (count < 5) return "Quick fix (~1 hour)";
  if (count <= 15) return "Moderate (~1 day)";
  if (count <= 30) return "Significant (~3 days)";
  return "Major overhaul (~1 week)";
}

function groupByCategory(violations: Violation[]): Record<string, Violation[]> {
  const groups: Record<string, Violation[]> = {};
  for (const v of violations) {
    const cat = v.category || "uncategorized";
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(v);
  }
  return groups;
}

function generateFixInstruction(v: Violation): string {
  const prefix = v.severity === "critical" ? "[CRITICAL]" : "[WARNING]";
  return `${prefix} ${v.rule}: ${v.message}`;
}

function buildExecutiveSummary(input: ReporterInput, grade: string): string {
  const lines: string[] = [];
  lines.push("## Executive Summary");
  lines.push("");
  lines.push(`**Overall Score: ${input.score}/100 (Grade ${grade})**`);
  lines.push("");

  if (input.passed !== undefined && input.total !== undefined) {
    const failCount = input.total - input.passed;
    lines.push(`- Checks passed: ${input.passed}/${input.total}`);
    lines.push(`- Violations found: ${failCount}`);
  } else {
    lines.push(`- Violations found: ${input.violations.length}`);
  }

  const criticals = input.violations.filter((v) => v.severity === "critical").length;
  const warnings = input.violations.filter((v) => v.severity === "warning").length;
  const infos = input.violations.filter((v) => v.severity === "info").length;

  if (criticals > 0) lines.push(`- Critical issues: ${criticals}`);
  if (warnings > 0) lines.push(`- Warnings: ${warnings}`);
  if (infos > 0) lines.push(`- Info: ${infos}`);

  return lines.join("\n");
}

function buildCategoryBreakdown(
  groups: Record<string, Violation[]>,
  categories?: Record<string, number>
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("## Category Breakdown");
  lines.push("");

  const cats = Object.keys(groups).sort();
  for (const cat of cats) {
    const violations = groups[cat];
    const catScore = categories?.[cat];
    const scoreStr = catScore !== undefined ? ` (score: ${catScore}/100)` : "";
    lines.push(`### ${cat.charAt(0).toUpperCase() + cat.slice(1)}${scoreStr}`);
    lines.push("");
    for (const v of violations) {
      const icon = v.severity === "critical" ? "🔴" : v.severity === "warning" ? "🟡" : "🔵";
      lines.push(`- ${icon} **${v.rule}**: ${v.message}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function buildPriorityFixes(sorted: Violation[]): { section: string; fixes: string[] } {
  const top = sorted
    .filter((v) => v.severity === "critical" || v.severity === "warning")
    .slice(0, 5);

  const fixes = top.map((v) => generateFixInstruction(v));

  const lines: string[] = [];
  lines.push("## Priority Fixes");
  lines.push("");

  if (fixes.length === 0) {
    lines.push("No critical or warning-level issues found. Great job!");
  } else {
    fixes.forEach((fix, i) => {
      lines.push(`${i + 1}. ${fix}`);
    });
  }

  return { section: lines.join("\n"), fixes };
}

function buildFullViolationList(sorted: Violation[]): string {
  if (sorted.length === 0) return "";

  const lines: string[] = [];
  lines.push("");
  lines.push("## Full Violation List");
  lines.push("");
  lines.push("| # | Severity | Category | Rule | Message |");
  lines.push("|---|----------|----------|------|---------|");

  sorted.forEach((v, i) => {
    lines.push(`| ${i + 1} | ${v.severity} | ${v.category || "—"} | ${v.rule} | ${v.message} |`);
  });

  return lines.join("\n");
}

export function express(input: ReporterInput): ReporterOutput {
  if (!input || !Array.isArray(input.violations)) {
    return {
      report: "No violations data provided. Ensure upstream uiux-analyzer completed successfully.",
      prioritizedFixes: [],
      estimatedEffort: "N/A",
    };
  }

  const grade = scoreToGrade(input.score ?? 0);
  const sorted = [...input.violations].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity)
  );
  const groups = groupByCategory(sorted);

  const executive = buildExecutiveSummary(input, grade);
  const breakdown = buildCategoryBreakdown(groups, input.categories);
  const { section: prioritySection, fixes } = buildPriorityFixes(sorted);
  const fullList = buildFullViolationList(sorted);
  const effort = estimateEffort(input.violations.length);

  const report = [
    "# UI/UX Optimization Report",
    "",
    executive,
    breakdown,
    prioritySection,
    fullList,
    "",
    `## Estimated Effort: ${effort}`,
    "",
  ].join("\n");

  return {
    report,
    prioritizedFixes: fixes,
    estimatedEffort: effort,
  };
}

export function display(output: ReporterOutput, options?: { verbose?: boolean }): void {
  const RESET = "\x1b[0m";
  const BOLD = "\x1b[1m";
  const DIM = "\x1b[2m";
  const RED = "\x1b[31m";
  const GREEN = "\x1b[32m";
  const YELLOW = "\x1b[33m";
  const BLUE = "\x1b[34m";
  const CYAN = "\x1b[36m";

  void options;
  console.log(output.report);
  console.log();
  console.log(`${BOLD}${CYAN}Prioritized fixes${RESET}`);
  if (output.prioritizedFixes.length === 0) {
    console.log(`  ${DIM}(none)${RESET}`);
  } else {
    output.prioritizedFixes.forEach((fix, i) => {
      console.log(`  ${BOLD}${i + 1}.${RESET} ${fix}`);
    });
  }
  console.log();
  console.log(`${BOLD}Estimated effort:${RESET} ${YELLOW}${output.estimatedEffort}${RESET}`);
}
