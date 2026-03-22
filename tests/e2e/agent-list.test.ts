import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
  const dir = join(tmpdir(), "rotifer-agent-list-" + randomUUID());
  mkdirSync(join(dir, "genes", "test-gene"), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "agent-list-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    })
  );
  return dir;
}

let projectDir: string;

beforeEach(() => {
  projectDir = makeProject();
});

afterEach(() => {
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

describe("rotifer agent list", () => {
  it("shows 'no agents' message in empty project", () => {
    const result = run("agent list", projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No agents created yet");
    expect(result.stdout).toContain("rotifer agent create");
  });

  it("lists agents when agents directory has entries", () => {
    const agentsDir = join(projectDir, ".rotifer", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const agentData = {
      id: randomUUID(),
      name: "test-agent",
      state: "ready",
      genome: ["genesis-web-search"],
      createdAt: new Date().toISOString(),
    };
    writeFileSync(join(agentsDir, `${agentData.id}.json`), JSON.stringify(agentData));

    const result = run("agent list", projectDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("test-agent");
    expect(result.stdout).toContain("1 agent(s) registered");
  });
});
