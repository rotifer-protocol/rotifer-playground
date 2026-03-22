import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { findProjectRoot, loadConfig, saveConfig, getProjectRoot } from "../../src/utils/config.js";

let testDir: string;

const SAMPLE_CONFIG = {
  name: "test-project",
  version: "0.1.0",
  author: "tester",
  genes_dir: "genes",
  default_domain: "general",
};

beforeEach(() => {
  testDir = join(tmpdir(), "rotifer-config-test-" + randomUUID());
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("findProjectRoot", () => {
  it("returns the directory containing rotifer.json", () => {
    writeFileSync(join(testDir, "rotifer.json"), JSON.stringify(SAMPLE_CONFIG));
    const subDir = join(testDir, "a", "b", "c");
    mkdirSync(subDir, { recursive: true });

    const root = findProjectRoot(subDir);
    expect(root).toBe(testDir);
  });

  it("returns null when no rotifer.json exists", () => {
    const isolatedDir = join(tmpdir(), "rotifer-no-config-" + randomUUID());
    mkdirSync(isolatedDir, { recursive: true });
    const root = findProjectRoot(isolatedDir);
    expect(root).toBeNull();
    rmSync(isolatedDir, { recursive: true, force: true });
  });
});

describe("loadConfig", () => {
  it("loads and parses rotifer.json from given directory", () => {
    writeFileSync(join(testDir, "rotifer.json"), JSON.stringify(SAMPLE_CONFIG));
    const config = loadConfig(testDir);
    expect(config.name).toBe("test-project");
    expect(config.version).toBe("0.1.0");
    expect(config.genes_dir).toBe("genes");
  });

  it("throws when no config file is found", () => {
    const emptyDir = join(tmpdir(), "rotifer-empty-" + randomUUID());
    mkdirSync(emptyDir, { recursive: true });
    expect(() => loadConfig(emptyDir)).toThrow();
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe("saveConfig", () => {
  it("writes config as formatted JSON", () => {
    saveConfig(SAMPLE_CONFIG, testDir);
    const raw = readFileSync(join(testDir, "rotifer.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe("test-project");
    expect(raw).toContain("\n");
    expect(raw.endsWith("\n")).toBe(true);
  });
});

describe("getProjectRoot", () => {
  it("throws when not inside a rotifer project", () => {
    const isolatedDir = join(tmpdir(), "rotifer-no-root-" + randomUUID());
    mkdirSync(isolatedDir, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(isolatedDir);
    try {
      expect(() => getProjectRoot()).toThrow(/rotifer\.json/);
    } finally {
      process.chdir(originalCwd);
      rmSync(isolatedDir, { recursive: true, force: true });
    }
  });
});
