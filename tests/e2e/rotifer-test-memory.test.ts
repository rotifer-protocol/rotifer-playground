/**
 * `rotifer test` of a gene that uses agent memory: the gene gets a
 * throwaway agent memory on rotifer-napi's store, in a directory under the
 * system temp dir that is removed afterwards — never ctx without memory
 * (that was a TypeError), and nothing in the project.
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tryLoadBinding } from "../../src/utils/binding.js";
import { describeWithNativeMemory } from "../fixtures/memory/native-memory.js";
import { memoryGeneWasm, readRequest, writeRequest } from "../fixtures/memory/wasm-memory-gene.js";
import { cliEnv } from "../fixtures/memory/cli.js";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "index.js");
const DEMOS = ["memory-preference-demo", "memory-pattern-demo", "memory-context-demo"];

describeWithNativeMemory("rotifer test gives a memory gene a throwaway agent memory", () => {
  let project: string;
  let scratch: string;

  beforeAll(() => {
    expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
    expect(Boolean((process.features as { typescript?: unknown }).typescript), "Node with TypeScript stripping (22.18+)").toBe(true);
    project = join(tmpdir(), "rotifer-test-memory-project-" + randomUUID());
    // The throwaway memory goes under TMPDIR; point it at a directory of our
    // own so "nothing is left behind" can be checked exactly.
    scratch = join(tmpdir(), "rotifer-test-memory-tmp-" + randomUUID());
    mkdirSync(join(project, "genes"), { recursive: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "t", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "memory.demo" }),
    );
    for (const demo of DEMOS) cpSync(join(ROOT, "genes", demo), join(project, "genes", demo), { recursive: true });

    // A compiled (WASM) gene that writes and reads back through the host functions.
    const dir = join(project, "genes", "wasm-mem-rw");
    mkdirSync(dir, { recursive: true });
    const phenotype = JSON.stringify({ domain: "memory.demo", inputSchema: { type: "object" }, outputSchema: {}, version: "0.1.0", fidelity: "Native" });
    writeFileSync(join(dir, "phenotype.json"), phenotype);
    const wasm = memoryGeneWasm([
      { op: "write", request: writeRequest("wasm/lang", "zh-CN") },
      { op: "read", request: readRequest("wasm/lang") },
    ]);
    tryLoadBinding()!.compileGeneToFile(Buffer.from(wasm), phenotype, join(dir, "gene.ir.wasm"));
    expect(existsSync(join(dir, "gene.ir.wasm"))).toBe(true);
  });
  afterAll(() => {
    rmSync(project, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it.each(DEMOS)("%s: express() and its testsuite run with ctx.memory, and the memory is gone afterwards", (gene) => {
    const result = spawnSync(process.execPath, [CLI, "test", gene], {
      cwd: project,
      env: { ...cliEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      encoding: "utf-8",
    });
    const out = result.stdout + result.stderr;
    expect(out).not.toContain("TypeError");
    expect(out).not.toContain("Cannot destructure");
    expect(out).toContain("express() returned successfully");
    // Its testsuite.json (T1, spec §47.5) runs against the same kind of memory
    // and passes in full — the second case of each suite reads what the first stored.
    expect(out).toContain("§47.5 requirements — positive: met, negative: met, property: met");
    expect(out).not.toContain("would not pass the §47.5 publishing gate");
    expect(out).toContain("tests passed");
    expect(result.status, out).toBe(0);
    // Nothing in the project, nothing left in the temp dir.
    expect(existsSync(join(project, ".rotifer", "playground.db"))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("a compiled gene: executeGene() runs with a memoryContext on the throwaway memory, which is gone afterwards", () => {
    const result = spawnSync(process.execPath, [CLI, "test", "wasm-mem-rw", "--verbose"], {
      cwd: project,
      env: { ...cliEnv, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
      encoding: "utf-8",
    });
    const out = result.stdout + result.stderr;
    expect(out).not.toContain("no agent context");
    expect(out).toContain("executeGene() succeeded");
    expect(existsSync(join(project, ".rotifer", "playground.db"))).toBe(false);
    expect(readdirSync(scratch)).toEqual([]);
  });
});
