/**
 * A Node-path gene run with no agent (`rotifer run`) is refused "no agent
 * context", and the refusal is recorded the way rotifer-core records a WASM
 * gene's: one MEMORY_ACCESS_DENIED event
 * in the project's .rotifer/telemetry.jsonl with agentId null — no audit
 * line, since there is no agent's memory to put it in — and nothing at all
 * when ROTIFER_TELEMETRY=0.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { geneIdV2, hasNativeGeneIdV2 } from "../../src/utils/binding.js";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "index.js");

describe("rotifer run records a no-agent memory refusal as telemetry only", () => {
  let project: string;
  beforeEach(() => {
    expect(existsSync(CLI), "dist/index.js (npm run build)").toBe(true);
    expect(Boolean((process.features as { typescript?: unknown }).typescript), "Node with TypeScript stripping (22.18+)").toBe(true);
    expect(hasNativeGeneIdV2(), "the native addon computes v2 IDs").toBe(true);
    project = join(tmpdir(), "rotifer-run-no-agent-telemetry-" + randomUUID());
    mkdirSync(join(project, "genes"), { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "t", version: "0.1.0", author: "t", genes_dir: "genes", default_domain: "memory.demo" }),
    );
    cpSync(join(ROOT, "genes", "memory-preference-demo"), join(project, "genes", "memory-preference-demo"), { recursive: true });
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  /** `rotifer run` with telemetry on or off; the CLI's own heartbeat stays quiet under VITEST. */
  const run = (telemetry: "on" | "off") => {
    const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: "0", VITEST: "true" };
    delete env.DO_NOT_TRACK;
    delete env.ROTIFER_TELEMETRY;
    if (telemetry === "off") env.ROTIFER_TELEMETRY = "0";
    const r = spawnSync(process.execPath, [CLI, "run", "memory-preference-demo", "--no-sandbox", "--input", JSON.stringify({ user: "ada" })], {
      cwd: project,
      env,
      encoding: "utf-8",
    });
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("no agent context");
  };
  const memoryEvents = () =>
    existsSync(join(project, ".rotifer", "telemetry.jsonl"))
      ? readFileSync(join(project, ".rotifer", "telemetry.jsonl"), "utf-8")
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
          .filter((e) => e.eventType === "MEMORY_ACCESS_DENIED")
      : [];
  const memoryAuditLines = () =>
    existsSync(join(project, ".rotifer", "audit.jsonl"))
      ? readFileSync(join(project, ".rotifer", "audit.jsonl"), "utf-8").split("\n").filter((l) => l.includes('"agent_memory"'))
      : [];

  it("writes one event: the gene's v2 id, agentId null, no entry, the refused operation — and no audit line", () => {
    run("on");
    const gene = geneIdV2(join(project, "genes"), "memory-preference-demo") as { id: string };
    expect(memoryEvents()).toEqual([
      expect.objectContaining({
        eventType: "MEMORY_ACCESS_DENIED",
        bindingExtension: true,
        geneId: gene.id,
        result: { FAILURE: { errorCode: "MEMORY_ACCESS_DENIED", message: expect.stringMatching(/^no agent context/) } },
        metadata: { agentId: null, entryId: null, operation: "read" },
      }),
    ]);
    expect(memoryAuditLines()).toEqual([]);
  });

  it("writes nothing with ROTIFER_TELEMETRY=0", () => {
    run("off");
    expect(memoryEvents()).toEqual([]);
    expect(memoryAuditLines()).toEqual([]);
  });
});
