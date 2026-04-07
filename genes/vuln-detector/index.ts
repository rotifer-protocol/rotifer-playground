interface Vulnerability {
  type: string;
  severity: "critical" | "high" | "medium" | "low";
  location: string;
  description: string;
  recommendation: string;
}

interface DetectorInput {
  source: string;
  filename?: string;
}

interface DetectorOutput {
  vulnerabilities: Vulnerability[];
  riskScore: number;
  summary: string;
}

const SEVERITY_COST: Record<string, number> = {
  critical: 20,
  high: 15,
  medium: 10,
  low: 5,
};

function getLines(source: string): string[] {
  return source.split("\n");
}

function detectReentrancy(lines: string[]): Vulnerability[] {
  const results: Vulnerability[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.(call|transfer|send)\s*[({]/.test(line)) {
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        if (/\w+(\[[^\]]*\])?\s*[-+*]?=/.test(lines[j]) && !/require|assert|revert/.test(lines[j])) {
          results.push({
            type: "Reentrancy",
            severity: "critical",
            location: `line ${i + 1}`,
            description: "External call followed by state modification — potential reentrancy vulnerability",
            recommendation: "Apply checks-effects-interactions pattern or use ReentrancyGuard",
          });
          break;
        }
      }
    }
  }
  return results;
}

