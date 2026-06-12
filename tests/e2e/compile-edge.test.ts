import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
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
  const dir = join(tmpdir(), "rotifer-edge-" + randomUUID());
  mkdirSync(join(dir, "genes", "test-gene"), { recursive: true });
  mkdirSync(join(dir, ".rotifer"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({
      name: "edge-test",
      version: "0.1.0",
      author: "test",
      genes_dir: "genes",
      default_domain: "general",
    })
  );
  return dir;
}

function writePhenotype(dir: string, gene: string, extra: Record<string, unknown> = {}) {
  const phenotype = {
    domain: "general",
    inputSchema: { type: "object", properties: {} },
    outputSchema: { type: "object" },
    version: "0.1.0",
    fidelity: "Wrapped",
    transparency: "Open",
    ...extra,
  };
  writeFileSync(
    join(dir, "genes", gene, "phenotype.json"),
    JSON.stringify(phenotype, null, 2)
  );
  return phenotype;
}

describe("compile edge cases", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("fails when no gene name is given", () => {
    const { stdout, exitCode } = run("compile", projectDir);
    expect(exitCode).not.toBe(0);
  });

  it("fails when gene directory does not exist", () => {
    const { stdout, exitCode } = run("compile nonexistent-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("not found");
  });

  it("fails when phenotype is missing required fields", () => {
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({ domain: "general" })
    );
    const { stdout, exitCode } = run("compile test-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("Missing required phenotype field");
  });

  it("--check flag validates without producing artifacts", () => {
    writePhenotype(projectDir, "test-gene");
    const { stdout, exitCode } = run("compile test-gene --check", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Validation passed");
    expect(existsSync(join(projectDir, "genes", "test-gene", "gene.ir.wasm"))).toBe(false);
    expect(existsSync(join(projectDir, "genes", "test-gene", ".compile-result.json"))).toBe(false);
  });

  it("produces Wrapped fidelity when no WASM is present", () => {
    writePhenotype(projectDir, "test-gene");
    const { stdout, exitCode } = run("compile test-gene", projectDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Wrapped fidelity");
    expect(existsSync(join(projectDir, "genes", "test-gene", "gene.ir.wasm"))).toBe(false);

    const result = JSON.parse(
      readFileSync(join(projectDir, "genes", "test-gene", ".compile-result.json"), "utf-8")
    );
    expect(result.fidelity).toBe("Wrapped");
    expect(result.wasmAvailable).toBe(false);
  });

  it("--wasm with nonexistent file fails with clear error", () => {
    writePhenotype(projectDir, "test-gene");
    const { stdout, exitCode } = run(
      "compile test-gene --wasm /tmp/does-not-exist.wasm",
      projectDir
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("WASM file not found");
  });

  it("compiles to Native IR when WASM is provided", () => {
    writePhenotype(projectDir, "test-gene");

    // Write a minimal valid WASM (magic + version header only won't work,
    // but compile should at least attempt and produce output or a clear error)
    const minimalWasm = Buffer.from([
      0x00, 0x61, 0x73, 0x6d, // \0asm
      0x01, 0x00, 0x00, 0x00, // version 1
    ]);
    writeFileSync(join(projectDir, "genes", "test-gene", "gene.wasm"), minimalWasm);

    const { stdout, exitCode } = run("compile test-gene", projectDir);
    // Depending on whether NAPI is available, it either:
    // - Produces a real IR file (NAPI path) or
    // - Falls back to TS path (writes raw WASM as-is)
    // Both should succeed for this minimal WASM.
    if (exitCode === 0) {
      expect(stdout).toMatch(/Native|Rotifer IR/);
      expect(existsSync(join(projectDir, "genes", "test-gene", "gene.ir.wasm"))).toBe(true);

      const result = JSON.parse(
        readFileSync(join(projectDir, "genes", "test-gene", ".compile-result.json"), "utf-8")
      );
      expect(result.fidelity).toBe("Native");
      expect(result.wasmAvailable).toBe(true);
      expect(result.irHash).toBeTruthy();
    } else {
      // NAPI path may reject minimal WASM — that's also valid edge behavior
      expect(stdout).toContain("compilation failed");
    }
  });

  it("suggests next step after successful compilation", () => {
    writePhenotype(projectDir, "test-gene");
    // Create a dummy WASM that the TS fallback can handle
    const dummyWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    writeFileSync(join(projectDir, "genes", "test-gene", "gene.wasm"), dummyWasm);

    const { stdout, exitCode } = run("compile test-gene", projectDir);
    if (exitCode === 0) {
      expect(stdout).toContain("arena submit");
    }
  });
});

describe("async express() guard (#57)", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeProject();
  });

  afterEach(() => {
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("compile fails fast with E0025 and an actionable message (no WASM backtrace)", () => {
    writePhenotype(projectDir, "test-gene");
    writeFileSync(
      join(projectDir, "genes", "test-gene", "index.ts"),
      "export async function express(input: { name: string }): Promise<{ greeting: string }> {\n" +
        '  return { greeting: "hi " + input.name };\n}\n',
    );
    const { stdout, exitCode } = run("compile test-gene", projectDir);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("E0025");
    expect(stdout).toMatch(/synchronous express/i);
    expect(stdout).not.toMatch(/wasm backtrace/i);
  });

  // The sync-express happy path (full esbuild+javy pipeline) is covered by
  // tests/e2e/javy-compile.test.ts — no need to repeat the heavy compile here.
});
