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

// ─── #57: compile-time async express detection ───────────────────────────────
import {
  detectAsyncExpress,
  compileTypeScriptToWasm,
  AsyncExpressError,
  isWasmStale,
  buildToolchainErrorMessage,
} from "../../src/utils/javy-compiler.js";
import { utimesSync } from "node:fs";

// Local temp-dir helper — the one above is scoped to the first describe block.
const extraTmpDirs: string[] = [];
function makeTempDir2(): string {
  const dir = join(tmpdir(), "rotifer-javy-unit2-" + randomUUID());
  mkdirSync(dir, { recursive: true });
  extraTmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (extraTmpDirs.length) {
    const dir = extraTmpDirs.pop()!;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("detectAsyncExpress (#57)", () => {
  it("flags `export async function express` (the old starter shape)", () => {
    const src = 'export async function express(input: { name: string }): Promise<{ greeting: string }> {\n  return { greeting: "hi" };\n}\n';
    expect(detectAsyncExpress(src)).toBeTruthy();
  });

  it("flags async arrow assignment `export const express = async (…)`", () => {
    expect(detectAsyncExpress("export const express = async (input) => ({ ok: true });")).toBeTruthy();
  });

  it("flags a sync declaration typed as returning Promise", () => {
    expect(detectAsyncExpress("export function express(input: X): Promise<Y> { return doAsync(input); }")).toBeTruthy();
  });

  it("passes the synchronous starter shape", () => {
    const src = 'export function express(input: { name: string }): { greeting: string } {\n  return { greeting: "hi" };\n}\n';
    expect(detectAsyncExpress(src)).toBeNull();
  });

  it("ignores async helpers that are not express()", () => {
    const src = "async function helper() {}\nexport function express(input: any) { return { ok: true }; }\n";
    expect(detectAsyncExpress(src)).toBeNull();
  });

  it("compileTypeScriptToWasm throws AsyncExpressError before any toolchain spawn", () => {
    const dir = makeTempDir2();
    const src = join(dir, "index.ts");
    writeFileSync(src, "export async function express(input: any): Promise<any> { return input; }\n");
    expect(() => compileTypeScriptToWasm(src, join(dir, "gene.wasm"))).toThrow(AsyncExpressError);
    expect(() => compileTypeScriptToWasm(src, join(dir, "gene.wasm"))).toThrow(/synchronous express/i);
  });
});

// ─── #58: stale-WASM detection + toolchain diagnosis ─────────────────────────
describe("isWasmStale (#58)", () => {
  it("true when source is newer than wasm", () => {
    const dir = makeTempDir2();
    const wasm = join(dir, "gene.ir.wasm");
    const src = join(dir, "index.ts");
    writeFileSync(wasm, "w");
    writeFileSync(src, "s");
    const now = Date.now() / 1000;
    utimesSync(wasm, now - 100, now - 100);
    utimesSync(src, now, now);
    expect(isWasmStale(wasm, src)).toBe(true);
  });

  it("false when wasm is newer than source", () => {
    const dir = makeTempDir2();
    const wasm = join(dir, "gene.ir.wasm");
    const src = join(dir, "index.ts");
    writeFileSync(src, "s");
    writeFileSync(wasm, "w");
    const now = Date.now() / 1000;
    utimesSync(src, now - 100, now - 100);
    utimesSync(wasm, now, now);
    expect(isWasmStale(wasm, src)).toBe(false);
  });

  it("false when either file is missing", () => {
    const dir = makeTempDir2();
    expect(isWasmStale(join(dir, "nope.wasm"), join(dir, "nope.ts"))).toBe(false);
  });
});

describe("buildToolchainErrorMessage (#58)", () => {
  it("names each missing tool, the active npx, and exact install commands", () => {
    const msg = buildToolchainErrorMessage({ esbuild: null, javy: null });
    expect(msg).toMatch(/esbuild:\s+missing/);
    expect(msg).toMatch(/javy:\s+missing/);
    expect(msg).toMatch(/active npx:/);
    expect(msg).toMatch(/npm i -g esbuild javy-cli/);
    expect(msg).toMatch(/binary named `javy`/);
  });

  it("reports a resolved tool with the command that worked", () => {
    const msg = buildToolchainErrorMessage({ esbuild: ["npx", "--no-install", "esbuild"], javy: null });
    expect(msg).toMatch(/esbuild:\s+ok/);
    expect(msg).toMatch(/javy:\s+missing/);
  });
});
