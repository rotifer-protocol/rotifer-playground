interface Vulnerability {
  type: string;
  severity: string;
  location: string;
  description: string;
  recommendation: string;
}

interface ReporterInput {
  vulnerabilities: Vulnerability[];
  riskScore: number;
  summary: string;
}

interface ReporterOutput {
  report: string;
  executiveSummary: string;
  recommendations: string[];
}

const SEVERITY_BADGE: Record<string, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "🔵 LOW",
};

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

// Severity comes from input, and "constructor" is a key every plain object answers.
function severityBadge(severity: string): string {
  return Object.prototype.hasOwnProperty.call(SEVERITY_BADGE, severity) ? SEVERITY_BADGE[severity] : severity;
}

function countBySeverity(vulns: Vulnerability[]): Record<string, number> {
  const counts: Record<string, number> = Object.create(null);
  for (const v of vulns) {
    counts[v.severity] = (counts[v.severity] ?? 0) + 1;
  }
  return counts;
}

function isMissingSourceSummary(summary?: string): boolean {
  return /no solidity source provided/i.test(summary ?? "");
}

function buildExecutiveSummary(vulns: Vulnerability[], riskScore: number, summary?: string): string {
  if (isMissingSourceSummary(summary)) {
    return `${summary} Provide a Solidity file via --file or point --dir to a directory that contains contract sources.`;
  }

  if (vulns.length === 0) {
    const safeScore = riskScore > 0 ? riskScore : 100;
    return `No vulnerabilities were detected during this automated analysis. The contract scored ${safeScore}/100 on the risk assessment. Manual review is still recommended before deployment.`;
  }

  const counts = countBySeverity(vulns);
  const parts: string[] = [];
  for (const sev of SEVERITY_ORDER) {
    if (counts[sev]) parts.push(`${counts[sev]} ${sev}`);
  }

  return `Automated analysis identified ${vulns.length} potential issue(s) (${parts.join(", ")}). The contract received a risk score of ${riskScore}/100. ${riskScore < 50 ? "Immediate remediation is strongly recommended." : "Review and address findings before deployment."}`;
}

function buildFindingsTable(vulns: Vulnerability[]): string {
  if (vulns.length === 0) return "No findings to report.\n";

  const sorted = [...vulns].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  const lines = [
    "| # | Severity | Type | Location | Description |",
    "|---|----------|------|----------|-------------|",
  ];

  for (let i = 0; i < sorted.length; i++) {
    const v = sorted[i];
    const badge = severityBadge(v.severity);
    lines.push(`| ${i + 1} | ${badge} | ${v.type} | ${v.location} | ${v.description} |`);
  }

  return lines.join("\n") + "\n";
}

