/**
 * The CLI hands a Node-path gene its memory as `ctx.memory` (spec §38.2),
 * through the real commands, one process per run:
 *
 * - `rotifer agent run` (Single, and TryPool): the agent's memory in
 *   rotifer-napi's store — what one run stores, the next run reads;
 * - `rotifer run` of a single gene: no agent, so every call is refused with
 *   "no agent context", and the run fails saying so.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import type { MemoryEntryJson } from "../../src/memory/types.js";
import { describeWithNativeMemory, openNativeMemory } from "../fixtures/memory/native-memory.js";
import { cliEnv, finalOutput } from "../fixtures/memory/cli.js";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "index.js");
const DEMOS = ["memory-preference-demo", "memory-pattern-demo", "memory-context-demo"];

function newProject(prefix: string): string {
  // Prerequisites fail loudly rather than skipping.
  expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
  expect(Boolean((process.features as { typescript?: unknown }).typescript), "Node with TypeScript stripping (22.18+)").toBe(true);
  const project = join(tmpdir(), `${prefix}-${randomUUID()}`);
  mkdirSync(join(project, "genes"), { recursive: true });
  writeFileSync(
    join(project, "rotifer.json"),
    JSON.stringify({ name: "run-memory", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "memory.demo" }),
  );
  for (const demo of DEMOS) cpSync(join(ROOT, "genes", demo), join(project, "genes", demo), { recursive: true });
  return project;
}

/** The id of the agent called `name` (records are `.rotifer/agents/<id>.json`). */
function agentIdIn(project: string, name: string): string {
  const dir = join(project, ".rotifer", "agents");
  const id = readdirSync(dir)
    .filter((f) => /^[^.]+\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .find((candidate) => JSON.parse(readFileSync(join(dir, `${candidate}.json`), "utf-8")).name === name);
  expect(id, `agent '${name}'`).toBeDefined();
  return id!;
}

describe("rotifer run of a single gene has no agent memory", () => {
  let project: string;
  beforeAll(() => {
    project = newProject("rotifer-run-no-agent");
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it.each([
    ["memory-preference-demo", { user: "ada" }],
    ["memory-pattern-demo", { query: "weather" }],
    ["memory-context-demo", { topic: "travel", note: "x" }],
  ])("%s fails with 'no agent context', and writes nothing", (gene, input) => {
    const result = spawnSync(process.execPath, [CLI, "run", gene, "--no-sandbox", "--input", JSON.stringify(input)], {
      cwd: project,
      env: cliEnv,
      encoding: "utf-8",
    });
    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("no agent context");
    expect(existsSync(join(project, ".rotifer", "playground.db"))).toBe(false);
    expect(existsSync(join(project, ".rotifer", "memory"))).toBe(false);
  });
});

describeWithNativeMemory("agent run gives genes their agent's memory", () => {
  let project: string;
  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: project, env: cliEnv, encoding: "utf-8" });
  const entries = (agentName: string) =>
   (openNativeMemory(project)!.memoryGet(agentIdIn(project, agentName)) as { entries: MemoryEntryJson[] }).entries.map((e) => [
      e.key,
      Buffer.from(e.value, "base64").toString("utf8"),
    ]);

  beforeAll(() => {
    project = newProject("rotifer-agent-run-memory");
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it("Single: a later run reads what an earlier run stored", () => {
    cli("agent", "create", "prefs", "--genes", "memory-preference-demo");
    const first = cli("agent", "run", "prefs", "--no-sandbox", "--input", JSON.stringify({ user: "ada", set: { language: "zh-CN" } }));
    expect(finalOutput(first)).toEqual({ user: "ada", preferences: { language: "zh-CN" }, updated: ["language"] });

    const second = cli("agent", "run", "prefs", "--no-sandbox", "--input", JSON.stringify({ user: "ada" }));
    expect(finalOutput(second)).toEqual({ user: "ada", preferences: { language: "zh-CN" }, updated: [] });

    // Stored as the agent's, under its id, in the project's store — and nowhere else.
    expect(entries("prefs")).toEqual([["preference-demo/ada/language", "zh-CN"]]);
    expect(existsSync(join(project, ".rotifer", "memory"))).toBe(false);
  });

  it("TryPool: the gene the pool runs gets the agent's memory too", () => {
    cli("agent", "create", "pool", "--genes", "memory-preference-demo", "memory-context-demo", "--composition", "TryPool");
    const out = cli("agent", "run", "pool", "--no-sandbox", "--input", JSON.stringify({ user: "bo", set: { tone: "brief" } }));
    expect(out).toContain("TryPool execution complete");
    expect(entries("pool")).toEqual([["preference-demo/bo/tone", "brief"]]);
    // Another agent's memory is its own: neither sees the other's entries.
    expect(entries("prefs")).toEqual([["preference-demo/ada/language", "zh-CN"]]);
  });

  describe("Par, Cond and Try", () => {
    // Two Node-path genes that would each count their runs in the agent's
    // memory. Par, Cond and Try run only on the algebra executor, which runs
    // compiled genes; with these, the agent is refused before any gene runs
    // — so nothing reaches memory. (Compiled compositions reach it through
    // executeAlgebra: tests/e2e/agent-run-memory-wasm.test.ts.)
    const tagger = (name: string) => `
export function express(input: unknown, ctx: { memory: { readMemory(k: string): { value: Uint8Array } | null; writeMemory(k: string, v: Uint8Array, c: string): unknown } }) {
  const key = "${name}/runs";
  const seen = ctx.memory.readMemory(key);
  const runs = (seen ? Number(new TextDecoder().decode(seen.value)) : 0) + 1;
  ctx.memory.writeMemory(key, new TextEncoder().encode(String(runs)), "PATTERN");
  return input;
}
`;

    beforeAll(() => {
      for (const name of ["mem-tag-a", "mem-tag-b"]) {
        mkdirSync(join(project, "genes", name), { recursive: true });
        writeFileSync(join(project, "genes", name, "index.ts"), tagger(name));
        writeFileSync(
          join(project, "genes", name, "phenotype.json"),
          JSON.stringify({
            domain: "memory.demo",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
            version: "0.1.0",
            fidelity: "Wrapped",
            sources: ["index.ts"],
          }),
        );
      }
    });

    it.each(["Par", "Cond", "Try"])("%s of uncompiled genes is refused before any gene runs, and nothing reaches memory", (composition) => {
      const name = `comp-${composition.toLowerCase()}`;
      cli("agent", "create", name, "--genes", "mem-tag-a", "mem-tag-b", "--composition", composition);
      const r = spawnSync(process.execPath, [CLI, "agent", "run", name, "--input", JSON.stringify({ type: "primary" })], {
        cwd: project,
        env: cliEnv,
        encoding: "utf-8",
      });
      expect(r.status, r.stdout + r.stderr).not.toBe(0);
      expect(r.stdout + r.stderr).toContain("No gene was run");
      expect(entries(name)).toEqual([]);
    });
  });
});
