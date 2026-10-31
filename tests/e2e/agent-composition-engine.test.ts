/**
 * A Par / Cond / Try agent never runs as Seq (#450).
 *
 * Those three compositions run only on the Rust algebra executor, which needs
 * the sandbox and every gene compiled. Without it — `--no-sandbox`, or a gene
 * with no gene.ir.wasm — agent run fell through to its sequential loop under
 * the original composition label: Par and Cond returned Seq's result, a Try
 * never reached its handler, and a branch that should not have run did.
 *
 * Each gene here writes a marker file when it runs, which it can only do on
 * the Node path, so "refused before any gene executed" is checked directly.
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
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

const NUMBER_OBJECT = { type: "object", properties: { value: { type: "number" } }, required: ["value"] };

function writeGene(dir: string, name: string, body: string, withMarker: boolean) {
  const gene = join(dir, "genes", name);
  mkdirSync(gene, { recursive: true });
  const marker = JSON.stringify(join(dir, `ran-${name}`));
  const source = withMarker
    ? `import { writeFileSync } from "node:fs";\nexport function express(input) { writeFileSync(${marker}, "ran"); ${body} }\n`
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

function makeProject(withMarker: boolean): string {
  const dir = join(tmpdir(), "rotifer-composition-" + randomUUID());
  mkdirSync(join(dir, ".rotifer", "agents"), { recursive: true });
  writeFileSync(
    join(dir, "rotifer.json"),
    JSON.stringify({ name: "composition", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
  );
  writeGene(dir, "qa-add", "return { value: input.value + 1 };", withMarker);
  writeGene(dir, "qa-double", "return { value: input.value * 2 };", withMarker);
  return dir;
}

const COMPOSITIONS = ["Par", "Cond", "Try"] as const;

describe("agent run keeps the declared composition (#450)", { timeout: 300_000 }, () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("where the algebra executor cannot run it", () => {
    beforeEach(() => {
      dir = makeProject(true);
      for (const composition of [...COMPOSITIONS, "Seq"]) {
        const created = run(`agent create ${composition.toLowerCase()}-agent --genes qa-add qa-double --composition ${composition}`, dir);
        expect(created.exitCode, created.stdout).toBe(0);
      }
    });

    it.each(COMPOSITIONS)("refuses a %s agent under --no-sandbox before any gene runs", (composition) => {
      const result = run(`agent run ${composition.toLowerCase()}-agent --input '{"value":2}' --no-sandbox`, dir);
      expect(result.exitCode, result.stdout).toBe(1);
      expect(result.stdout).toContain(composition);
      expect(result.stdout).toContain("--no-sandbox");
      expect(existsSync(join(dir, "ran-qa-add"))).toBe(false);
      expect(existsSync(join(dir, "ran-qa-double"))).toBe(false);
    });

    it.each(COMPOSITIONS)("refuses a %s agent whose genes are not compiled, instead of running Seq", (composition) => {
      const result = run(`agent run ${composition.toLowerCase()}-agent --input '{"value":2}'`, dir);
      expect(result.exitCode, result.stdout).toBe(1);
      expect(result.stdout).toContain("rotifer compile");
      expect(existsSync(join(dir, "ran-qa-add"))).toBe(false);
      expect(existsSync(join(dir, "ran-qa-double"))).toBe(false);
    });

    it("still runs Seq under --no-sandbox (control)", () => {
      const result = run(`agent run seq-agent --input '{"value":2}' --no-sandbox`, dir);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).toMatch(/"value":\s*6/);
    });
  });

  describe("where it can", () => {
    beforeEach(() => {
      dir = makeProject(false);
    });

    it.skipIf(!hasJavyToolchain || !hasSandbox)("runs Par as Par: the first branch's result, not Seq's", () => {
      for (const gene of ["qa-add", "qa-double"]) {
        const compiled = run(`compile ${gene}`, dir);
        expect(compiled.exitCode, compiled.stdout).toBe(0);
      }
      expect(run("agent create par-agent --genes qa-add qa-double --composition Par", dir).exitCode).toBe(0);
      const result = run(`agent run par-agent --input '{"value":2}'`, dir);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).toMatch(/"value":\s*3/);
    });
  });
});
