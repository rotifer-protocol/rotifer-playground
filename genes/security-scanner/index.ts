import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";

interface ScanInput {
  path: string;
  language?: string;
  includeTests?: boolean;
}

interface Vulnerability {
  type: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  file: string;
  line: number;
  message: string;
  recommendation: string;
}

interface CredentialLeak {
  type: string;
  file: string;
  line: number;
  pattern: string;
}

interface ScanOutput {
  vulnerabilities: Vulnerability[];
  credentialLeaks: CredentialLeak[];
  summary: { critical: number; high: number; medium: number; low: number; info: number };
  scannedFiles: number;
  scannedLines: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next"]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".wasm", ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".br", ".7z",
  ".mp3", ".mp4", ".avi", ".mov", ".webm",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx",
  ".exe", ".dll", ".so", ".dylib",
]);

const JS_TS_EXTS = new Set([".ts", ".js", ".mjs", ".jsx", ".tsx"]);

const TEST_PATTERNS = [/[\\/]tests?[\\/]/, /[\\/]__tests__[\\/]/, /\.test\./, /\.spec\./];

const VULN_PATTERNS: {
  type: string;
  severity: Vulnerability["severity"];
  test: (line: string) => boolean;
  message: string;
  recommendation: string;
}[] = [
  {
    type: "XSS",
    severity: "high",
    test: (l) =>
      l.includes("innerHTML") ||
      l.includes("outerHTML") ||
      l.includes("document.write(") ||
      l.includes("dangerouslySetInnerHTML") ||
      l.includes("v-html"),
    message: "Potential XSS: direct DOM HTML injection detected",
    recommendation: "Use textContent, frameworks' safe rendering, or sanitize input with DOMPurify",
  },
  {
    type: "SQL Injection",
    severity: "critical",
    test: (l) =>
      /['"]SELECT\s.*\+/.test(l) ||
      (/SELECT\s/.test(l) && /\$\{/.test(l)),
    message: "Potential SQL injection: string concatenation or template literal in SQL query",
    recommendation: "Use parameterized queries or an ORM instead of string concatenation",
  },
  {
    type: "Command Injection",
    severity: "critical",
    test: (l) => {
      const hasExec =
        l.includes("child_process.exec(") ||
        l.includes("execSync(") ||
        (l.includes("spawn(") && !l.includes("respawn("));
      if (!hasExec) return false;
      return l.includes("${") || l.includes("` +") || l.includes("+ `");
    },
    message: "Potential command injection: shell command with dynamic input",
    recommendation: "Use execFile/execFileSync with argument arrays instead of shell string interpolation",
  },
  {
    type: "Path Traversal",
    severity: "high",
    test: (l) => {
      const hasDotDot = l.includes("../");
      const hasFileOp = l.includes("readFile") || l.includes("readFileSync") || l.includes("path.join");
      const hasUserInput = l.includes("req.params") || l.includes("req.query");
      return (hasDotDot && hasFileOp) || (hasUserInput && hasFileOp);
    },
    message: "Potential path traversal: file operation with relative paths or user input",
    recommendation: "Validate and normalize paths, reject inputs containing '..' sequences",
  },
  {
    type: "ReDoS",
    severity: "medium",
    test: (l) =>
      /\/.*\([^)]*[+*]\)[+*]/.test(l) ||
      /\/.*\([^)]*\|[^)]*\)\*[^/]*[+*]/.test(l),
    message: "Potential ReDoS: regex with nested quantifiers may cause catastrophic backtracking",
    recommendation: "Simplify the regex or use atomic groups / possessive quantifiers",
  },
  {
    type: "Unsafe API",
    severity: "medium",
    test: (l) =>
      l.includes("eval(") ||
      l.includes("new Function(") ||
      (/require\(/.test(l) && !/require\(\s*["']/.test(l)),
    message: "Unsafe API usage: eval, dynamic Function constructor, or dynamic require",
    recommendation: "Avoid eval/Function; use static imports or a safe alternative",
  },
  {
    type: "Prototype Pollution",
    severity: "medium",
    test: (l) => l.includes("__proto__") || l.includes("constructor.prototype"),
    message: "Potential prototype pollution via __proto__ or constructor.prototype access",
    recommendation: "Use Object.create(null), Map, or validate property names against a deny list",
  },
];

const CREDENTIAL_PATTERNS: { type: string; regex: RegExp; label: string }[] = [
  { type: "OpenAI API Key", regex: /sk-[a-zA-Z0-9]{20,}/, label: "sk-..." },
  { type: "GitHub PAT", regex: /ghp_[a-zA-Z0-9]{36}/, label: "ghp_..." },
  { type: "GitLab PAT", regex: /glpat-[a-zA-Z0-9]{20}/, label: "glpat-..." },
  { type: "AWS Access Key", regex: /AKIA[A-Z0-9]{16}/, label: "AKIA..." },
  { type: "JWT / Base64 Token", regex: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/, label: "eyJ..." },
  { type: "Slack Token", regex: /xox[bpsa]-[a-zA-Z0-9-]{10,}/, label: "xox?-..." },
  { type: "Stripe Live Secret Key", regex: /sk_live_[a-zA-Z0-9]{20,}/, label: "sk_live_..." },
  { type: "Stripe Live Publishable Key", regex: /pk_live_[a-zA-Z0-9]{20,}/, label: "pk_live_..." },
  { type: "SendGrid API Key", regex: /SG\.[a-zA-Z0-9_-]{20,}/, label: "SG...." },
  { type: "Google API Key", regex: /AIza[a-zA-Z0-9_-]{35}/, label: "AIza..." },
  {
    type: "Supabase Service Role Key",
    regex: new RegExp("service_role" + ".*eyJ"),
    label: "service_role JWT",
  },
  { type: "Hardcoded Password", regex: /password\s*[:=]\s*["'][^"']{8,}/i, label: "password=..." },
  { type: "Hardcoded Secret", regex: /secret\s*[:=]\s*["'][^"']{8,}/i, label: "secret=..." },
  { type: "Private Key", regex: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/, label: "-----BEGIN PRIVATE KEY-----" },
  { type: "Database URL", regex: /(postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/, label: "db://user:pass@..." },
  { type: "Cloudflare API Token", regex: /cf_[a-zA-Z0-9_-]{30,}/, label: "cf_..." },
  { type: "Twilio API Key", regex: /SK[a-f0-9]{32}/, label: "SK..." },
  { type: "Mailgun API Key", regex: /key-[a-zA-Z0-9]{32}/, label: "key-..." },
  { type: "Heroku API Key", regex: /heroku.*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i, label: "heroku-uuid" },
  { type: "NPM Token", regex: /npm_[a-zA-Z0-9]{36}/, label: "npm_..." },
  { type: "Discord Bot Token", regex: /[MN][a-zA-Z0-9_-]{23,}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,}/, label: "discord-token" },
];

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((p) => p.test(filePath));
}

function collectFiles(dir: string, includeTests: boolean): string[] {
  const files: string[] = [];

  function walk(current: string): void {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;

      const full = join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        const ext = extname(entry).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        if (!includeTests && isTestFile(full)) continue;
        files.push(full);
      }
    }
  }

  walk(dir);
  return files;
}

function scanFileVulnerabilities(
  filePath: string,
  basePath: string,
  lines: string[]
): Vulnerability[] {
  const results: Vulnerability[] = [];
  const rel = relative(basePath, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of VULN_PATTERNS) {
      if (pattern.test(line)) {
        results.push({
          type: pattern.type,
          severity: pattern.severity,
          file: rel,
          line: i + 1,
          message: pattern.message,
          recommendation: pattern.recommendation,
        });
      }
    }
  }

  return results;
}

function scanFileCredentials(
  filePath: string,
  basePath: string,
  lines: string[]
): CredentialLeak[] {
  const results: CredentialLeak[] = [];
  const rel = relative(basePath, filePath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const cred of CREDENTIAL_PATTERNS) {
      if (cred.regex.test(line)) {
        results.push({
          type: cred.type,
          file: rel,
          line: i + 1,
          pattern: cred.label,
        });
      }
    }
  }

  return results;
}

export function express(input: ScanInput): ScanOutput {
  const targetPath = input.path;
  const includeTests = input.includeTests ?? false;

  if (!existsSync(targetPath)) {
    return {
      vulnerabilities: [],
      credentialLeaks: [],
      summary: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      scannedFiles: 0,
      scannedLines: 0,
    };
  }

  const stat = statSync(targetPath);
  const basePath = stat.isDirectory() ? targetPath : join(targetPath, "..");
  const files = stat.isDirectory()
    ? collectFiles(targetPath, includeTests)
    : [targetPath];

  const vulnerabilities: Vulnerability[] = [];
  const credentialLeaks: CredentialLeak[] = [];
  let scannedFiles = 0;
  let scannedLines = 0;

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    scannedFiles++;
    scannedLines += lines.length;

    const ext = extname(file).toLowerCase();
    if (JS_TS_EXTS.has(ext)) {
      vulnerabilities.push(...scanFileVulnerabilities(file, basePath, lines));
    }

    credentialLeaks.push(...scanFileCredentials(file, basePath, lines));
  }

  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const v of vulnerabilities) {
    summary[v.severity]++;
  }

  return {
    vulnerabilities,
    credentialLeaks,
    summary,
    scannedFiles,
    scannedLines,
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

const SEVERITY_ORDER: Record<Vulnerability["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

function severityColor(sev: Vulnerability["severity"]): string {
  if (sev === "critical" || sev === "high") return RED;
  if (sev === "medium") return YELLOW;
  if (sev === "low") return BLUE;
  return DIM;
}

export function display(output: ScanOutput, options?: { verbose?: boolean }): void {
  console.log(`${BOLD}${CYAN}Security scan${RESET} ${DIM}(${output.scannedFiles} files, ${output.scannedLines} lines)${RESET}`);
  console.log(`${DIM}${"─".repeat(48)}${RESET}`);
  const { summary: s } = output;
  console.log(
    `${BOLD}Summary${RESET}  ` +
      `${RED}critical ${s.critical}${RESET}  ` +
      `${RED}high ${s.high}${RESET}  ` +
      `${YELLOW}medium ${s.medium}${RESET}  ` +
      `${BLUE}low ${s.low}${RESET}  ` +
      `${DIM}info ${s.info}${RESET}`
  );

  const sorted = [...output.vulnerabilities].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
  const limit = options?.verbose ? sorted.length : Math.min(5, sorted.length);
  const shown = sorted.slice(0, limit);

  console.log("");
  console.log(
    `${BOLD}Vulnerabilities${RESET} ${DIM}(${shown.length}${options?.verbose ? "" : sorted.length > 5 ? ` of ${sorted.length}` : ""})${RESET}`
  );
  for (const v of shown) {
    const c = severityColor(v.severity);
    console.log(
      `  ${c}[${v.severity}]${RESET} ${BOLD}${v.type}${RESET} ${DIM}${v.file}:${v.line}${RESET}`
    );
    console.log(`    ${v.message}`);
    console.log(`    ${GREEN}→${RESET} ${v.recommendation}`);
  }
  if (!options?.verbose && sorted.length > 5) {
    console.log(`  ${DIM}… ${sorted.length - 5} more (use verbose)${RESET}`);
  }

  console.log("");
  console.log(`${BOLD}Credential leaks${RESET} ${DIM}(${output.credentialLeaks.length})${RESET}`);
  for (const leak of output.credentialLeaks) {
    console.log(
      `  ${RED}${leak.type}${RESET} ${DIM}${leak.file}:${leak.line}${RESET} ${YELLOW}${leak.pattern}${RESET}`
    );
  }
}
