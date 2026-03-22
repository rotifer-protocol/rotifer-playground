import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { scan, computeGrade } from "../../src/scanner/index.js";
import type { Finding } from "../../src/scanner/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `vg-test-${randomUUID()}`);
  mkdirSync(join(tmpDir, "src"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("scan()", () => {
  it("returns grade ? when no src/ directory exists", () => {
    const noSrcDir = join(tmpdir(), `vg-nosrc-${randomUUID()}`);
    mkdirSync(noSrcDir, { recursive: true });
    const result = scan(noSrcDir, "test-skill");
    expect(result.grade).toBe("?");
    expect(result.stats.files_scanned).toBe(0);
    rmSync(noSrcDir, { recursive: true, force: true });
  });

  it("returns grade A for clean code", () => {
    writeFileSync(
      join(tmpDir, "src", "index.ts"),
      'export function hello(): string {\n  return "world";\n}\n',
    );
    const result = scan(tmpDir, "clean-skill");
    expect(result.grade).toBe("A");
    expect(result.findings).toHaveLength(0);
    expect(result.stats.files_scanned).toBe(1);
  });

  it("returns grade D for code with eval()", () => {
    writeFileSync(
      join(tmpDir, "src", "evil.ts"),
      'const x = eval("1+1");\n',
    );
    const result = scan(tmpDir, "evil-skill");
    expect(result.grade).toBe("D");
    expect(result.findings.some((f) => f.rule === "S-01")).toBe(true);
  });

  it("returns grade B for code with 1-2 HIGH findings", () => {
    writeFileSync(
      join(tmpDir, "src", "api.ts"),
      'const res = await fetch("https://api.example.com");\n',
    );
    const result = scan(tmpDir, "api-skill");
    expect(result.grade).toBe("B");
  });

  it("returns grade C for code with >2 HIGH findings", () => {
    writeFileSync(
      join(tmpDir, "src", "risky.ts"),
      [
        'await fetch("https://a.com");',
        "const key = process.env.KEY;",
        'const ws = new WebSocket("wss://b.com");',
      ].join("\n") + "\n",
    );
    const result = scan(tmpDir, "risky-skill");
    expect(result.grade).toBe("C");
  });

  it("ignores node_modules and dist directories", () => {
    mkdirSync(join(tmpDir, "src", "node_modules"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "node_modules", "bad.js"),
      'eval("hack");\n',
    );
    writeFileSync(
      join(tmpDir, "src", "clean.ts"),
      'export const x = 1;\n',
    );
    const result = scan(tmpDir, "modules-skill");
    expect(result.grade).toBe("A");
    expect(result.stats.files_scanned).toBe(1);
  });

  it("scans nested directories", () => {
    mkdirSync(join(tmpDir, "src", "utils"), { recursive: true });
    writeFileSync(
      join(tmpDir, "src", "utils", "shell.ts"),
      'import { exec } from "child_process";\n',
    );
    const result = scan(tmpDir, "nested-skill");
    expect(result.grade).toBe("D");
    expect(result.findings[0].file).toBe("src/utils/shell.ts");
  });

  it("populates skill_id and scanned_at", () => {
    writeFileSync(join(tmpDir, "src", "index.ts"), "export {};\n");
    const result = scan(tmpDir, "my-skill");
    expect(result.skill_id).toBe("my-skill");
    expect(result.scanned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts lines of code accurately", () => {
    writeFileSync(
      join(tmpDir, "src", "a.ts"),
      "line1\nline2\nline3\n",
    );
    writeFileSync(
      join(tmpDir, "src", "b.ts"),
      "x\ny\n",
    );
    const result = scan(tmpDir);
    expect(result.stats.lines_of_code).toBe(7);
    expect(result.stats.files_scanned).toBe(2);
  });

  it("skips single-line comments", () => {
    writeFileSync(
      join(tmpDir, "src", "safe.ts"),
      '// eval("dangerous")\nconst x = 1;\n',
    );
    const result = scan(tmpDir, "comment-skill");
    expect(result.grade).toBe("A");
  });

  it("handles obfuscation pattern (eval + atob)", () => {
    writeFileSync(
      join(tmpDir, "src", "obfuscated.ts"),
      'eval(atob("Y29uc29sZS5sb2coImhlbGxvIik="));\n',
    );
    const result = scan(tmpDir, "obf-skill");
    expect(result.grade).toBe("D");
    expect(result.findings.some((f) => f.rule === "S-03")).toBe(true);
  });
});

describe("computeGrade()", () => {
  const finding = (severity: Finding["severity"]): Finding => ({
    rule: "test",
    severity,
    file: "test.ts",
    line: 1,
    snippet: "test",
  });

  it("A: zero findings", () => {
    expect(computeGrade([])).toBe("A");
  });

  it("A: only MEDIUM findings", () => {
    expect(computeGrade([finding("MEDIUM"), finding("MEDIUM")])).toBe("A");
  });

  it("B: 1-2 HIGH, zero CRITICAL", () => {
    expect(computeGrade([finding("HIGH")])).toBe("B");
    expect(computeGrade([finding("HIGH"), finding("HIGH")])).toBe("B");
  });

  it("C: >2 HIGH, zero CRITICAL", () => {
    expect(computeGrade([finding("HIGH"), finding("HIGH"), finding("HIGH")])).toBe("C");
  });

  it("D: any CRITICAL", () => {
    expect(computeGrade([finding("CRITICAL")])).toBe("D");
    expect(computeGrade([finding("CRITICAL"), finding("HIGH")])).toBe("D");
  });
});