function buildRecommendations(vulns: Vulnerability[], summary?: string): string[] {
  if (isMissingSourceSummary(summary)) {
    return ["Provide a .sol file via --file <contract.sol> or run --dir on a directory that contains Solidity sources"];
  }

  if (vulns.length === 0) return ["No remediation actions required"];

  const sorted = [...vulns].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  const seen = new Set<string>();
  const recs: string[] = [];

  for (const v of sorted) {
    const key = `${v.type}:${v.recommendation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    recs.push(`[${severityBadge(v.severity)}] ${v.type}: ${v.recommendation}`);
  }

  return recs;
}

/** A lone `__rotifer_error` key is this gene refusing its input (ADR-334). */
interface Refusal {
  __rotifer_error: { message: string };
}

/** How the input breaks the inputSchema in phenotype.json, or null if it doesn't. */
function inputProblem(input: unknown): string | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return "input must be an object";
  const { vulnerabilities, riskScore, summary } = input as Record<string, unknown>;
  if (vulnerabilities === undefined) return "missing required field 'vulnerabilities'";
  if (!Array.isArray(vulnerabilities)) return "'vulnerabilities' must be an array";
  for (const [i, item] of vulnerabilities.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return `'vulnerabilities[${i}]' must be an object`;
    for (const field of ["type", "severity", "location", "description", "recommendation"]) {
      const value = (item as Record<string, unknown>)[field];
      if (value !== undefined && typeof value !== "string") return `'vulnerabilities[${i}].${field}' must be a string`;
    }
  }
  if (riskScore === undefined) return "missing required field 'riskScore'";
  if (typeof riskScore !== "number") return "'riskScore' must be a number";
  if (summary === undefined) return "missing required field 'summary'";
  if (typeof summary !== "string") return "'summary' must be a string";
  return null;
}

export function express(input: ReporterInput): ReporterOutput | Refusal {
  const problem = inputProblem(input);
  if (problem) return { __rotifer_error: { message: problem } };

  const executiveSummary = buildExecutiveSummary(
    input.vulnerabilities,
    input.riskScore ?? 0,
    input.summary
  );
  const recommendations = buildRecommendations(input.vulnerabilities, input.summary);
  const riskLine = isMissingSourceSummary(input.summary)
    ? "**Risk Score: N/A (no Solidity source analyzed)**"
    : `**Risk Score: ${input.riskScore}/100**`;

  const sections: string[] = [
    "# Smart Contract Audit Report",
    "",
    `> Generated at ${new Date().toISOString()}`,
    "",
    "## Executive Summary",
    "",
    executiveSummary,
    "",
    riskLine,
    "",
    "## Findings",
    "",
    buildFindingsTable(input.vulnerabilities),
    "## Recommendations",
    "",
    ...recommendations.map((r, i) => `${i + 1}. ${r}`),
    "",
    "## Disclaimer",
    "",
    "This report was generated by automated static analysis. It may contain false positives and cannot guarantee the absence of all vulnerabilities. A comprehensive manual audit by experienced security researchers is strongly recommended before deploying to mainnet.",
    "",
  ];

  return {
    report: sections.join("\n"),
    executiveSummary,
    recommendations,
  };
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

function wrapPlainText(text: string, width: number): string[] {
  const safeWidth = Math.max(width, 12);
  const wrapped: string[] = [];

  for (const paragraph of text.split(/\r?\n/)) {
    if (!paragraph.trim()) {
      wrapped.push("");
      continue;
    }

    let current = "";
    for (const word of paragraph.split(/\s+/)) {
      if (word.length > safeWidth) {
        if (current) {
          wrapped.push(current);
          current = "";
        }
        for (let i = 0; i < word.length; i += safeWidth) {
          wrapped.push(word.slice(i, i + safeWidth));
        }
        continue;
      }

      const next = current ? `${current} ${word}` : word;
      if (next.length <= safeWidth) {
        current = next;
      } else {
        wrapped.push(current);
        current = word;
      }
    }

    if (current) wrapped.push(current);
  }

  return wrapped.length > 0 ? wrapped : [""];
}

export function display(output: ReporterOutput, options?: { verbose?: boolean }): void {
  console.log(`${BOLD}${CYAN}Security Audit Report${RESET}`);
  console.log();

  const termWidth = process.stdout.columns || 100;
  const maxInnerWidth = Math.max(20, Math.min(76, termWidth - 8));
  const summaryLines = wrapPlainText(output.executiveSummary, maxInnerWidth);
  const innerWidth = Math.max(...summaryLines.map((l) => l.length), 20);
  const top = `  ${CYAN}┌${"─".repeat(innerWidth + 2)}┐${RESET}`;
  const bot = `  ${CYAN}└${"─".repeat(innerWidth + 2)}┘${RESET}`;
  console.log(top);
  for (const line of summaryLines) {
    const padded = line.padEnd(innerWidth);
    console.log(`  ${CYAN}│${RESET} ${padded} ${CYAN}│${RESET}`);
  }
  console.log(bot);
  console.log();

  console.log(`${BOLD}${BLUE}Recommendations${RESET}`);
  if (output.recommendations.length === 0) {
    console.log(`  ${DIM}(none)${RESET}`);
  } else {
    output.recommendations.forEach((rec, i) => {
      console.log(`  ${GREEN}${i + 1}.${RESET} ${rec}`);
    });
  }
  console.log();

  if (options?.verbose) {
    console.log(`${BOLD}${YELLOW}Full report${RESET}`);
    console.log(`${DIM}${output.report}${RESET}`);
  }
}
