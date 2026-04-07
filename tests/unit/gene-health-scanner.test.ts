import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { express, display } from "../../genes/gene-health-scanner/index.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("Gene: gene-health-scanner", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `rotifer-health-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles empty genes directory gracefully", () => {
    const result = express({ genesDir: tempDir });

    expect(result.geneCount).toBe(0);
    expect(result.overallScore).toBeTypeOf("number");
    expect(result.dimensions).toHaveLength(7);
    expect(result.summary).toContain("0 genes scanned");
  });

  it("scores a single Native gene with full phenotype", () => {
    const geneDir = join(tempDir, "test-gene");
    mkdirSync(geneDir, { recursive: true });

    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({
        name: "test-gene",
        version: "1.0.0",
        domain: "testing",
        fidelity: "Native",
        description: "A test gene for unit testing",
        author: "tester",
        tags: ["test", "unit"],
        inputSchema: { properties: { input: { type: "string" } } },
        outputSchema: { properties: { output: { type: "string" } } },
      })
    );

    writeFileSync(
      join(geneDir, "index.ts"),
      `export function express(input: any) { return { result: input }; }\n`
    );

    const result = express({ genesDir: tempDir });

    expect(result.geneCount).toBe(1);
    expect(result.overallScore).toBeGreaterThan(0.5);

    const compliance = result.dimensions.find((d) => d.name === "Protocol Compliance");
    expect(compliance).toBeDefined();
    expect(compliance!.score).toBeGreaterThan(0.8);
  });

  it("detects mixed fidelity and incomplete phenotypes", () => {
    const nativeGene = join(tempDir, "native-gene");
    mkdirSync(nativeGene);
    writeFileSync(
      join(nativeGene, "phenotype.json"),
      JSON.stringify({
        name: "native-gene",
        fidelity: "Native",
        description: "Complete native gene",
        version: "1.0.0",
        author: "tester",
        tags: ["complete"],
        inputSchema: { properties: { x: { type: "number" } } },
        outputSchema: { properties: { y: { type: "number" } } },
      })
    );
    writeFileSync(join(nativeGene, "index.ts"), `export function express() {}\n`);

    const wrappedGene = join(tempDir, "wrapped-gene");
    mkdirSync(wrappedGene);
    writeFileSync(
      join(wrappedGene, "phenotype.json"),
      JSON.stringify({
        name: "wrapped-gene",
        fidelity: "Wrapped",
        description: "A wrapped gene",
        tags: ["wrapped"],
      })
    );

    const incompleteGene = join(tempDir, "incomplete-gene");
    mkdirSync(incompleteGene);
    writeFileSync(
      join(incompleteGene, "phenotype.json"),
      JSON.stringify({ name: "incomplete-gene" })
    );

    const result = express({ genesDir: tempDir });

    expect(result.geneCount).toBe(3);
    const compliance = result.dimensions.find((d) => d.name === "Protocol Compliance")!;
    expect(compliance.findings.length).toBeGreaterThan(0);
    expect(compliance.findings.some((f) => f.includes("incomplete-gene"))).toBe(true);
  });

  it("detects security issues in gene source code", () => {
    const geneDir = join(tempDir, "unsafe-gene");
    mkdirSync(geneDir);
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({
        name: "unsafe-gene",
        fidelity: "Native",
        description: "Has security issues",
        tags: ["unsafe"],
        inputSchema: { properties: { x: {} } },
        outputSchema: { properties: { y: {} } },
      })
    );
    writeFileSync(
      join(geneDir, "index.ts"),
      [
        `const userInput = process.argv[2];`,
        `eval(userInput);`,
        `const key = "sk-abc12345678901234567890";`,
      ].join("\n")
    );

    const result = express({ genesDir: tempDir });

    const security = result.dimensions.find((d) => d.name === "Security Vulnerabilities")!;
    expect(security.score).toBeLessThan(1.0);
    expect(security.findings.some((f) => f.includes("eval()"))).toBe(true);
    expect(security.findings.some((f) => f.includes("hardcoded OpenAI key"))).toBe(true);
  });

  it("flags broken dependency chains", () => {
    const geneA = join(tempDir, "gene-a");
    mkdirSync(geneA);
    writeFileSync(
      join(geneA, "phenotype.json"),
      JSON.stringify({
        name: "gene-a",
        description: "Depends on non-existent gene",
        dependencies: ["gene-b-nonexistent"],
        tags: ["dep-test"],
        inputSchema: { properties: {} },
        outputSchema: { properties: {} },
      })
    );

    const result = express({ genesDir: tempDir });

    const deps = result.dimensions.find((d) => d.name === "Dependency Chain Health")!;
    expect(deps.score).toBeLessThan(1.0);
    expect(deps.findings.some((f) => f.includes("gene-b-nonexistent") && f.includes("not found"))).toBe(true);
  });

  it("output has all required fields with correct types", () => {
    const result = express({ genesDir: tempDir });

    expect(result.summary).toBeTypeOf("string");
    expect(result.dimensions).toBeInstanceOf(Array);
    expect(result.dimensions).toHaveLength(7);
    expect(result.overallScore).toBeTypeOf("number");
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(1);
    expect(result.geneCount).toBeTypeOf("number");
    expect(result.recommendations).toBeInstanceOf(Array);

    for (const dim of result.dimensions) {
      expect(dim.name).toBeTypeOf("string");
      expect(dim.score).toBeTypeOf("number");
      expect(dim.findings).toBeInstanceOf(Array);
      expect(dim.suggestions).toBeInstanceOf(Array);
    }
  });

  it("display() prints header, overall bar, and recommendations", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = express({ genesDir: tempDir });
    display(out);
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("Gene Health Report");
    expect(joined).toContain("Overall");
    expect(joined).toContain("Recommendations");
    expect(joined).toContain("Capability Distribution");
    logSpy.mockRestore();
  });

  it("display() verbose prints Findings for dimensions that have them", () => {
    const geneDir = join(tempDir, "sparse-gene");
    mkdirSync(geneDir);
    writeFileSync(join(geneDir, "phenotype.json"), JSON.stringify({ name: "sparse-gene" }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const out = express({ genesDir: tempDir, verbose: true });
    display(out, { verbose: true });
    const joined = logSpy.mock.calls.map((c) => stripAnsi(String(c[0]))).join("\n");
    expect(joined).toContain("Findings:");
    logSpy.mockRestore();
  });

  it("display() shows status icons from dimension scores", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    display({
      summary: "test",
      overallScore: 0.5,
      geneCount: 1,
      recommendations: ["do something"],
      dimensions: [
        { name: "High", score: 0.9, findings: [], suggestions: [] },
        { name: "Mid", score: 0.5, findings: [], suggestions: [] },
        { name: "Low", score: 0.2, findings: [], suggestions: [] },
      ],
    });
    const joined = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(joined).toContain("✓");
    expect(joined).toContain("!");
    expect(joined).toContain("✗");
    logSpy.mockRestore();
  });
});
