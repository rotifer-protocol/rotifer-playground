/**
 * AgentMemory belongs to the agent, not to a gene (spec §38.1): create an
 * agent, let the demo genes write through `rotifer agent run`,
 * change the agent's genome — a gene replaced by a new version, others
 * swapped in and out — and the memory is still there for the new genes.
 *
 * Every step is the real CLI in its own process, against rotifer-napi's store
 * in the project's `.rotifer/playground.db`, so what survives is what was
 * persisted. The store is then read the deployer's way (memoryGet), as a
 * separate client of the same database.
 */
import { beforeAll, afterAll, it, expect } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { geneIdV2 } from "../../src/utils/binding.js";
import { entryIdFor } from "../../src/memory/codec.js";
import type { MemoryEntryJson } from "../../src/memory/types.js";
import { describeWithNativeMemory, openNativeMemory } from "../fixtures/memory/native-memory.js";
import { cliEnv, finalOutput } from "../fixtures/memory/cli.js";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "index.js");
const DEMOS = ["memory-preference-demo", "memory-pattern-demo", "memory-context-demo"];

describeWithNativeMemory("agent memory survives a genome change", () => {
  let project: string;
  let agentId: string;

  const cli = (...args: string[]) => execFileSync(process.execPath, [CLI, ...args], { cwd: project, env: cliEnv, encoding: "utf-8" });
  const agentFile = () => join(project, ".rotifer", "agents", `${agentId}.json`);
  /** Change the agent's genome the way a deployer edits it, between runs. */
  const setGenome = (genome: string[]) => {
    const agent = JSON.parse(readFileSync(agentFile(), "utf-8"));
    writeFileSync(agentFile(), JSON.stringify({ ...agent, genome }, null, 2) + "\n");
  };
  const run = (input: unknown) => finalOutput(cli("agent", "run", "assistant", "--no-sandbox", "--input", JSON.stringify(input)));
  const idOf = (gene: string) => {
    const result = geneIdV2(join(project, "genes"), gene);
    if (!("id" in result)) throw new Error(`no v2 id for ${gene}: ${result.reason}`);
    return result.id;
  };
  /** The whole AgentMemory, read by the deployer from the project's store. */
  const stored = () => {
    const memory = openNativeMemory(project)!.memoryGet(agentId) as { entries: MemoryEntryJson[]; quota: number };
    return {
      quota: memory.quota,
      entries: Object.fromEntries(
        memory.entries.map((e) => [e.key, { category: e.category, createdBy: e.createdBy, value: Buffer.from(e.value, "base64").toString("utf8") }]),
      ),
    };
  };

  beforeAll(() => {
    // Prerequisites fail here, loudly, rather than skipping.
    expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
    expect(Boolean((process.features as { typescript?: unknown }).typescript), "Node with TypeScript stripping (22.18+)").toBe(true);

    project = join(tmpdir(), "rotifer-memory-e2e-" + randomUUID());
    mkdirSync(join(project, "genes"), { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "memory-e2e", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "memory.demo" }),
    );
    for (const demo of DEMOS) cpSync(join(ROOT, "genes", demo), join(project, "genes", demo), { recursive: true });

    cli("agent", "create", "assistant", "--genes", "memory-preference-demo", "--memory-quota=1MB");
    const [file] = readdirSync(join(project, ".rotifer", "agents"));
    agentId = file.replace(/\.json$/, "");
  });

  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it("agent create made the agent's memory in the project's store, with its quota", () => {
    expect(existsSync(join(project, ".rotifer", "playground.db"))).toBe(true);
    expect(stored()).toEqual({ quota: 1024 * 1024, entries: {} });
  });

  it("the demo genes write PREFERENCE and PATTERN entries through agent run", () => {
    expect(run({ user: "ada", set: { language: "zh-CN", tone: "brief" } })).toEqual({
      user: "ada",
      preferences: { language: "zh-CN", tone: "brief" },
      updated: ["language", "tone"],
    });

    setGenome(["memory-pattern-demo"]);
    run({ query: "Weather" });
    expect(run({ query: "weather" })).toMatchObject({ query: "weather", count: 2 });
  });

  it("after a new version of the preference gene replaces the old one, it reads what the old one wrote", () => {
    const before = idOf("memory-preference-demo");
    // Different source, so a different content-derived id — a different gene,
    // as far as memory and the protocol are concerned.
    const src = join(project, "genes", "memory-preference-demo", "index.ts");
    writeFileSync(src, readFileSync(src, "utf-8") + "\n// v0.2.0: same behaviour, new gene\n");
    const phenotypePath = join(project, "genes", "memory-preference-demo", "phenotype.json");
    writeFileSync(phenotypePath, JSON.stringify({ ...JSON.parse(readFileSync(phenotypePath, "utf-8")), version: "0.2.0" }, null, 2));
    expect(idOf("memory-preference-demo")).not.toEqual(before);

    setGenome(["memory-preference-demo"]);
    expect(run({ user: "ada" })).toEqual({ user: "ada", preferences: { language: "zh-CN", tone: "brief" }, updated: [] });

    // The entries still name the gene version that created them.
    expect(stored().entries["preference-demo/ada/language"]).toEqual({ category: "PREFERENCE", createdBy: before, value: "zh-CN" });
  });

  it("a gene that joins later writes alongside, and the departed gene's PATTERN entry is still stored", () => {
    setGenome(["memory-context-demo"]);
    run({ topic: "travel", note: "prefers trains" });
    expect(run({ topic: "travel", note: "window seat" })).toEqual({
      topic: "travel",
      notes: ["prefers trains", "window seat"],
      topics: ["travel"],
    });

    const { entries } = stored();
    expect(Object.keys(entries).sort()).toEqual([
      "context-demo/topic/travel",
      "pattern-demo/query/weather",
      "preference-demo/ada/language",
      "preference-demo/ada/tone",
    ]);
    expect(entries["pattern-demo/query/weather"]).toMatchObject({ category: "PATTERN", value: "2" });
    expect(entries["context-demo/topic/travel"]).toMatchObject({ category: "CONTEXT", createdBy: idOf("memory-context-demo") });
  });

  it("every state change is a lifecycle line in .rotifer/audit.jsonl, by entryId, never by key or value", () => {
    const raw = readFileSync(join(project, ".rotifer", "audit.jsonl"), "utf-8");
    const lines = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
      .filter((l) => l.kind === "agent_memory");
    const id = (key: string) => entryIdFor(agentId, key);
    expect(lines.map((l) => [l.action, l.entryId])).toEqual([
      ["memory_created", null],
      ["write", id("preference-demo/ada/language")],
      ["write", id("preference-demo/ada/tone")],
      ["write", id("pattern-demo/query/weather")],
      ["update", id("pattern-demo/query/weather")],
      ["write", id("context-demo/topic/travel")],
      ["update", id("context-demo/topic/travel")],
    ]);
    expect(lines.every((l) => l.agentId === agentId)).toBe(true);
    expect(raw).not.toContain("preference-demo/");
    expect(raw).not.toContain("zh-CN");
  });
});
