import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { express, display } from "../../genes/security-scanner/index.js";

describe("Gene: security-scanner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `rotifer-scan-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("reports zero issues for clean code", () => {
    writeFileSync(
      join(tempDir, "clean.ts"),
      [
        `import { readFile } from "node:fs/promises";`,
        ``,
        `export async function loadConfig(path: string) {`,
        `  const content = await readFile(path, "utf-8");`,
        `  return JSON.parse(content);`,
        `}`,
      ].join("\n")
    );

    const result = express({ path: tempDir });

    expect(result.vulnerabilities).toHaveLength(0);
    expect(result.credentialLeaks).toHaveLength(0);
    expect(result.scannedFiles).toBe(1);
    expect(result.scannedLines).toBeGreaterThan(0);
    expect(result.summary.critical).toBe(0);
    expect(result.summary.high).toBe(0);
  });

  it("detects XSS via innerHTML", () => {
    writeFileSync(
      join(tempDir, "xss.ts"),
      [
        `const userInput = getInput();`,
        `element.innerHTML = userInput;`,
      ].join("\n")
    );

    const result = express({ path: tempDir });

    expect(result.vulnerabilities.length).toBeGreaterThan(0);
    const xss = result.vulnerabilities.find((v) => v.type === "XSS");
    expect(xss).toBeDefined();
    expect(xss!.severity).toBe("high");
    expect(xss!.message).toContain("XSS");
  });

  it("detects hardcoded credentials", () => {
    writeFileSync(
      join(tempDir, "creds.ts"),
      [
        `const key = "sk-abcdefghijklmnopqrst12345";`,
        `const ghToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";`,
        `const safe = process.env.API_KEY;`,
      ].join("\n")
    );

    const result = express({ path: tempDir });

    expect(result.credentialLeaks.length).toBeGreaterThanOrEqual(2);

    const types = result.credentialLeaks.map((l) => l.type);
    expect(types).toContain("OpenAI API Key");
    expect(types).toContain("GitHub PAT");
  });

  it("detects command injection via execSync with template literals", () => {
    writeFileSync(
      join(tempDir, "cmd.ts"),
      [
        `import { execSync } from "node:child_process";`,
        ``,
        `const userPath = process.argv[2];`,
        "execSync(`rm -rf ${userPath}`);",
      ].join("\n")
    );

    const result = express({ path: tempDir });

    const cmdInj = result.vulnerabilities.find((v) => v.type === "Command Injection");
    expect(cmdInj).toBeDefined();
    expect(cmdInj!.severity).toBe("critical");
  });

  it("counts multiple issue types correctly in summary", () => {
    writeFileSync(
      join(tempDir, "mixed.ts"),
      [
        `import { execSync } from "node:child_process";`,
        ``,
        `const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";`,
        `const apiKey = "sk-abcdefghijklmnopqrst12345";`,
        `element.innerHTML = data;`,
        "execSync(`deploy ${target}`);",
        `const x = eval(input);`,
      ].join("\n")
    );

    const result = express({ path: tempDir });

    expect(result.credentialLeaks.length).toBeGreaterThanOrEqual(2);
    expect(result.vulnerabilities.length).toBeGreaterThanOrEqual(2);

    const totalSeverity =
      result.summary.critical +
      result.summary.high +
      result.summary.medium +
      result.summary.low +
      result.summary.info;
    expect(totalSeverity).toBe(result.vulnerabilities.length);
  });

  it("returns empty results for non-existent path", () => {
    const result = express({ path: join(tempDir, "does-not-exist") });

    expect(result.vulnerabilities).toHaveLength(0);
    expect(result.credentialLeaks).toHaveLength(0);
    expect(result.scannedFiles).toBe(0);
    expect(result.scannedLines).toBe(0);
  });

  describe("display", () => {
    const sampleOutput = {
      vulnerabilities: [
        {
          type: "SQL Injection",
          severity: "critical" as const,
          file: "a.ts",
          line: 1,
          message: "sql issue",
          recommendation: "use params",
        },
        {
          type: "ReDoS",
          severity: "medium" as const,
          file: "b.ts",
          line: 2,
          message: "regex issue",
          recommendation: "simplify",
        },
      ],
      credentialLeaks: [
        { type: "API Key", file: "c.ts", line: 3, pattern: "sk-..." },
      ],
      summary: { critical: 1, high: 0, medium: 1, low: 0, info: 0 },
      scannedFiles: 10,
      scannedLines: 500,
    };

    it("prints scan stats and color-coded summary counts", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display(sampleOutput);
      const text = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(text).toContain("Security scan");
      expect(text).toContain("10 files");
      expect(text).toContain("critical 1");
      expect(text).toContain("medium 1");
      spy.mockRestore();
    });

    it("lists vulnerabilities before credential leaks", () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display(sampleOutput);
      const full = spy.mock.calls.map((c) => String(c[0])).join("\n");
      const viPos = full.indexOf("Vulnerabilities");
      const credPos = full.indexOf("Credential leaks");
      expect(viPos).toBeGreaterThan(-1);
      expect(credPos).toBeGreaterThan(viPos);
      expect(full).toContain("SQL Injection");
      expect(full).toContain("API Key");
      spy.mockRestore();
    });

    it("truncates to five vulnerabilities unless verbose", () => {
      const many = {
        ...sampleOutput,
        vulnerabilities: Array.from({ length: 7 }, (_, i) => ({
          type: `V${i}`,
          severity: "low" as const,
          file: `f${i}.ts`,
          line: i + 1,
          message: `m${i}`,
          recommendation: `r${i}`,
        })),
        summary: { critical: 0, high: 0, medium: 0, low: 7, info: 0 },
      };
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      display(many);
      const defText = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(defText).toContain("more (use verbose)");
      spy.mockClear();
      display(many, { verbose: true });
      const verbText = spy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(verbText).toContain("V6");
      expect(verbText).not.toContain("more (use verbose)");
      spy.mockRestore();
    });
  });
});
