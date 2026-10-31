/**
 * loadNodeRunner hands express() a context whose memory is never undefined
 *: the caller's memory when it has one, otherwise
 * one that refuses every call with "no agent context" — a refusal the T1
 * runner reads as a crash of that case, not a TypeError on `undefined`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadNodeRunner } from "../../src/testsuite/gate.js";
import type { GeneMemoryAccess } from "../../src/memory/index.js";

describe("loadNodeRunner and ctx.memory", () => {
  let dir: string;
  let gene: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rotifer-node-runner-"));
    gene = join(dir, "index.mjs");
    writeFileSync(
      gene,
      "export function express(input, ctx) { const e = ctx.memory.readMemory(input.key); return { value: e ? new TextDecoder().decode(e.value) : null }; }\n",
    );
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes the memory it is given", async () => {
    const memory = {
      readMemory: (key: string) => (key === "k" ? { value: new TextEncoder().encode("stored") } : null),
    } as unknown as GeneMemoryAccess;
    const loaded = await loadNodeRunner(gene, { kind: "ok" }, { memory });
    expect("runner" in loaded).toBe(true);
    const outcome = (loaded as { runner: (input: unknown) => { success: boolean; output?: unknown } }).runner({ key: "k" });
    expect(outcome).toMatchObject({ success: true, output: { value: "stored" } });
  });

  it("without one, the gene meets 'no agent context', not a TypeError", async () => {
    const loaded = await loadNodeRunner(gene, { kind: "ok" });
    const outcome = (loaded as { runner: (input: unknown) => { success: boolean; errorMessage?: string } }).runner({ key: "k" });
    expect(outcome.success).toBe(false);
    expect(outcome.errorMessage).toContain("no agent context");
    expect(outcome.errorMessage).not.toContain("TypeError");
  });
});
