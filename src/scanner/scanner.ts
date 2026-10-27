import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import { SCAN_RULES } from "./rules.js";
import { maskJsLiterals } from "./literals.js";
import type { Finding, Grade, ScanResult } from "./types.js";

const CODE_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cjs", ".tsx", ".jsx", ".sh", ".py"]);

// Source files V(g) has no rules for. They are not read, but they are named in
// the result: a gene written only in Rust otherwise looks exactly like a gene
// with no code at all.
const UNSUPPORTED_CODE_EXTENSIONS = new Set([
  ".rs", ".go", ".c", ".h", ".cc", ".cpp", ".hpp", ".zig", ".java", ".kt", ".swift", ".rb", ".cs",
]);

// Files whose literals maskJsLiterals understands. .tsx/.jsx are left out (JSX
// text such as `Don't` is not a string literal), as are .sh and .py, whose
// quoting rules differ; those keep raw-line matching for every rule.
const JS_EXTENSIONS = new Set([".ts", ".js", ".mts", ".mjs", ".cjs"]);

function collectCodeFiles(dir: string, extensions = CODE_EXTENSIONS, skip: readonly string[] = []): string[] {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || skip.includes(entry)) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (extensions.has(extname(entry))) {
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

/** Code files directly in `dir`, not in its subdirectories. */
function collectTopLevelCodeFiles(dir: string, extensions = CODE_EXTENSIONS): string[] {
  return readdirSync(dir)
    .map((entry) => join(dir, entry))
    .filter((full) => statSync(full).isFile() && extensions.has(extname(full)));
}

/**
 * Which files a scan reads:
 * - `--all`: every code file under `dir`.
 * - otherwise src/ when it exists — a Skill's code lives there;
 * - otherwise the code files at the top level of `dir`, not below it. Genes
 *   keep index.ts at the gene root (every Genesis gene does), and reading
 *   only src/ left all of them ungraded. Subdirectories stay out so that
 *   test fixtures and vendored files are not graded as the gene.
 */
function selectFiles(dir: string, shouldScanAll: boolean): string[] {
  if (shouldScanAll) return collectCodeFiles(dir);
  if (hasSrcDirectory(dir)) return collectCodeFiles(join(dir, "src"));
  return collectTopLevelCodeFiles(dir);
}

/** The files selectFiles would have read had V(g) rules for their language.
 * `target/` is skipped: it is Rust's build output, not the gene's source. */
function selectUnscanned(dir: string, shouldScanAll: boolean): string[] {
  const files = shouldScanAll
    ? collectCodeFiles(dir, UNSUPPORTED_CODE_EXTENSIONS, ["target"])
    : hasSrcDirectory(dir)
      ? collectCodeFiles(join(dir, "src"), UNSUPPORTED_CODE_EXTENSIONS, ["target"])
      : collectTopLevelCodeFiles(dir, UNSUPPORTED_CODE_EXTENSIONS);
  return files.map((f) => relative(dir, f)).sort();
}

/** ".rs" files → "Rust"; unknown extensions are named by extension. */
export function unscannedLanguages(files: readonly string[]): string {
  const names: Record<string, string> = {
    ".rs": "Rust", ".go": "Go", ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".hpp": "C++",
    ".zig": "Zig", ".java": "Java", ".kt": "Kotlin", ".swift": "Swift", ".rb": "Ruby", ".cs": "C#",
  };
  const langs = [...new Set(files.map((f) => names[extname(f)] ?? extname(f)))];
  return langs.join(", ");
}

export function scanFile(filePath: string, rootDir: string): Finding[] {
  const content = readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const relPath = relative(rootDir, filePath);
  const findings: Finding[] = [];
  const codeLines = JS_EXTENSIONS.has(extname(filePath)) ? maskJsLiterals(lines) : lines;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;

    for (const rule of SCAN_RULES) {
      const subject = rule.matchOn === "code" ? codeLines[i] : line;
      for (const pattern of rule.patterns) {
        if (pattern.test(subject)) {
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
  const files = selectFiles(dir, shouldScanAll);
  const unscanned = selectUnscanned(dir, shouldScanAll);
  const unscannedField = unscanned.length > 0 ? { unscanned } : {};

  // No code read, no grade. computeGrade([]) is "A", and `--all` over a
  // directory without code used to report exactly that: a clean result for
  // code that was never looked at.
  if (files.length === 0) {
    return {
      skill_id: skillId ?? dir,
      scanned_at: new Date().toISOString(),
      grade: "?",
      findings: [],
      stats: { files_scanned: 0, lines_of_code: 0 },
      ...unscannedField,
    };
  }

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
    ...unscannedField,
  };
}
