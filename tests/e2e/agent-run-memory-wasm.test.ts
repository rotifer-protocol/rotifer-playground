/**
 * The WASM path of `rotifer agent run` gives compiled genes their agent's
 * memory: the host functions
 * rotifer.writeMemory / readMemory act on the agent's memory in the
 * project's `.rotifer/playground.db`, as the calling gene's v2 id —
 * through executeGene (Single / Seq, TryPool) and executeAlgebra (fully
 * compiled Par, Cond and Try).
 *
 * The genes are hand-encoded WASM (tests/fixtures/memory/wasm-memory-gene.ts)
 * with the same ABI as rotifer-napi's own test guest.
 */
import { it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { geneIdV2, tryLoadBinding } from "../../src/utils/binding.js";
import type { MemoryEntryJson } from "../../src/memory/types.js";
import { describeWithNativeMemory, openNativeMemory } from "../fixtures/memory/native-memory.js";
import { cliEnv, finalOutput } from "../fixtures/memory/cli.js";
import { memoryGeneWasm, readRequest, writeRequest, type MemoryCall } from "../fixtures/memory/wasm-memory-gene.js";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "index.js");
const b64 = (s: string) => Buffer.from(s).toString("base64");

const GENES: Record<string, MemoryCall[]> = {
  "wasm-mem-rw": [
    { op: "write", request: writeRequest("wasm/lang", "zh-CN") },
    { op: "read", request: readRequest("wasm/lang") },
  ],
  "wasm-mem-writer": [{ op: "write", request: writeRequest("wasm/tone", "brief") }],
  "wasm-mem-reader": [{ op: "read", request: readRequest("wasm/tone") }],
  "wasm-mem-writer-a": [{ op: "write", request: writeRequest("wasm/pool/a", "A") }],
  "wasm-mem-writer-b": [{ op: "write", request: writeRequest("wasm/pool/b", "B") }],
};

