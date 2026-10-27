import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { scan } from "../../src/scanner/scanner.js";
import { runPrePublishChecks } from "../../src/publish/pre-publish-check.js";

/**
 * V(g) has rules for TS/JS, shell and Python only. A gene written in Rust
 * (genes/tavily-web-search) was reported as "No code files found
 * (pure-config gene)" and passed the publish check: its src/lib.rs was never
 * read, and the result said the opposite. A file in a language V(g) cannot
 * read is reported as not scanned, never as absent.
 */

let dir: string;

function write(rel: string, content = "") {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
}

function rustGene() {
  write("phenotype.json", JSON.stringify({ domain: "t", version: "0.1.0", fidelity: "Hybrid", description: "rust gene" }));
  write("Cargo.toml", "[package]\nname = \"g\"\n");
  write("build.rs", "fn main() {}\n");
  write("src/lib.rs", "pub fn express() {}\n");
  write("target/debug/build/out.rs", "// generated\n");
}

beforeEach(() => {
  dir = join(tmpdir(), `vg-unscanned-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scan() names the code it could not read", () => {
  it("lists a Rust gene's source as unscanned, by mode, and skips target/", () => {
    rustGene();
    const byDefault = scan(dir);
    expect(byDefault.grade).toBe("?");
    expect(byDefault.unscanned).toEqual(["src/lib.rs"]);
    expect(scan(dir, undefined, { scanAll: true }).unscanned).toEqual(["build.rs", "src/lib.rs"]);
  });

  it("still grades the code it can read, and names the rest", () => {
    write("src/index.ts", "export const x = 1;\n");
    write("src/native.rs", "pub fn f() {}\n");
    const r = scan(dir);
    expect(r.grade).toBe("A");
    expect(r.stats.files_scanned).toBe(1);
    expect(r.unscanned).toEqual(["src/native.rs"]);
  });

  it("adds nothing for a gene whose code it can read", () => {
    write("index.ts", "export const x = 1;\n");
    expect(scan(dir).unscanned).toBeUndefined();
  });
});

describe("the publish check does not call a Rust gene pure-config", () => {
  const vgCheck = () => runPrePublishChecks(dir, "g").checks.find((c) => c.name === "V(g) Security Scan")!;

  it("warns that the code was not scanned, and names it", () => {
    rustGene();
    const check = vgCheck();
    expect(check.status).toBe("warn");
    expect(check.message).not.toMatch(/pure-config/);
    expect(check.message).toMatch(/not scanned/i);
    expect(check.message).toContain("src/lib.rs");
  });

  it("still passes a gene with no code at all", () => {
    write("phenotype.json", JSON.stringify({ domain: "t", version: "0.1.0", fidelity: "Wrapped", description: "prompt" }));
    expect(vgCheck()).toMatchObject({ status: "pass", message: "No code files found (pure-config gene)" });
  });
});
