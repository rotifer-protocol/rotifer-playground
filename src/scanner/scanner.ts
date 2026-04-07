import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { SCAN_RULES } from "./rules.js";
import type { Finding, Grade, ScanResult } from "./types.js";

const CODE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cjs", ".tsx", ".jsx", ".sh", ".py"]);

function collectCodeFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (CODE_EXTENSIONS.has(extname(entry))) {
        files.push(full);
      }
    }
  };
  walk(dir);
  return files;
}

function hasSrcDirectory(dir: string): boolean {
  return existsSync(join(dir, "src"));
}

export function scanFile(filePath: string, rootDir: string): Finding[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = relative(rootDir, filePath);
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;

    for (const rule of SCAN_RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(line)) {
          findings.push({
            rule: rule.id,
            severity: rule.severity,
            file: relPath,
            line: i + 1,
            snippet: line.trim().slice(0, 120),
          });
          break;
        }
      }
    }
  }

  return findings;
}

export function computeGrade(findings: Finding[]): Grade {
  const criticals = findings.filter((f) => f.severity === "CRITICAL").length;
  const highs = findings.filter((f) => f.severity === "HIGH").length;

  if (criticals >= 1) return "D";
  if (highs > 2) return "C";
  if (highs > 0) return "B";
  return "A";
}

export interface ScanOptions {
  scanAll?: boolean;
}

export function scan(dir: string, skillId?: string, options?: ScanOptions): ScanResult {
  const shouldScanAll = options?.scanAll ?? false;

  if (!shouldScanAll && !hasSrcDirectory(dir)) {
    return {
      skill_id: skillId ?? dir,
      scanned_at: new Date().toISOString(),
      grade: "?",
      findings: [],
      stats: { files_scanned: 0, lines_of_code: 0 },
    };
  }

  const scanDir = shouldScanAll ? dir : join(dir, "src");
  const files = collectCodeFiles(scanDir);
  const allFindings: Finding[] = [];
  let totalLines = 0;

  for (const file of files) {
    const content = readFileSync(file, "utf-8");
    totalLines += content.split("\n").length;
    allFindings.push(...scanFile(file, dir));
  }

  return {
    skill_id: skillId ?? dir,
    scanned_at: new Date().toISOString(),
    grade: computeGrade(allFindings),
    findings: allFindings,
    stats: {
      files_scanned: files.length,
      lines_of_code: totalLines,
    },
  };
}