describeWithNativeMemory("agent run gives compiled (WASM) genes their agent's memory", () => {
  let project: string;
  const ids: Record<string, string> = {};
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: project, env: cliEnv, encoding: "utf-8" });
  const agentId = (name: string) => {
    const dir = join(project, ".rotifer", "agents");
    const file = readdirSync(dir).find((f) => /^[^.]+\.json$/.test(f) && JSON.parse(readFileSync(join(dir, f), "utf-8")).name === name);
    expect(file, name).toBeDefined();
    return file!.replace(/\.json$/, "");
  };
  const stored = (name: string) =>
   (openNativeMemory(project)!.memoryGet(agentId(name)) as { entries: MemoryEntryJson[] }).entries
      .map((e) => [e.key, Buffer.from(e.value, "base64").toString("utf8"), e.createdBy])
      .sort();

  beforeAll(() => {
    expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
    project = join(tmpdir(), "rotifer-agent-run-memory-wasm-" + randomUUID());
    mkdirSync(join(project, "genes"), { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "wasm-memory", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "memory.demo" }),
    );
    const compiler = tryLoadBinding()!;
    for (const [name, calls] of Object.entries(GENES)) {
      const dir = join(project, "genes", name);
      mkdirSync(dir, { recursive: true });
      const phenotype = JSON.stringify({ domain: "memory.demo", inputSchema: { type: "object" }, outputSchema: {}, version: "0.1.0", fidelity: "Native" });
      writeFileSync(join(dir, "phenotype.json"), phenotype);
      // The compiler's IR step (custom sections, verification), as `rotifer compile` runs it.
      const compiled = compiler.compileGeneToFile(Buffer.from(memoryGeneWasm(calls)), phenotype, join(dir, "gene.ir.wasm"));
      expect(existsSync(join(dir, "gene.ir.wasm")), `${name}: ${JSON.stringify(compiled)}`).toBe(true);
      const id = geneIdV2(join(project, "genes"), name);
      expect("id" in id, `${name}: ${"reason" in id ? id.reason : ""}`).toBe(true);
      ids[name] = (id as { id: string }).id;
    }
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it("Single: a WASM gene writes, then reads back the value, as itself, in the project's store", () => {
    cli("agent", "create", "rw", "--genes", "wasm-mem-rw");
    const out = cli("agent", "run", "rw", "--input", "{}");
    expect(out).toContain("via WASM sandbox");
    expect(finalOutput(out)).toMatchObject({ key: "wasm/lang", value: b64("zh-CN"), createdBy: ids["wasm-mem-rw"], lastAccessedBy: ids["wasm-mem-rw"] });
    expect(existsSync(join(project, ".rotifer", "playground.db"))).toBe(true);
    expect(stored("rw")).toEqual([["wasm/lang", "zh-CN", ids["wasm-mem-rw"]]]);
  });

  it("Seq: each WASM gene runs as its own v2 id — one writes, the next reads", () => {
    cli("agent", "create", "seq", "--genes", "wasm-mem-writer", "wasm-mem-reader");
    const out = cli("agent", "run", "seq", "--input", "{}");
    expect(finalOutput(out)).toMatchObject({ key: "wasm/tone", value: b64("brief"), createdBy: ids["wasm-mem-writer"], lastAccessedBy: ids["wasm-mem-reader"] });
    expect(stored("seq")).toEqual([["wasm/tone", "brief", ids["wasm-mem-writer"]]]);
  });

  it("Try, fully compiled: executeAlgebra runs the gene with the agent's memory", () => {
    cli("agent", "create", "try", "--genes", "wasm-mem-writer", "wasm-mem-reader", "--composition", "Try");
    const out = cli("agent", "run", "try", "--input", "{}");
    expect(out).toContain("Try execution completed");
    expect(finalOutput(out)).toMatchObject({ key: "wasm/tone", value: b64("brief"), createdBy: ids["wasm-mem-writer"] });
    expect(stored("try")).toEqual([["wasm/tone", "brief", ids["wasm-mem-writer"]]]);
  });

  it("Par, fully compiled (merge: concat): both writers run through executeAlgebra, each as itself", () => {
    cli("agent", "create", "par", "--genes", "wasm-mem-writer-a", "wasm-mem-writer-b", "--composition", "Par", "--par-merge", "concat");
    const out = cli("agent", "run", "par", "--input", "{}");
    expect(out).toContain("Par execution completed");
    expect(stored("par")).toEqual([
      ["wasm/pool/a", "A", ids["wasm-mem-writer-a"]],
      ["wasm/pool/b", "B", ids["wasm-mem-writer-b"]],
    ]);
  });

  it("Cond, fully compiled: the branch the predicate picks runs through executeAlgebra with the agent's memory", () => {
    cli("agent", "create", "cond", "--genes", "wasm-mem-writer-a", "wasm-mem-writer-b", "--composition", "Cond");
    const out = cli("agent", "run", "cond", "--input", JSON.stringify({ type: "primary" }));
    expect(out).toContain("Cond execution completed");
    // The default predicate is type == "primary": the then-branch, the first gene.
    expect(stored("cond")).toEqual([["wasm/pool/a", "A", ids["wasm-mem-writer-a"]]]);
  });

  it("TryPool: the WASM gene the pool runs writes the agent's memory as itself", () => {
    cli("agent", "create", "pool", "--genes", "wasm-mem-writer-a", "wasm-mem-writer-b", "--composition", "TryPool");
    const out = cli("agent", "run", "pool", "--input", "{}");
    expect(out).toContain("TryPool execution complete");
    const entries = stored("pool");
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, value, createdBy] of entries) {
      const writer = key === "wasm/pool/a" ? "wasm-mem-writer-a" : "wasm-mem-writer-b";
      expect([key, value, createdBy]).toEqual([`wasm/pool/${writer.slice(-1)}`, writer.slice(-1).toUpperCase(), ids[writer]]);
    }
  });
});
