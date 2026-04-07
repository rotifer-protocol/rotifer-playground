import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  copyFileSync,
  readdirSync,
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
  const dir = join(tmpdir(), "rotifer-hello-" + randomUUID());
  mkdirSync(join(dir, "genes"), { recursive: true });
  mkdirSync(join(dir, ".rotifer", "agents"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "hello-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
    }) + "\n"
  );
  return dir;
}

function addGene(dir: string, name: string, phenotype: Record<string, unknown>): void {
  const geneDir = join(dir, "genes", name);
  mkdirSync(geneDir, { recursive: true });
  writeFileSync(
    join(geneDir, "phenotype.json"),
    JSON.stringify(phenotype, null, 2) + "\n"
  );
  writeFileSync(
    join(geneDir, "index.js"),
    `module.exports.express = function(input) { return { ...input, processed_by: "${name}" }; };\n`
  );
}

describe("rotifer hello", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("shows help with --help", () => {
    const { stdout, exitCode } = run("hello --help", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Interactive agent builder");
    expect(stdout).toContain("--template");
    expect(stdout).toContain("--list-templates");
  });

  it("lists templates with --list-templates", () => {
    const { stdout, exitCode } = run("hello --list-templates", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Available Templates");
    expect(stdout).toContain("quality-advisor");
    expect(stdout).toContain("uiux-diagnosis");
    expect(stdout).toContain("content-analysis");
    expect(stdout).toContain("code-security");
    expect(stdout).toContain("doc-qa");
    expect(stdout).toContain("web3-toolkit");
  });

  it("rejects unknown template ID", () => {
    const { stdout, exitCode } = run("hello --template nonexistent", projectDir);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("not found");
  });

  it("runs a template with --template and --input when genes exist", () => {
    addGene(projectDir, "genesis-web-search", {
      name: "genesis-web-search",
      version: "1.0.0",
      domain: "search",
      fidelity: "Native",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      outputSchema: { type: "object", properties: { results: { type: "array" } } },
    });
    addGene(projectDir, "genesis-web-search-lite", {
      name: "genesis-web-search-lite",
      version: "1.0.0",
      domain: "search",
      fidelity: "Native",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      outputSchema: { type: "object", properties: { results: { type: "array" } } },
    });

    const { stdout, exitCode } = run(
      `hello --template quality-advisor --input '{"query":"test"}'`,
      projectDir
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Execution complete");
    expect(stdout).toContain("Genome Snapshot");
    expect(stdout).not.toContain("Fitness Score");
  });

  it("fails gracefully when no genes are installed", () => {
    const { stdout, exitCode } = run(
      `hello --template quality-advisor --input '{"query":"test"}'`,
      projectDir
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("None of the required genes");
  });

  it("hides protocol insights when directory scan yields no effective input", () => {
    addGene(projectDir, "solidity-parser", {
      name: "solidity-parser",
      version: "0.2.0",
      domain: "web3.analysis",
      fidelity: "Native",
      inputSchema: { type: "object", properties: { source: { type: "string" } } },
      outputSchema: { type: "object", properties: { contracts: { type: "array" } } },
    });
    addGene(projectDir, "vuln-detector", {
      name: "vuln-detector",
      version: "0.2.0",
      domain: "web3.security",
      fidelity: "Native",
      inputSchema: { type: "object", properties: { source: { type: "string" } } },
      outputSchema: { type: "object", properties: { vulnerabilities: { type: "array" } } },
    });
    addGene(projectDir, "audit-reporter", {
      name: "audit-reporter",
      version: "0.2.0",
      domain: "web3.analysis",
      fidelity: "Native",
      inputSchema: { type: "object", properties: { vulnerabilities: { type: "array" } } },
      outputSchema: { type: "object", properties: { report: { type: "string" } } },
    });

    const { stdout, exitCode } = run(
      "hello --template web3-toolkit --dir .",
      projectDir
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("No matching files (.sol) found");
    expect(stdout).not.toContain("Protocol Insights");
    expect(stdout).not.toContain("Fitness Score");
  });

  it("exits non-zero when a template gene fails mid-pipeline", () => {
    const geneDir = join(projectDir, "genes", "gene-health-scanner");
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({
        name: "gene-health-scanner",
        version: "0.2.0",
        domain: "meta.diagnostics",
        fidelity: "Native",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      }, null, 2)
    );
    writeFileSync(
      join(geneDir, "index.js"),
      `module.exports.express = function() { throw new Error("boom"); };\n`
    );

    const { stdout, exitCode } = run(
      `hello --template quality-advisor --input '{"query":"test"}'`,
      projectDir
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("failed");
    expect(stdout).not.toContain("Execution complete");
    expect(stdout).not.toContain("Genome Snapshot");
  });
});
