/**
 * The three demo genes: what they do with an agent's memory,
 * and that without an agent they let the MEMORY_ACCESS_DENIED through rather
 * than probing ctx.memory first. Run in-process against the test double; the
 * e2e suites run them through the CLI on rotifer-napi.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { express as preference } from "../../genes/memory-preference-demo/index.js";
import { express as pattern } from "../../genes/memory-pattern-demo/index.js";
import { express as context } from "../../genes/memory-context-demo/index.js";
import { DEFAULT_DATA_POLICY, MemoryError, createGeneMemoryAccess, noAgentMemory, type GeneMemoryAccess } from "../../src/memory/index.js";
import { JsonFileMemoryBackend } from "../../src/memory/backend.js";

type Express = (input: never, ctx: { memory: GeneMemoryAccess }) => unknown;
const DEMOS: Array<[string, Express, unknown]> = [
  ["memory-preference-demo", preference as Express, { user: "ada", set: { language: "zh-CN" } }],
  ["memory-pattern-demo", pattern as Express, { query: "weather" }],
  ["memory-context-demo", context as Express, { topic: "travel", note: "trains" }],
];

describe("demo genes without an agent", () => {
  it.each(DEMOS)("%s throws the MEMORY_ACCESS_DENIED 'no agent context' error", (_name, express, input) => {
    let caught: unknown;
    try {
      express(input as never, { memory: noAgentMemory() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MemoryError);
    expect((caught as MemoryError).code).toBe("MEMORY_ACCESS_DENIED");
    expect((caught as MemoryError).message.startsWith("no agent context")).toBe(true);
  });
});

describe("demo genes inside an agent", () => {
  let root: string;
  let memory: (geneId: string) => GeneMemoryAccess;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-demo-genes-"));
    const backend = new JsonFileMemoryBackend(root, () => ({ quota: 1024 * 1024 }), () => {}, () => {});
    memory = (geneId) =>
      createGeneMemoryAccess({
        backend,
        caller: { agentId: "agent", geneId, domain: "memory.demo" },
        dataPolicy: DEFAULT_DATA_POLICY,
        telemetry: () => {},
        audit: () => {},
      });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("preference: remembers per user, under its own key prefix, as PREFERENCE", () => {
    const m = memory("v2:" + "a".repeat(64));
    expect(preference({ user: "ada", set: { language: "zh-CN", tone: "brief" } }, { memory: m })).toEqual({
      user: "ada",
      preferences: { language: "zh-CN", tone: "brief" },
      updated: ["language", "tone"],
    });
    expect(preference({ user: "bo" }, { memory: m })).toEqual({ user: "bo", preferences: {}, updated: [] });
    expect(m.queryMemory().map((e) => [e.key, e.category])).toEqual(
      expect.arrayContaining([
        ["preference-demo/ada/language", "PREFERENCE"],
        ["preference-demo/ada/tone", "PREFERENCE"],
      ]),
    );
  });

  it("pattern: counts queries case-insensitively, as PATTERN", () => {
    const m = memory("v2:" + "b".repeat(64));
    pattern({ query: "Weather" }, { memory: m });
    expect(pattern({ query: "weather" }, { memory: m })).toMatchObject({ query: "weather", count: 2 });
    expect(m.queryMemory().map((e) => [e.key, e.category])).toEqual([["pattern-demo/query/weather", "PATTERN"]]);
  });

  it("context: keeps notes per topic, as CONTEXT", () => {
    const m = memory("v2:" + "c".repeat(64));
    context({ topic: "travel", note: "trains" }, { memory: m });
    expect(context({ topic: "travel", note: "window" }, { memory: m })).toEqual({ topic: "travel", notes: ["trains", "window"], topics: ["travel"] });
    expect(m.queryMemory().map((e) => [e.key, e.category])).toEqual([["context-demo/topic/travel", "CONTEXT"]]);
  });

  it.each(DEMOS)("%s refuses bad input without touching memory", (_name, express) => {
    const m = memory("v2:" + "d".repeat(64));
    expect(express({} as never, { memory: m })).toMatchObject({ __rotifer_error: { code: "INVALID_INPUT" } });
    expect(m.queryMemory()).toEqual([]);
  });
});
