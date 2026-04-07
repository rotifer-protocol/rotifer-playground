import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CLI = "node dist/index.js";

function cli(args: string): string {
  return execSync(`${CLI} ${args}`, { cwd: ROOT, encoding: "utf-8", timeout: 15_000 });
}

function cliAll(args: string): string {
  try {
    return execSync(`${CLI} ${args}`, { cwd: ROOT, encoding: "utf-8", timeout: 15_000 });
  } catch (err: any) {
    return (err.stderr || "") + (err.stdout || "");
  }
}

const PREFIX = "test.schema.";
const createdGenes: string[] = [];

function makeGene(name: string, input: Record<string, unknown>, output: Record<string, unknown>) {
  const dir = join(ROOT, "genes", name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phenotype.json"), JSON.stringify({
    domain: "test",
    fidelity: "Wrapped",
    version: "0.1.0",
    inputSchema: { type: "object", properties: input, required: Object.keys(input) },
    outputSchema: { type: "object", properties: output },
  }, null, 2) + "\n");
  writeFileSync(join(dir, "index.ts"), `export function express(input: any) { return input; }\n`);
  createdGenes.push(name);
}

function cleanup(...names: string[]) {
  for (const name of names) {
    const dir = join(ROOT, "genes", name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  cleanup(...createdGenes);
  createdGenes.length = 0;
});

describe("Agent Schema Compatibility", () => {
  it("compatible schema pair: no warnings", () => {
    const a = `${PREFIX}producer-ok`;
    const b = `${PREFIX}consumer-ok`;
    makeGene(a, { query: { type: "string" } }, { result: { type: "string" }, score: { type: "number" } });
    makeGene(b, { result: { type: "string" } }, { final: { type: "string" } });
    const out = cliAll(`agent create ${PREFIX}compat-test --genes ${a} ${b} --composition Seq`);
    expect(out).not.toContain("lacks");
    expect(out).toMatch(/created|Agent/);
  });

  it("incompatible schema: warns about missing required fields", () => {
    const a = `${PREFIX}producer-bad`;
    const b = `${PREFIX}consumer-need`;
    makeGene(a, { query: { type: "string" } }, { answer: { type: "string" } });
    makeGene(b, { answer: { type: "string" }, confidence: { type: "number" } }, { final: { type: "string" } });
    const out = cliAll(`agent create ${PREFIX}incompat-test --genes ${a} ${b} --composition Seq`);
    expect(out).toMatch(/confidence|lacks/);
  });

  it("single gene: no schema check (no adjacent pair)", () => {
    const a = `${PREFIX}single`;
    makeGene(a, { text: { type: "string" } }, { result: { type: "string" } });
    const out = cliAll(`agent create ${PREFIX}single-test --genes ${a}`);
    expect(out).not.toContain("lacks");
    expect(out).toMatch(/created|Agent/);
  });

  it("3-gene chain: validates all adjacent pairs", () => {
    const a = `${PREFIX}chain-a`;
    const b = `${PREFIX}chain-b`;
    const c = `${PREFIX}chain-c`;
    makeGene(a, { input: { type: "string" } }, { mid: { type: "string" } });
    makeGene(b, { mid: { type: "string" } }, { output: { type: "string" } });
    makeGene(c, { output: { type: "string" }, extra: { type: "number" } }, { final: { type: "string" } });
    const out = cliAll(`agent create ${PREFIX}chain-test --genes ${a} ${b} ${c} --composition Seq`);
    expect(out).toMatch(/extra|lacks/);
  });

  it("empty required array: consumer accepts any input, no warning", () => {
    const a = `${PREFIX}any-out`;
    const b = `${PREFIX}any-in`;
    makeGene(a, { x: { type: "string" } }, { y: { type: "string" } });
    const dir = join(ROOT, "genes", b);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "phenotype.json"), JSON.stringify({
      domain: "test",
      fidelity: "Wrapped",
      version: "0.1.0",
      inputSchema: { type: "object", properties: { z: { type: "string" } }, required: [] },
      outputSchema: { type: "object", properties: { final: { type: "string" } } },
    }, null, 2) + "\n");
    writeFileSync(join(dir, "index.ts"), `export function express(input: any) { return input; }\n`);
    createdGenes.push(b);
    const out = cliAll(`agent create ${PREFIX}anyin-test --genes ${a} ${b} --composition Seq`);
    expect(out).not.toContain("lacks");
  });
});
