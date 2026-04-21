import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  detectSourceLanguage,
  isValidSourceLanguage,
} from "../../src/utils/detect-source-language";

function makeDir(): string {
  const dir = join(tmpdir(), "rotifer-detect-" + randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("detectSourceLanguage", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeDir();
  });

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns 'typescript' when index.ts is present", () => {
    writeFileSync(join(dir, "index.ts"), "export function express() {}");
    expect(detectSourceLanguage(dir)).toBe("typescript");
  });

  it("returns 'typescript' when only index.js is present", () => {
    writeFileSync(join(dir, "index.js"), "exports.express = () => {}");
    expect(detectSourceLanguage(dir)).toBe("typescript");
  });

  it("returns 'rust' when Cargo.toml is present", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'foo'");
    expect(detectSourceLanguage(dir)).toBe("rust");
  });

  it("returns 'assemblyscript' when assembly/index.ts is present", () => {
    mkdirSync(join(dir, "assembly"));
    writeFileSync(join(dir, "assembly", "index.ts"), "export function express(): i32 { return 0 }");
    expect(detectSourceLanguage(dir)).toBe("assemblyscript");
  });

  it("returns 'assemblyscript' when only asconfig.json is present", () => {
    writeFileSync(join(dir, "asconfig.json"), "{}");
    expect(detectSourceLanguage(dir)).toBe("assemblyscript");
  });

  it("returns 'go' when go.mod is present", () => {
    writeFileSync(join(dir, "go.mod"), "module example.com/foo");
    expect(detectSourceLanguage(dir)).toBe("go");
  });

  it("returns 'c' when a .c file is at the root", () => {
    writeFileSync(join(dir, "gene.c"), "int express() { return 0; }");
    expect(detectSourceLanguage(dir)).toBe("c");
  });

  it("returns 'c' for .cpp / .cc / .h / .hpp files at root", () => {
    writeFileSync(join(dir, "gene.cpp"), "extern \"C\" int express() { return 0; }");
    expect(detectSourceLanguage(dir)).toBe("c");
  });

  it("returns 'external' when only gene.wasm exists with no source", () => {
    writeFileSync(join(dir, "gene.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    expect(detectSourceLanguage(dir)).toBe("external");
  });

  it("returns 'external' when only gene.ir.wasm exists", () => {
    writeFileSync(join(dir, "gene.ir.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    expect(detectSourceLanguage(dir)).toBe("external");
  });

  it("returns 'unknown' for an empty directory", () => {
    expect(detectSourceLanguage(dir)).toBe("unknown");
  });

  it("priority: index.ts wins over Cargo.toml when both exist", () => {
    writeFileSync(join(dir, "index.ts"), "export function express() {}");
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'foo'");
    expect(detectSourceLanguage(dir)).toBe("typescript");
  });

  it("priority: Cargo.toml wins over assembly/index.ts when both exist", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'foo'");
    mkdirSync(join(dir, "assembly"));
    writeFileSync(join(dir, "assembly", "index.ts"), "export function express(): i32 { return 0 }");
    expect(detectSourceLanguage(dir)).toBe("rust");
  });

  it("priority: source files win over gene.wasm (wasm is fallback for source-less BYO)", () => {
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname = 'foo'");
    writeFileSync(join(dir, "gene.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    expect(detectSourceLanguage(dir)).toBe("rust");
  });

  it("returns 'unknown' for non-existent directory (does not throw)", () => {
    expect(detectSourceLanguage(join(dir, "does-not-exist"))).toBe("unknown");
  });
});

describe("isValidSourceLanguage", () => {
  it("accepts all canonical values", () => {
    const valid = [
      "typescript",
      "rust",
      "assemblyscript",
      "go",
      "c",
      "external",
      "unknown",
    ];
    for (const v of valid) {
      expect(isValidSourceLanguage(v)).toBe(true);
    }
  });

  it("rejects invalid values", () => {
    expect(isValidSourceLanguage("python")).toBe(false);
    expect(isValidSourceLanguage("Java")).toBe(false);
    expect(isValidSourceLanguage("")).toBe(false);
    expect(isValidSourceLanguage("rust ")).toBe(false);
  });

  it("is case-sensitive (rejects 'TypeScript')", () => {
    expect(isValidSourceLanguage("TypeScript")).toBe(false);
  });
});
