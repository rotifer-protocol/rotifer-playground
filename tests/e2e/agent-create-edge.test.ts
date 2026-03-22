import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
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
  const dir = join(tmpdir(), "rotifer-agent-edge-" + randomUUID());
  mkdirSync(join(dir, "genes"), { recursive: true });
  mkdirSync(join(dir, ".rotifer", "agents"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "agent-edge-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    })
  );
  return dir;
}

function writeGene(dir: string, name: string, domain: string, fidelity = "Wrapped") {
  mkdirSync(join(dir, "genes", name), { recursive: true });
  writeFileSync(
    join(dir, "genes", name, "phenotype.json"),
    JSON.stringify({
      domain,
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      outputSchema: { type: "object" },
      version: "0.1.0",
      fidelity,
      transparency: "Open",
    }, null, 2)
  );
  writeFileSync(
    join(dir, "genes", name, "index.js"),
    `export async function express(input) { return { result: input.q || "ok" }; }\n`
  );
}

describe("rotifer agent create edge cases", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("fails when --genes references a nonexistent gene", () => {
    const { stdout, exitCode } = run(
      "agent create my-agent --genes nonexistent-gene",
      projectDir
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not found");
  });

  it("auto-selects top genes from Arena by domain", () => {
    writeGene(projectDir, "search-a", "search", "Native");
    writeGene(projectDir, "search-b", "search", "Wrapped");
    writeGene(projectDir, "other", "tooling", "Native");

    const { stdout, exitCode } = run(
      "agent create search-agent --domain search",
      projectDir
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Auto-selected");
    expect(stdout).toContain("search-a");
    expect(stdout).toContain("Seq");
    // should not include "other" (different domain)
    expect(stdout).not.toContain("other");
  });

  it("fails when auto-select finds no genes for domain", () => {
    writeGene(projectDir, "gene-a", "tooling");

    const { stdout, exitCode } = run(
      "agent create my-agent --domain nonexistent-domain",
      projectDir
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("No genes found");
  });

  it("--top flag controls number of auto-selected genes", () => {
    writeGene(projectDir, "a", "general", "Native");
    writeGene(projectDir, "b", "general", "Native");
    writeGene(projectDir, "c", "general", "Native");

    const { stdout, exitCode } = run(
      "agent create tri-agent --domain general --top 3",
      projectDir
    );
    expect(exitCode).toBe(0);
    // Should have 3 genes in genome
    expect(stdout).toContain("Seq");

    // Verify the agent JSON was written
    const agentsDir = join(projectDir, ".rotifer", "agents");
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const agent = JSON.parse(readFileSync(join(agentsDir, files[0]), "utf-8"));
    expect(agent.genome).toHaveLength(3);
    expect(agent.composition).toEqual({ type: "Seq" });
    expect(agent.strategy).toBe("greedy");
  });

  it("writes correct agent JSON with manual --genes", () => {
    writeGene(projectDir, "gene-x", "general");
    writeGene(projectDir, "gene-y", "general");

    const { stdout, exitCode } = run(
      "agent create manual-agent --genes gene-x gene-y",
      projectDir
    );
    expect(exitCode).toBe(0);

    const agentsDir = join(projectDir, ".rotifer", "agents");
    const files = readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(1);
    const agent = JSON.parse(readFileSync(join(agentsDir, files[0]), "utf-8"));
    expect(agent.name).toBe("manual-agent");
    expect(agent.genome).toEqual(["gene-x", "gene-y"]);
    expect(agent.state).toBe("Active");
    expect(agent.strategy).toBe("manual");
  });
});
