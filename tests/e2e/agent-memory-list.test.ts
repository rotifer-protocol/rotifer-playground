/**
 * `rotifer agent memory list` and `delete` through the
 * real CLI on rotifer-napi's store: the deployer sees what an agent stored
 * — key, category, size, creating gene — and never the values, and deletes
 * one key or one category, each deletion audited as the deployer's. The
 * examples in --help run as printed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { geneIdV2 } from "../../src/utils/binding.js";
import { describeWithNativeMemory } from "../fixtures/memory/native-memory.js";
import { cliEnv } from "../fixtures/memory/cli.js";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "index.js");

describeWithNativeMemory("rotifer agent memory list", () => {
  let project: string;
  const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...cliEnv, COLUMNS: "300" }, encoding: "utf-8" });
  const ok = (cwd: string, ...args: string[]) => {
    const r = cli(cwd, ...args);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return r.stdout;
  };

  beforeAll(() => {
    expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
    expect(Boolean((process.features as { typescript?: unknown }).typescript), "Node with TypeScript stripping (22.18+)").toBe(true);
    project = join(tmpdir(), "rotifer-memory-list-" + randomUUID());
    mkdirSync(join(project, "genes"), { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "list", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "memory.demo" }),
    );
    cpSync(join(ROOT, "genes", "memory-preference-demo"), join(project, "genes", "memory-preference-demo"), { recursive: true });
    ok(project, "agent", "create", "prefs", "--genes", "memory-preference-demo");
    ok(project, "agent", "run", "prefs", "--no-sandbox", "--input", JSON.stringify({ user: "ada", set: { language: "VALUE-zh-CN", tone: "VALUE-brief" } }));
  });
  afterAll(() => rmSync(project, { recursive: true, force: true }));

  it("lists each entry's key, category, size and creating gene (by name), and no value", () => {
    const out = ok(project, "agent", "memory", "list", "prefs");
    for (const text of ["preference-demo/ada/language", "preference-demo/ada/tone", "PREFERENCE", "memory-preference-demo", "2 entries shown"]) {
      expect(out).toContain(text);
    }
    // "preference-demo/ada/language" (28 bytes) + "VALUE-zh-CN" (11 bytes)
    expect(out).toContain("39 B");
    expect(out).not.toContain("VALUE-");
    expect(out).not.toContain(Buffer.from("VALUE-zh-CN").toString("base64"));
  });

  it("a creator no longer in the project (an older version of the gene) shows as a short id", () => {
    const before = (geneIdV2(join(project, "genes"), "memory-preference-demo") as { id: string }).id;
    const src = join(project, "genes", "memory-preference-demo", "index.ts");
    writeFileSync(src, readFileSync(src, "utf-8") + "\n// a new version\n");
    try {
      const out = ok(project, "agent", "memory", "list", "prefs");
      expect(out).toContain(`${before.slice(0, 15)}…`);
      expect(out).not.toContain("memory-preference-demo");
    } finally {
      writeFileSync(src, readFileSync(src, "utf-8").replace("\n// a new version\n", ""));
    }
  });

  it("--category narrows the list", () => {
    expect(ok(project, "agent", "memory", "list", "prefs", "--category", "PATTERN")).toContain("No PATTERN entries");
    expect(ok(project, "agent", "memory", "list", "prefs", "--category", "PREFERENCE")).toContain("2 entries shown");
  });

  it("refuses an unknown category and an unknown agent", () => {
    const badCategory = cli(project, "agent", "memory", "list", "prefs", "--category", "preference");
    expect(badCategory.status).not.toBe(0);
    expect(badCategory.stderr).toContain("unknown memory category");
    const badAgent = cli(project, "agent", "memory", "list", "nobody");
    expect(badAgent.status).not.toBe(0);
    expect(badAgent.stderr).toContain("Agent 'nobody' not found");
  });

  it("the --help examples run as printed in a fresh workspace", () => {
    const examples = ok(project, "agent", "memory", "list", "--help")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("$ rotifer agent memory list"));
    expect(examples).toHaveLength(2);

    const ws = join(tmpdir(), "rotifer-memory-list-ws-" + randomUUID());
    mkdirSync(ws, { recursive: true });
    try {
      ok(ws, "init", "demo");
      const cwd = join(ws, "demo");
      ok(cwd, "agent", "create", "my-agent", "--genes", "hello-world");
      for (const example of examples) {
        const out = ok(cwd, ...example.replace(/^\$ rotifer /, "").split(" "));
        expect(out).toMatch(/No (PREFERENCE )?(memory )?entries/);
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);

  describe("delete", () => {
    const listed = (agent: string) => ok(project, "agent", "memory", "list", agent);
    const audit = () =>
      readFileSync(join(project, ".rotifer", "audit.jsonl"), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((l) => l.kind === "agent_memory");

    it("refuses neither and both selectors, an unknown category, and a key that is not there — changing nothing", () => {
      for (const [args, text] of [
        [[], "exactly one of --key or --category"],
        [["--key", "preference-demo/ada/tone", "--category", "PREFERENCE"], "exactly one of --key or --category"],
        [["--category", "preference"], "unknown memory category"],
        [["--key", "no/such/key"], "MEMORY_NOT_FOUND"],
      ] as const) {
        const r = cli(project, "agent", "memory", "delete", "prefs", ...args);
        expect(r.status, args.join(" ")).not.toBe(0);
        expect(r.stderr, args.join(" ")).toContain(text);
      }
      expect(listed("prefs")).toContain("2 entries shown");
    });

    it("--key deletes that entry, and audits it as the deployer", () => {
      expect(ok(project, "agent", "memory", "delete", "prefs", "--key", "preference-demo/ada/tone")).toContain("Deleted 1 entry");
      const out = listed("prefs");
      expect(out).toContain("1 entry shown");
      expect(out).not.toContain("preference-demo/ada/tone");
      expect(audit().at(-1)).toMatchObject({ action: "delete", actor: "deployer", geneId: null });
    });

    it("--category deletes every entry of it — PREFERENCE included, which quota never evicts", () => {
      expect(ok(project, "agent", "memory", "delete", "prefs", "--category", "PATTERN")).toContain("Deleted 0 entries");
      expect(ok(project, "agent", "memory", "delete", "prefs", "--category", "PREFERENCE")).toContain("Deleted 1 entry");
      expect(listed("prefs")).toContain("No memory entries yet");
    });

    it("the --help examples run as printed", () => {
      const examples = ok(project, "agent", "memory", "delete", "--help")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("$ rotifer agent memory delete"));
      expect(examples).toHaveLength(2);
      // An agent called my-agent whose memory holds the key the first example names.
      ok(project, "agent", "create", "my-agent", "--genes", "memory-preference-demo");
      ok(project, "agent", "run", "my-agent", "--no-sandbox", "--input", JSON.stringify({ user: "ada", set: { language: "zh-CN" } }));
      expect(ok(project, ...examples[0].replace(/^\$ rotifer /, "").split(" "))).toContain("Deleted 1 entry");
      expect(ok(project, ...examples[1].replace(/^\$ rotifer /, "").split(" "))).toContain("Deleted 0 entries");
    }, 60_000);
  });
});
