import type { ScanRule } from "./types.js";

export const SCAN_RULES: ScanRule[] = [
  {
    id: "S-01",
    description: "Dynamic code execution",
    severity: "CRITICAL",
    patterns: [
      /\beval\s*\(/,
      /\bFunction\s*\(/,
      /new\s+Function\s*\(/,
    ],
  },
  {
    id: "S-02",
    description: "System command execution",
    severity: "CRITICAL",
    patterns: [
      /require\s*\(\s*['"]child_process['"]\s*\)/,
      /from\s+['"]child_process['"]/,
      /\bexec\s*\(/,
      /\bexecSync\s*\(/,
      /\bspawn\s*\(/,
      /\bspawnSync\s*\(/,
    ],
  },
  {
    id: "S-03",
    description: "Code obfuscation (base64 decode + execute)",
    severity: "CRITICAL",
    patterns: [
      /\batob\s*\([^)]*\)\s*.*\beval\b/,
      /\beval\s*\(\s*atob\b/,
      /Buffer\.from\s*\([^)]*,\s*['"]base64['"]\s*\).*\beval\b/,
      /\bdecodeURIComponent\s*\(\s*escape\s*\(\s*atob\b/,
    ],
  },
  {
    id: "S-04",
    description: "Suspicious external communication",
    severity: "HIGH",
    patterns: [
      /\bfetch\s*\(/,
      /\bhttp\.request\s*\(/,
      /\bhttps\.request\s*\(/,
      /new\s+XMLHttpRequest\s*\(/,
      /\baxios\s*[.(]/,
    ],
  },
  {
    id: "S-05",
    description: "Environment variable access",
    severity: "HIGH",
    patterns: [
      /\bprocess\.env\b/,
      /\bDeno\.env\b/,
      /\bos\.environ\b/,
      /\bimport\.meta\.env\b/,
    ],
  },
  {
    id: "S-06",
    description: "Persistent outbound connection",
    severity: "HIGH",
    patterns: [
      /new\s+WebSocket\s*\(/,
      /\bnet\.Socket\s*\(/,
      /new\s+net\.Socket\s*\(/,
      /\bnet\.createConnection\s*\(/,
      /\btls\.connect\s*\(/,
    ],
  },
  {
    id: "S-07",
    description: "File system operations",
    severity: "MEDIUM",
    patterns: [
      /\bfs\.readFile\b/,
      /\bfs\.readFileSync\b/,
      /\bfs\.writeFile\b/,
      /\bfs\.writeFileSync\b/,
      /\bfs\.unlink\b/,
      /\bfs\.unlinkSync\b/,
      /\bfs\.rmSync\b/,
      /\bfs\.rm\b/,
      /\bfs\.mkdir\b/,
      /\bfs\.mkdirSync\b/,
      /\breadFileSync\s*\(/,
      /\bwriteFileSync\s*\(/,
    ],
  },
];
