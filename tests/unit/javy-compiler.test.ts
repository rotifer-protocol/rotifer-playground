import { describe, it, expect, afterEach } from "vitest";
import { findGeneSource } from "../../src/utils/javy-compiler.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

describe("javy-compiler utilities", () => {
  let tmpDir: string;

  function makeTempDir(): string {
    const dir = join(tmpdir(), "rotifer-javy-unit-" + randomUUID());
    mkdirSync(dir, { recursive: true });
    tmpDir = dir;
    return dir;
  }

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("findGeneSource", () => {
    it("returns index.ts when it exists", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, "index.ts"), "export function express() {}");
      expect(findGeneSource(dir)).toBe(join(dir, "index.ts"));
    });

    it("returns index.js when only JS exists", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, "index.js"), "exports.express = () => ({})");
      expect(findGeneSource(dir)).toBe(join(dir, "index.js"));
    });

    it("prefers index.ts over index.js", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, "index.ts"), "export function express() {}");
      writeFileSync(join(dir, "index.js"), "exports.express = () => ({})");
      expect(findGeneSource(dir)).toBe(join(dir, "index.ts"));
    });

    it("returns null when no source file exists", () => {
      const dir = makeTempDir();
      expect(findGeneSource(dir)).toBeNull();
    });

    it("returns null for directory with phenotype.json only", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, "phenotype.json"), "{}");
      expect(findGeneSource(dir)).toBeNull();
    });
  });
});
