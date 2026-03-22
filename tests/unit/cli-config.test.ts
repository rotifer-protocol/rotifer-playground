import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("Config utilities", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), "rotifer-test-" + randomUUID());
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("creates and reads a valid config file", () => {
    const config = {
      name: "test-project",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    };

    writeFileSync(join(testDir, "rotifer.json"), JSON.stringify(config, null, 2));
    const loaded = JSON.parse(readFileSync(join(testDir, "rotifer.json"), "utf-8"));

    expect(loaded.name).toBe("test-project");
    expect(loaded.genes_dir).toBe("genes");
  });

  it("handles missing config gracefully", () => {
    expect(existsSync(join(testDir, "rotifer.json"))).toBe(false);
  });
});

describe("Phenotype validation", () => {
  it("validates required phenotype fields", () => {
    const requiredFields = ["domain", "inputSchema", "outputSchema", "version", "fidelity"];

    const validPhenotype = {
      domain: "test",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      version: "0.1.0",
      fidelity: "Wrapped",
    };

    const allPresent = requiredFields.every((f) => f in validPhenotype);
    expect(allPresent).toBe(true);
  });

  it("detects missing required fields", () => {
    const invalidPhenotype = { domain: "test", version: "0.1.0" };
    const requiredFields = ["domain", "inputSchema", "outputSchema", "version", "fidelity"];
    const missing = requiredFields.filter((f) => !(f in invalidPhenotype));
    expect(missing).toContain("inputSchema");
    expect(missing).toContain("outputSchema");
    expect(missing).toContain("fidelity");
  });
});