function detectUncheckedCall(lines: string[]): Vulnerability[] {
  const results: Vulnerability[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/\.call[({]/.test(line) && !/\(bool\s+\w+/.test(line) && !/require\s*\(/.test(line)) {
      const prevLine = i > 0 ? lines[i - 1] : "";
      if (!/if\s*\(/.test(prevLine) && !/require\s*\(/.test(prevLine)) {
        results.push({
          type: "Unchecked Call",
          severity: "high",
          location: `line ${i + 1}`,
          description: "Low-level .call() without checking return value",
          recommendation: "Check the return value: (bool success, ) = target.call(...); require(success);",
        });
      }
    }
  }
  return results;
}

function detectTxOrigin(lines: string[]): Vulnerability[] {
  const results: Vulnerability[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/tx\.origin/.test(lines[i]) && /require|if/.test(lines[i])) {
      results.push({
        type: "tx.origin Authentication",
        severity: "high",
        location: `line ${i + 1}`,
        description: "tx.origin used for authentication — vulnerable to phishing attacks",
        recommendation: "Use msg.sender instead of tx.origin for authorization checks",
      });
    }
  }
  return results;
}

function detectIntegerOverflow(source: string): Vulnerability[] {
  const pragmaMatch = source.match(/pragma\s+solidity\s+[\^~>=<]*\s*([\d.]+)/);
  if (!pragmaMatch) return [];

  const version = pragmaMatch[1].split(".").map(Number);
  const isBelow08 = version[0] === 0 && version[1] < 8;
  const hasSafeMath = /import.*SafeMath/i.test(source) || /using\s+SafeMath/i.test(source);

  if (isBelow08 && !hasSafeMath) {
    return [{
      type: "Integer Overflow",
      severity: "high",
      location: "pragma",
      description: `Solidity ${pragmaMatch[1]} lacks built-in overflow checks and SafeMath is not imported`,
      recommendation: "Upgrade to Solidity >=0.8.0 or use OpenZeppelin SafeMath library",
    }];
  }
  return [];
}

function detectSelfdestruct(lines: string[]): Vulnerability[] {
  const results: Vulnerability[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\b(selfdestruct|suicide)\s*\(/.test(lines[i])) {
      results.push({
        type: "Selfdestruct",
        severity: "critical",
        location: `line ${i + 1}`,
        description: "selfdestruct can permanently destroy the contract and send remaining ETH",
        recommendation: "Remove selfdestruct or restrict access with multi-sig governance",
      });
    }
  }
  return results;
}

function detectDelegatecall(lines: string[]): Vulnerability[] {
  const results: Vulnerability[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\.delegatecall\s*\(/.test(lines[i])) {
      results.push({
        type: "Delegatecall",
        severity: "critical",
        location: `line ${i + 1}`,
        description: "delegatecall executes code in the caller's context — dangerous with user-supplied targets",
        recommendation: "Only delegatecall to trusted, immutable implementation contracts",
      });
    }
  }
  return results;
}

function detectUnlockedPragma(source: string): Vulnerability[] {
  if (/pragma\s+solidity\s+[\^~>=]/.test(source)) {
    return [{
      type: "Unlocked Pragma",
      severity: "low",
      location: "pragma",
      description: "Floating pragma version — contract may compile with an untested compiler version",
      recommendation: "Lock the pragma to a specific version, e.g. pragma solidity 0.8.20;",
    }];
  }
  return [];
}

function detectMissingReentrancyGuard(source: string, lines: string[]): Vulnerability[] {
  const results: Vulnerability[] = [];
  const hasGuard = /nonReentrant/.test(source);
  if (hasGuard) return [];

  for (let i = 0; i < lines.length; i++) {
    if (/\.(call|transfer|send)\s*[({]/.test(lines[i])) {
      const fnStart = findEnclosingFunction(lines, i);
      if (fnStart !== null && !/nonReentrant/.test(lines[fnStart])) {
        results.push({
          type: "Missing Reentrancy Guard",
          severity: "medium",
          location: `line ${i + 1}`,
          description: "Function with external call lacks nonReentrant modifier",
          recommendation: "Add nonReentrant modifier from OpenZeppelin ReentrancyGuard",
        });
      }
    }
  }
  return results;
}

function findEnclosingFunction(lines: string[], lineIndex: number): number | null {
  for (let i = lineIndex; i >= 0; i--) {
    if (/\bfunction\s+\w+/.test(lines[i])) return i;
  }
  return null;
}

export function express(input: DetectorInput): DetectorOutput {
  if (!input?.source || typeof input.source !== "string") {
    return {
      vulnerabilities: [],
      riskScore: 0,
      summary: "No Solidity source provided.",
    };
  }

  const lines = getLines(input.source);

  const vulnerabilities: Vulnerability[] = [
    ...detectReentrancy(lines),
    ...detectUncheckedCall(lines),
    ...detectTxOrigin(lines),
    ...detectIntegerOverflow(input.source),
    ...detectSelfdestruct(lines),
    ...detectDelegatecall(lines),
    ...detectUnlockedPragma(input.source),
    ...detectMissingReentrancyGuard(input.source, lines),
  ];

  if (input.filename) {
    for (const v of vulnerabilities) {
      v.location = `${input.filename}:${v.location}`;
    }
  }

  let riskScore = 100;
  for (const vuln of vulnerabilities) {
    riskScore -= SEVERITY_COST[vuln.severity] ?? 0;
  }
  riskScore = Math.max(0, riskScore);

  const counts: Record<string, number> = {};
  for (const v of vulnerabilities) {
    counts[v.severity] = (counts[v.severity] ?? 0) + 1;
  }

  const parts: string[] = [];
  if (counts.critical) parts.push(`${counts.critical} critical`);
  if (counts.high) parts.push(`${counts.high} high`);
  if (counts.medium) parts.push(`${counts.medium} medium`);
  if (counts.low) parts.push(`${counts.low} low`);

  const summary = vulnerabilities.length === 0
    ? "No vulnerabilities detected"
    : `Found ${vulnerabilities.length} issue(s): ${parts.join(", ")}. Risk score: ${riskScore}/100`;

  return { vulnerabilities, riskScore, summary };
}

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";

const VULN_SEVERITY_ORDER: Record<Vulnerability["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function riskLabel(score: number): { text: string; color: string } {
  if (score >= 80) return { text: "Low", color: GREEN };
  if (score >= 60) return { text: "Medium", color: YELLOW };
  if (score >= 40) return { text: "High", color: RED };
  return { text: "Critical", color: RED };
}

function vulnSeverityColor(sev: Vulnerability["severity"]): string {
  if (sev === "critical" || sev === "high") return RED;
  if (sev === "medium") return YELLOW;
  return BLUE;
}

export function display(output: DetectorOutput, options?: { verbose?: boolean }): void {
  const barWidth = 20;
  const filled = Math.round((output.riskScore / 100) * barWidth);
  const bar =
    GREEN +
    "█".repeat(filled) +
    DIM +
    "░".repeat(Math.max(0, barWidth - filled)) +
    RESET;
  const { text: label, color: labelColor } = riskLabel(output.riskScore);

  console.log(`${BOLD}${CYAN}Vulnerability report${RESET}`);
  console.log(`${DIM}${"─".repeat(44)}${RESET}`);
  console.log(`${BOLD}Risk score${RESET} ${bar} ${BOLD}${output.riskScore}${RESET}/100 ${labelColor}${BOLD}${label}${RESET}`);
  console.log("");
  console.log(`${output.summary}`);

  const bySev: Record<Vulnerability["severity"], Vulnerability[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const v of output.vulnerabilities) {
    bySev[v.severity].push(v);
  }

  const order: Vulnerability["severity"][] = ["critical", "high", "medium", "low"];
  for (const sev of order) {
    const list = bySev[sev];
    if (list.length === 0) continue;
    const c = vulnSeverityColor(sev);
    console.log("");
    console.log(`${c}${BOLD}${sev.toUpperCase()}${RESET} ${DIM}(${list.length})${RESET}`);
    for (const v of list) {
      console.log(`  ${c}●${RESET} ${BOLD}${v.type}${RESET} ${DIM}${v.location}${RESET}`);
      if (options?.verbose) {
        console.log(`    ${DIM}Description:${RESET} ${v.description}`);
      }
      if (options?.verbose) {
        console.log(`    ${GREEN}Recommendation:${RESET} ${v.recommendation}`);
      } else {
        console.log(`    ${GREEN}→${RESET} ${v.recommendation}`);
      }
    }
  }
}
