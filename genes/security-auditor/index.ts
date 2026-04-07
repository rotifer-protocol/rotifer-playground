const SECRET_PATTERNS = [
  { re: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"']{8,}["']/gi, cat: "hardcoded-secret", sev: "critical", msg: "Hardcoded API key detected" },
  { re: /(?:sk-[a-zA-Z0-9]{20,})/g, cat: "hardcoded-secret", sev: "critical", msg: "OpenAI-style secret key (sk-) exposed" },
  { re: /(?:ghp_[a-zA-Z0-9]{36,})/g, cat: "hardcoded-secret", sev: "critical", msg: "GitHub personal access token exposed" },
  { re: /(?:password|passwd|pwd)\s*[:=]\s*["'][^"']+["']/gi, cat: "hardcoded-secret", sev: "critical", msg: "Hardcoded password detected" },
  { re: /(?:secret|token)\s*[:=]\s*["'][^"']{8,}["']/gi, cat: "hardcoded-secret", sev: "high", msg: "Potential secret or token hardcoded" },
  { re: /(?:private[_-]?key)\s*[:=]\s*["'][^"']+["']/gi, cat: "hardcoded-secret", sev: "critical", msg: "Hardcoded private key detected" },
  { re: /(?:AKIA[0-9A-Z]{16})/g, cat: "hardcoded-secret", sev: "critical", msg: "AWS access key ID exposed" },
];

const SQLI_PATTERNS = [
  { re: /["'`]\s*\+\s*\w+.*(?:SELECT|INSERT|UPDATE|DELETE|DROP|WHERE)/gi, cat: "sql-injection", sev: "critical", msg: "String concatenation in SQL query — potential SQL injection" },
  { re: /\$\{[^}]+\}.*(?:SELECT|INSERT|UPDATE|DELETE|DROP|WHERE)/gi, cat: "sql-injection", sev: "critical", msg: "Template literal interpolation in SQL — potential SQL injection" },
  { re: /query\s*\(\s*["'`].*\+/gi, cat: "sql-injection", sev: "high", msg: "Dynamic query construction detected — use parameterized queries" },
];

const XSS_PATTERNS = [
  { re: /\.innerHTML\s*=/g, cat: "xss", sev: "high", msg: "Direct innerHTML assignment — potential XSS vector" },
  { re: /document\.write\s*\(/g, cat: "xss", sev: "high", msg: "document.write usage — potential XSS vector" },
  { re: /\beval\s*\(/g, cat: "xss", sev: "critical", msg: "eval() usage — code injection risk" },
  { re: /dangerouslySetInnerHTML/g, cat: "xss", sev: "medium", msg: "dangerouslySetInnerHTML — ensure input is sanitized" },
  { re: /new\s+Function\s*\(/g, cat: "xss", sev: "high", msg: "new Function() constructor — dynamic code execution risk" },
];

const DESER_PATTERNS = [
  { re: /JSON\.parse\s*\(\s*(?:req|request|body|input|params|query)/gi, cat: "unsafe-deserialization", sev: "medium", msg: "Parsing untrusted input without validation" },
  { re: /(?:deserialize|unserialize|unpickle|yaml\.load)\s*\(/gi, cat: "unsafe-deserialization", sev: "high", msg: "Unsafe deserialization of external data" },
];

const VALIDATION_PATTERNS = [
  { re: /req\.(?:body|query|params)\.\w+/g, cat: "missing-validation", sev: "medium", msg: "Direct use of request input — consider input validation" },
];

const ALL_PATTERNS = [
  ...SECRET_PATTERNS,
  ...SQLI_PATTERNS,
  ...XSS_PATTERNS,
  ...DESER_PATTERNS,
  ...VALIDATION_PATTERNS,
];

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 10,
  high: 7,
  medium: 4,
  low: 1,
};

export function express(input: { prompt?: string }): { result: string } {
  const code = input.prompt || "";
  if (!code.trim()) {
    return { result: JSON.stringify({ findings: [], riskScore: 0, summary: "No code provided for analysis." }) };
  }

  const lines = code.split("\n");
  const findings: Array<{ severity: string; category: string; message: string; line: number; fix: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    for (const pattern of ALL_PATTERNS) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(lineText)) {
        const fix = pattern.cat === "hardcoded-secret" ? "Move to environment variable or secrets manager"
          : pattern.cat === "sql-injection" ? "Use parameterized queries or prepared statements"
          : pattern.cat === "xss" ? "Sanitize input before DOM insertion; use textContent or a sanitization library"
          : pattern.cat === "unsafe-deserialization" ? "Validate and schema-check input before parsing"
          : "Add input validation (type checks, length limits, allowlists)";

        findings.push({
          severity: pattern.sev,
          category: pattern.cat,
          message: `${pattern.msg} (line ${i + 1})`,
          line: i + 1,
          fix,
        });
      }
    }
  }

  let riskScore = 0;
  for (const f of findings) {
    riskScore += SEVERITY_WEIGHT[f.severity] || 1;
  }
  riskScore = Math.min(100, riskScore);

  const critCount = findings.filter(f => f.severity === "critical").length;
  const highCount = findings.filter(f => f.severity === "high").length;
  const summary = findings.length === 0
    ? "No security issues detected."
    : `Found ${findings.length} issue(s): ${critCount} critical, ${highCount} high. Risk score: ${riskScore}/100.`;

  return { result: JSON.stringify({ findings, riskScore, summary }) };
}
