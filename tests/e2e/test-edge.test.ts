import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
function run(args: string, cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 15000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

function makeProject(): string {
  const dir = join(tmpdir(), "rotifer-test-edge-" + randomUUID());
  mkdirSync(join(dir, "genes", "good-gene"), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "test-edge",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    })
  );
  return dir;
}

function writeGene(
  dir: string,
  name: string,
  opts: {
    phenotype?: Record<string, unknown>;
    source?: string;
    noSource?: boolean;
  } = {}
) {
  mkdirSync(join(dir, "genes", name), { recursive: true });

  const phenotype = opts.phenotype || {
    domain: "general",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
    outputSchema: {
      type: "object",
      properties: { greeting: { type: "string" } },
    },
    version: "0.1.0",
    fidelity: "Wrapped",
    transparency: "Open",
  };
  writeFileSync(
    join(dir, "genes", name, "phenotype.json"),
    JSON.stringify(phenotype, null, 2)
  );

  if (!opts.noSource) {
    const source =
      opts.source ||
      `export async function express(input) { return { greeting: "Hi " + input.name }; }\n`;
    writeFileSync(join(dir, "genes", name, "index.js"), source);
  }
}

describe("rotifer test edge cases", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("fails when no gene name is given", () => {
    const { stdout, exitCode } = run("test", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Specify a gene name");
  });

  it("fails when phenotype does not exist", () => {
    mkdirSync(join(projectDir, "genes", "no-pheno"), { recursive: true });
    const { stdout, exitCode } = run("test no-pheno", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Phenotype not found");
  });

  it("happy path: all tests pass for a valid gene", () => {
    writeGene(projectDir, "good-gene");
    const { stdout, exitCode } = run("test good-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("All");
    expect(stdout).toContain("tests passed");
    expect(stdout).toContain("express() returned successfully");
  });

  it("--verbose shows input and output", () => {
    writeGene(projectDir, "good-gene");
    const { stdout, exitCode } = run("test good-gene --verbose", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Input:");
    expect(stdout).toContain("Output:");
  });

  it("fails when express() throws an error", () => {
    writeGene(projectDir, "throw-gene", {
      source: `export async function express(input) { throw new Error("boom"); }\n`,
    });
    const { stdout, exitCode } = run("test throw-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("threw an error");
    expect(stdout).toContain("boom");
  });

  it("fails when express() returns null", () => {
    writeGene(projectDir, "null-gene", {
      source: `export async function express(input) { return null; }\n`,
    });
    const { stdout, exitCode } = run("test null-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("null/undefined");
  });

  it("fails when gene does not export express()", () => {
    writeGene(projectDir, "no-express", {
      source: `export function helper() { return 1; }\n`,
    });
    const { stdout, exitCode } = run("test no-express", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("does not export");
  });

  it("fails when output does not conform to outputSchema", () => {
    writeGene(projectDir, "bad-output", {
      phenotype: {
        domain: "general",
        inputSchema: { type: "object", properties: { x: { type: "string" } } },
        outputSchema: {
          type: "object",
          properties: { count: { type: "integer" } },
          required: ["count"],
        },
        version: "0.1.0",
        fidelity: "Wrapped",
      },
      source: `export async function express(input) { return { wrong: "field" }; }\n`,
    });
    const { stdout, exitCode } = run("test bad-output", projectDir);
    expect(exitCode).not.toBe(0);
    const hasExpectedError =
      stdout.includes("does not conform") ||
      stdout.includes("failed") ||
      stdout.includes("error") ||
      stdout.includes("Error");
    expect(hasExpectedError).toBe(true);
  });
});
