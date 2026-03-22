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
  const dir = join(tmpdir(), "rotifer-run-edge-" + randomUUID());
  mkdirSync(join(dir, "genes"), { recursive: true });
  mkdirSync(join(dir, ".rotifer", "agents"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "run-edge-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    })
  );
  return dir;
}

function writeGene(dir: string, name: string, source?: string) {
  mkdirSync(join(dir, "genes", name), { recursive: true });
  writeFileSync(
    join(dir, "genes", name, "phenotype.json"),
    JSON.stringify({
      domain: "general",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      version: "0.1.0",
      fidelity: "Wrapped",
    }, null, 2)
  );
  if (source !== undefined) {
    writeFileSync(join(dir, "genes", name, "index.js"), source);
  }
}

function writeAgent(
  dir: string,
  name: string,
  genome: string[],
  composition = "Seq"
) {
  const agentId = randomUUID();
  writeFileSync(
    join(dir, ".rotifer", "agents", agentId + ".json"),
    JSON.stringify({
      id: agentId,
      name,
      state: "Active",
      genome,
      composition,
      strategy: "manual",
      createdAt: new Date().toISOString(),
      reputation: 0.0,
    }, null, 2)
  );
}

describe("rotifer agent run edge cases", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("fails when agent does not exist", () => {
    const { stdout, exitCode } = run("agent run ghost-agent", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not found");
  });

  it("fails when agent has empty genome", () => {
    writeAgent(projectDir, "empty-agent", []);
    const { stdout, exitCode } = run("agent run empty-agent", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("empty genome");
  });

  it("fails with invalid --input JSON", () => {
    writeGene(
      projectDir,
      "gene-a",
      `export async function express(input) { return input; }\n`
    );
    writeAgent(projectDir, "my-agent", ["gene-a"]);
    const { stdout, exitCode } = run(
      'agent run my-agent --input "not-json"',
      projectDir
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Invalid --input JSON");
  });

  it("fails when a gene has no source file", () => {
    writeGene(projectDir, "no-src", undefined);
    // no index.ts written (source = undefined skips writing)
    writeAgent(projectDir, "nosrc-agent", ["no-src"]);
    const { stdout, exitCode } = run("agent run nosrc-agent", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("no source file");
  });

  it("fails when gene express() throws", () => {
    writeGene(
      projectDir,
      "boom-gene",
      `export async function express(input) { throw new Error("kaboom"); }\n`
    );
    writeAgent(projectDir, "boom-agent", ["boom-gene"]);
    const { stdout, exitCode } = run("agent run boom-agent", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("execution failed");
    expect(stdout).toContain("kaboom");
  });

  it("executes single gene pipeline successfully", () => {
    writeGene(
      projectDir,
      "echo-gene",
      `export async function express(input) { return { echo: input }; }\n`
    );
    writeAgent(projectDir, "single-agent", ["echo-gene"], "Single");
    const { stdout, exitCode } = run(
      'agent run single-agent --input \'{"hello":"world"}\'',
      projectDir
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pipeline execution complete");
    expect(stdout).toContain("Genes Executed");
    expect(stdout).toContain("1");
    expect(stdout).toContain("hello");
  });

  it("executes Seq pipeline with ≥2 genes — output chains correctly", () => {
    writeGene(
      projectDir,
      "upper-gene",
      `export async function express(input) { return { text: (input.text || "").toUpperCase() }; }\n`
    );
    writeGene(
      projectDir,
      "wrap-gene",
      `export async function express(input) { return { wrapped: "[" + input.text + "]" }; }\n`
    );
    writeAgent(projectDir, "chain-agent", ["upper-gene", "wrap-gene"]);
    const { stdout, exitCode } = run(
      'agent run chain-agent --input \'{"text":"hello"}\'',
      projectDir
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Pipeline execution complete");
    expect(stdout).toContain("Genes Executed");
    expect(stdout).toContain("2");
    expect(stdout).toContain("Seq");
    // Output should be { wrapped: "[HELLO]" } — upper then wrap
    expect(stdout).toContain("[HELLO]");
  });
});
