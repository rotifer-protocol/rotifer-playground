import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const TEST_HOME = join(tmpdir(), `rotifer-ds-test-${Date.now()}`);

beforeEach(() => {
  process.env.HOME = TEST_HOME;
  vi.resetModules();
});

afterEach(() => {
  if (existsSync(TEST_HOME)) rmSync(TEST_HOME, { recursive: true });
});

async function loadModule() {
  return import("../../src/utils/domain-suggest.js");
}

function writeCacheFile(domains: Array<{ domain: string; gene_count: number; description?: string }>) {
  const dir = join(TEST_HOME, ".rotifer");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "domain_registry.json"),
    JSON.stringify({ updated_at: Date.now(), domains }),
  );
}

describe("domain-suggest", () => {
  describe("loadDomainCache", () => {
    it("returns empty array when no cache file exists", async () => {
      const { loadDomainCache } = await loadModule();
      expect(loadDomainCache()).toEqual([]);
    });

    it("returns cached domains when file exists", async () => {
      const domains = [
        { domain: "sim.particle", gene_count: 3 },
        { domain: "evolve.life", gene_count: 3 },
      ];
      writeCacheFile(domains);
      const { loadDomainCache } = await loadModule();
      expect(loadDomainCache()).toEqual(domains);
    });

    it("returns domains even if cache is expired (graceful degradation)", async () => {
      const dir = join(TEST_HOME, ".rotifer");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "domain_registry.json"),
        JSON.stringify({ updated_at: 0, domains: [{ domain: "old", gene_count: 1 }] }),
      );
      const { loadDomainCache } = await loadModule();
      expect(loadDomainCache()).toHaveLength(1);
    });

    it("returns empty array on malformed JSON", async () => {
      const dir = join(TEST_HOME, ".rotifer");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "domain_registry.json"), "not json");
      const { loadDomainCache } = await loadModule();
      expect(loadDomainCache()).toEqual([]);
    });
  });

  describe("saveDomainCache", () => {
    it("creates .rotifer dir and writes cache file", async () => {
      const { saveDomainCache, loadDomainCache } = await loadModule();
      saveDomainCache([{ domain: "test.domain", gene_count: 5 }]);
      const loaded = loadDomainCache();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].domain).toBe("test.domain");
    });
  });

  describe("suggestDomains", () => {
    it("returns empty when cache is empty", async () => {
      const { suggestDomains } = await loadModule();
      expect(suggestDomains("particle-sim")).toEqual([]);
    });

    it("matches gene name keywords to domain parts", async () => {
      writeCacheFile([
        { domain: "sim.particle", gene_count: 3, description: "particle simulation" },
        { domain: "evolve.life", gene_count: 3, description: "life evolution" },
        { domain: "media.video", gene_count: 5, description: "video generation" },
      ]);
      const { suggestDomains } = await loadModule();

      const results = suggestDomains("particle-sim");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].domain).toBe("sim.particle");
    });

    it("uses description for additional keyword matching", async () => {
      writeCacheFile([
        { domain: "content.translation", gene_count: 2, description: "translate content between languages" },
        { domain: "code.debug", gene_count: 1, description: "debugging tools" },
      ]);
      const { suggestDomains } = await loadModule();

      const results = suggestDomains("my-translator", "translate documents");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].domain).toBe("content.translation");
    });

    it("respects limit parameter", async () => {
      writeCacheFile([
        { domain: "sim.particle", gene_count: 3 },
        { domain: "sim.fluid", gene_count: 2 },
        { domain: "sim.gravity", gene_count: 1 },
      ]);
      const { suggestDomains } = await loadModule();
      const results = suggestDomains("sim-thing", undefined, 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it("returns empty for names with only short/stop words", async () => {
      writeCacheFile([{ domain: "test", gene_count: 1 }]);
      const { suggestDomains } = await loadModule();
      expect(suggestDomains("a-b")).toEqual([]);
    });

    it("higher gene_count provides a tiebreaker boost", async () => {
      writeCacheFile([
        { domain: "code.api", gene_count: 1 },
        { domain: "code.architecture", gene_count: 10 },
      ]);
      const { suggestDomains } = await loadModule();
      const results = suggestDomains("code-helper");
      expect(results.length).toBe(2);
      expect(results[0].domain).toBe("code.architecture");
    });
  });
});
