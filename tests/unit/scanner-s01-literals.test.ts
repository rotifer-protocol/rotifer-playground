import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { scan } from "../../src/scanner/index.js";
import { maskJsLiterals } from "../../src/scanner/literals.js";

// S-01 (dynamic code execution) used to match the raw line, so a Gene that
// merely *names* eval — in a detection regex or a message string — was graded
// D. security-auditor is the case from ADR-289 that stayed D. S-01 now matches
// only code; these tests pin both halves: literals and comments are not
// findings, and real calls still are, including the ways a line-based scanner
// could be tricked into treating code as a literal.

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `vg-s01-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Scans `source` as the only file of a fresh Gene directory.
function s01Lines(source: string, file = "index.ts"): number[] {
  const geneDir = join(tmpDir, randomUUID());
  mkdirSync(join(geneDir, "src"), { recursive: true });
  writeFileSync(join(geneDir, "src", file), source);
  return scan(geneDir, "t")
    .findings.filter((f) => f.rule === "S-01")
    .map((f) => f.line);
}

describe("S-01 ignores literals and comments", () => {
  it("does not flag security-auditor (ADR-289 false positive)", () => {
    const geneDir = fileURLToPath(new URL("../../genes/security-auditor", import.meta.url));
    const result = scan(geneDir, "security-auditor", { scanAll: true });
    expect(result.findings.filter((f) => f.rule === "S-01")).toEqual([]);
    expect(result.grade).toBe("A");
  });

  it("does not flag a detection regex or message string naming eval / new Function", () => {
    const src = [
      'const P = [',
      '  { re: /\\beval\\s*\\(/g, sev: "critical", msg: "eval() usage — code injection risk" },',
      '  { re: /new\\s+Function\\s*\\(/g, sev: "high", msg: "new Function() constructor — dynamic code execution risk" },',
      '];',
    ].join("\n");
    expect(s01Lines(src)).toEqual([]);
  });

  it("does not flag single-quoted strings, template text or comments", () => {
    const src = [
      "const a = 'avoid eval(x)';",
      "const b = `eval(${name}) is unsafe`;",
      "const c = 1; // eval(c) later",
      "/* Function(x) */ const d = 2;",
      "/*",
      "eval(inside a block comment)",
      "*/",
    ].join("\n");
    expect(s01Lines(src)).toEqual([]);
  });
});

describe("S-01 still flags real calls", () => {
  it("flags direct calls", () => {
    const src = [
      "const r = eval(code);",
      'const f = new Function("a", "return a");',
      'const g = Function("return this")();',
    ].join("\n");
    expect(s01Lines(src)).toEqual([1, 2, 3]);
  });

  it("flags a call after a string on the same line", () => {
    expect(s01Lines('const s = "x"; eval(s);')).toEqual([1]);
  });

  it("flags a call inside a template expression", () => {
    expect(s01Lines("const t = `${eval(x)}`;")).toEqual([1]);
  });

  it("flags code after a backtick that closes a template opened on an earlier line", () => {
    const src = ["const t = `start", "end`; eval(x);"].join("\n");
    expect(s01Lines(src)).toEqual([2]);
  });

  it("treats an ambiguous / as division, not as a regex that would hide the call", () => {
    const src = [
      "const a = 1",
      "/ eval(x) / 2;", // continues line 1: 1 / eval(x) / 2
      "const b = obj.return / eval(y) / 2;",
      "const c = n++ / eval(z) / 2;",
      "const d = (n) / eval(w) / 2;",
    ].join("\n");
    expect(s01Lines(src)).toEqual([2, 3, 4, 5]);
  });

  it("keeps raw-line matching for .tsx, .py and .sh files", () => {
    expect(s01Lines("const el = <p>Don't</p>; eval(x);", "view.tsx")).toEqual([1]);
    expect(s01Lines("x = 'eval(' ", "tool.py")).toEqual([1]);
    expect(s01Lines("echo '\\' ; eval(x)", "run.sh")).toEqual([1]);
  });
});

describe("maskJsLiterals", () => {
  it("keeps line count and length, blanking only literal bodies and comments", () => {
    const lines = ['const a = "eval(x)"; // eval', "const re = /eval\\(/g;"];
    const masked = maskJsLiterals(lines);
    expect(masked.map((l) => l.length)).toEqual(lines.map((l) => l.length));
    expect(masked[0]).toBe('const a = "       "; //     ');
    expect(masked[1]).toBe("const re = /      /g;");
  });
});
