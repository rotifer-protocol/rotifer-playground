import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
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
      timeout: 30000,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), "rotifer-init-edge-" + randomUUID());
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("rotifer init edge cases", () => {
  it("creates project with default name", () => {
    const result = run("init", testDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Starter Genes");
    expect(result.stdout).not.toContain("Arena Rankings");
    expect(result.stdout).not.toContain("F(g)");
    expect(result.stdout).toContain('Agent workspace "my-agent" is ready!');
    const configPath = join(testDir, "my-agent", "rotifer.json");
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.name).toBe("my-agent");
  });

  it("creates project with --no-genesis (skips genesis genes)", () => {
    const result = run("init no-genesis-proj --no-genesis", testDir);
    expect(result.exitCode).toBe(0);
    const genesDir = join(testDir, "no-genesis-proj", "genes");
    if (existsSync(genesDir)) {
      const { readdirSync } = require("node:fs");
      const genes = readdirSync(genesDir);
      const genesisGenes = genes.filter((g: string) => g.startsWith("genesis-"));
      expect(genesisGenes).toHaveLength(0);
    }
  });

  it("fails when target directory already contains rotifer.json", () => {
    run("init existing-proj", testDir);
    const result = run("init existing-proj", testDir);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toLowerCase()).toMatch(/already exists|overwrite/);
  });

  it("creates project with custom --domain", () => {
    const result = run("init domain-proj --domain search.web", testDir);
    expect(result.exitCode).toBe(0);
    const configPath = join(testDir, "domain-proj", "rotifer.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.default_domain).toBe("search.web");
  });
});
