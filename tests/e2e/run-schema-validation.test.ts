/**
 * `rotifer run` holds a gene to its own schema (#451).
 *
 * run executed whatever it was given and printed whatever came back:
 * `run qa-add --input '{"value":"wrong"}'` answered `"value": "wrong1"`, exit 0,
 * on both the WASM and the Node.js path. Now the input is checked against the
 * phenotype's inputSchema before the gene runs (a mismatch is INVALID_INPUT,
 * spec §4.2, and nothing runs), and the output against outputSchema after (a
 * mismatch fails the run, as the Arena counts it). `--no-validate` turns both
 * off and says so.
 *
 * The Node.js-path genes write a marker file when they run, so "nothing ran"
 * is checked directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { hasJavyToolchain, hasSandbox } from "./toolchain.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, FORCE_COLOR: "0", ROTIFER_AUTO_PUBLISH: "0", ROTIFER_TELEMETRY: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

const NUMBER_OBJECT = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };

describe("rotifer run validates against the gene's schema (#451)", { timeout: 300_000 }, () => {
  let dir: string;
  const marker = (gene: string) => join(dir, `ran-${gene}`);

  function writeGene(name: string, body: string, withMarker = true) {
    const gene = join(dir, "genes", name);
    mkdirSync(gene, { recursive: true });
    const source = withMarker
      ? `import { writeFileSync } from "node:fs";\nexport function express(input) { writeFileSync(${JSON.stringify(marker(name))}, "ran"); ${body} }\n`
      : `export function express(input) { ${body} }\n`;
    writeFileSync(join(gene, "index.ts"), source);
    writeFileSync(
      join(gene, "phenotype.json"),
      JSON.stringify({
        domain: "test.arithmetic",
        version: "0.1.0",
        fidelity: "Wrapped",
        transparency: "Open",
        createdAt: 0,
        inputSchema: NUMBER_OBJECT,
        outputSchema: NUMBER_OBJECT,
      }),
    );
  }

  beforeEach(() => {
    dir = join(tmpdir(), "rotifer-run-schema-" + randomUUID());
    mkdirSync(join(dir, ".rotifer"), { recursive: true });
    writeFileSync(
      join(dir, "rotifer.json"),
      JSON.stringify({ name: "run-schema", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
    );
    writeGene("qa-add", "return { value: input.value + 1 };");
    writeGene("qa-bad-output", 'return { value: "not a number" };');
    writeGene("qa-refuses", 'return { __rotifer_error: { message: "value is out of range" } };');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an input that does not match inputSchema, as INVALID_INPUT, before the gene runs", () => {
    const result = run(`run qa-add --input '{"value":"wrong"}'`, dir);
    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.stdout).toContain("INVALID_INPUT");
    expect(result.stdout).toContain("value");
    expect(result.stdout).not.toContain("wrong1");
    expect(existsSync(marker("qa-add"))).toBe(false);
  });

  it("names a missing required field", () => {
    const result = run(`run qa-add --input '{}'`, dir);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/INVALID_INPUT.*value/);
  });

  it("still runs a valid input", () => {
    const result = run(`run qa-add --input '{"value":2}'`, dir);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toMatch(/"value":\s*3/);
  });

  it("fails a run whose output does not match outputSchema", () => {
    const result = run(`run qa-bad-output --input '{"value":2}'`, dir);
    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.stdout).toContain("outputSchema");
    expect(result.stdout).toContain("value");
    expect(existsSync(marker("qa-bad-output"))).toBe(true);
  });

  it("reads a gene's own refusal as INVALID_INPUT on the Node.js path, as the sandbox does", () => {
    const result = run(`run qa-refuses --input '{"value":2}'`, dir);
    expect(result.exitCode, result.stdout).toBe(1);
    expect(result.stdout).toContain("INVALID_INPUT: value is out of range");
  });

  it("--no-validate skips both checks and says so", () => {
    const bad = run(`run qa-add --input '{"value":"wrong"}' --no-validate`, dir);
    expect(bad.exitCode, bad.stdout).toBe(0);
    expect(bad.stdout).toContain("wrong1");
    expect(bad.stdout).toMatch(/validation is off/i);
    const badOutput = run(`run qa-bad-output --input '{"value":2}' --no-validate`, dir);
    expect(badOutput.exitCode, badOutput.stdout).toBe(0);
  });

  it.skipIf(!hasJavyToolchain || !hasSandbox)("checks the input on the WASM path too", () => {
    writeGene("qa-add", "return { value: input.value + 1 };", false);
    const compiled = run("compile qa-add", dir);
    expect(compiled.exitCode, compiled.stdout).toBe(0);
    const bad = run(`run qa-add --input '{"value":"wrong"}'`, dir);
    expect(bad.exitCode, bad.stdout).toBe(1);
    expect(bad.stdout).toContain("INVALID_INPUT");
    expect(bad.stdout).not.toContain("Running via WASM sandbox");
    const good = run(`run qa-add --input '{"value":2}'`, dir);
    expect(good.exitCode, good.stdout).toBe(0);
    expect(good.stdout).toContain("Running via WASM sandbox");
    expect(good.stdout).toMatch(/"value":\s*3/);
  });
});
