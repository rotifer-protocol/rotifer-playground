// Bring-Your-Own-WASM e2e — proves the IR layer is language-agnostic.
//
// The Rotifer IR specification treats WASM as the universal frontend; the
// CLI's TypeScript+Javy path is just one of many possible front-ends. This
// suite locks that contract into CI by feeding two hand-rolled fixtures
// (Rotifer-style `express(i32,i32)->i32` + memory, and WASI-style `_start` +
// memory) through `rotifer compile --wasm` and asserting the IR pipeline
// accepts them.
//
// Reference: https://rotifer.dev/docs/guides/polyglot-genes/

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const FIXTURES = join(__dirname, "..", "fixtures", "polyglot");
const RUST_FIXTURE = join(FIXTURES, "rust-style", "gene.wasm");
const AS_FIXTURE = join(FIXTURES, "as-style", "gene.wasm");

function run(
  args: string,
  cwd: string,
  timeout = 15000,
): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || "") + (err.stderr || ""),
      exitCode: err.status ?? 1,
    };
  }
}

function makeProject(geneName: string): string {
  const dir = join(tmpdir(), "rotifer-polyglot-" + randomUUID());
  mkdirSync(join(dir, "genes", geneName), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "polyglot-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    }),
  );
  writeFileSync(
    join(dir, "genes", geneName, "phenotype.json"),
    JSON.stringify(
      {
        domain: "general.text",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
        version: "0.1.0",
        fidelity: "Wrapped",
        transparency: "Open",
      },
      null,
      2,
    ),
  );
  return dir;
}

describe("Polyglot BYO-WASM compilation", () => {
  let projectDir: string;

  afterEach(() => {
    if (projectDir && existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("Rust-style fixture: 56-byte module exports express(i32,i32)->i32 + memory", async () => {
    expect(existsSync(RUST_FIXTURE)).toBe(true);
    const bytes = readFileSync(RUST_FIXTURE);
    expect(bytes.length).toBeGreaterThan(0);

    const mod = await WebAssembly.compile(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.find((e) => e.name === "express" && e.kind === "function")).toBeTruthy();
    expect(exports.find((e) => e.name === "memory" && e.kind === "memory")).toBeTruthy();
  });

  it("AssemblyScript/WASI-style fixture: 50-byte module exports _start + memory", async () => {
    expect(existsSync(AS_FIXTURE)).toBe(true);
    const bytes = readFileSync(AS_FIXTURE);
    expect(bytes.length).toBeGreaterThan(0);

    const mod = await WebAssembly.compile(bytes);
    const exports = WebAssembly.Module.exports(mod);
    expect(exports.find((e) => e.name === "_start" && e.kind === "function")).toBeTruthy();
    expect(exports.find((e) => e.name === "memory" && e.kind === "memory")).toBeTruthy();
  });

  it("compile --wasm accepts Rust-style fixture and produces gene.ir.wasm", () => {
    projectDir = makeProject("rust-gene");
    const wasmTarget = join(projectDir, "rust-style.wasm");
    copyFileSync(RUST_FIXTURE, wasmTarget);

    const { stdout, exitCode } = run(
      `compile rust-gene --wasm ${wasmTarget}`,
      projectDir,
    );

    // Both NAPI-native and TS-fallback compile paths should succeed for a
    // valid minimal WASM. The fallback writes raw WASM as-is.
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Native|Rotifer IR/);
    expect(stdout).toContain("Using pre-compiled WASM");
    expect(existsSync(join(projectDir, "genes", "rust-gene", "gene.ir.wasm"))).toBe(true);

    const result = JSON.parse(
      readFileSync(
        join(projectDir, "genes", "rust-gene", ".compile-result.json"),
        "utf-8",
      ),
    );
    expect(result.fidelity).toBe("Native");
    expect(result.wasmAvailable).toBe(true);
    expect(result.irHash).toBeTruthy();
    expect(result.wasmSize).toBeGreaterThan(0);
  });

  it("compile --wasm accepts WASI-style fixture and produces gene.ir.wasm", () => {
    projectDir = makeProject("as-gene");
    const wasmTarget = join(projectDir, "as-style.wasm");
    copyFileSync(AS_FIXTURE, wasmTarget);

    const { stdout, exitCode } = run(
      `compile as-gene --wasm ${wasmTarget}`,
      projectDir,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Native|Rotifer IR/);
    expect(stdout).toContain("Using pre-compiled WASM");
    expect(existsSync(join(projectDir, "genes", "as-gene", "gene.ir.wasm"))).toBe(true);

    const result = JSON.parse(
      readFileSync(
        join(projectDir, "genes", "as-gene", ".compile-result.json"),
        "utf-8",
      ),
    );
    expect(result.fidelity).toBe("Native");
    expect(result.wasmAvailable).toBe(true);
    expect(result.irHash).toBeTruthy();
  });

  it("Rust and AssemblyScript fixtures produce distinct IR hashes", () => {
    // Same domain + version, same compiler — only the WASM bytes differ. The IR
    // hash must therefore depend on WASM contents (not just phenotype), proving
    // the IR layer round-trips both source languages independently.
    projectDir = makeProject("rust-gene");
    copyFileSync(RUST_FIXTURE, join(projectDir, "rust.wasm"));
    const r1 = run(`compile rust-gene --wasm ${join(projectDir, "rust.wasm")}`, projectDir);
    expect(r1.exitCode).toBe(0);
    const rustResult = JSON.parse(
      readFileSync(
        join(projectDir, "genes", "rust-gene", ".compile-result.json"),
        "utf-8",
      ),
    );

    rmSync(projectDir, { recursive: true, force: true });
    projectDir = makeProject("as-gene");
    copyFileSync(AS_FIXTURE, join(projectDir, "as.wasm"));
    const r2 = run(`compile as-gene --wasm ${join(projectDir, "as.wasm")}`, projectDir);
    expect(r2.exitCode).toBe(0);
    const asResult = JSON.parse(
      readFileSync(
        join(projectDir, "genes", "as-gene", ".compile-result.json"),
        "utf-8",
      ),
    );

    expect(rustResult.irHash).toBeTruthy();
    expect(asResult.irHash).toBeTruthy();
    expect(rustResult.irHash).not.toBe(asResult.irHash);
  });
});
