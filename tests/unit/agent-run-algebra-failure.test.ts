import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * When the Rust AlgebraExecutor fails (or the binding throws), `agent run`
 * printed the error and then, because executeViaAlgebra returned `undefined`
 * where the caller only checked for `null`, also printed
 * "✓ Pipeline execution complete" and "Final output: undefined" before
 * exiting 1. A failed run must not report success.
 *
 * The binding is mocked: what is under test is how agent-run reports an
 * executor outcome, not the executor.
 */

describe("agent run: a failed Par / Cond / Try run does not report success", () => {
  let projectDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const output = () =>
    [...errorSpy.mock.calls, ...logSpy.mock.calls].map((c) => c.map(String).join(" ")).join("\n");

  function bindingWith(executeAlgebra: () => unknown): void {
    vi.doMock("../../src/utils/binding.js", () => ({
      tryLoadBinding: () => ({
        l0Check: () => ({ passed: true, violations: [], checksPerformed: 4 }),
        executeAlgebra,
      }),
      geneIdV2: () => ({ reason: "not computed in this test" }),
    }));
  }

  function writeGene(name: string): void {
    const geneDir = join(projectDir, "genes", name);
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(join(geneDir, "gene.ir.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ domain: "general", version: "0.1.0", fidelity: "Native", inputSchema: {}, outputSchema: {} }),
    );
  }

  function writeAgent(type: string): void {
    const agentsDir = join(projectDir, ".rotifer", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "a.json"),
      JSON.stringify({ id: "id-a", name: "a", state: "Active", genome: ["g1", "g2"], composition: { type } }),
    );
  }

  async function runAgent(): Promise<void> {
    const { agentRunCommand } = await import("../../src/commands/agent-run.js");
    await agentRunCommand.parseAsync(["a"], { from: "user" }).catch(() => {});
  }

  async function expectReportedFailure(): Promise<void> {
    await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1));
    expect(output()).toContain("E0053");
    expect(output()).not.toContain("Pipeline execution complete");
    expect(output()).not.toContain("Final output");
  }

  beforeEach(() => {
    vi.resetModules();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-agent-algebra-fail-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    writeGene("g1");
    writeGene("g2");
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.doUnmock("../../src/utils/binding.js");
  });

  for (const type of ["Par", "Cond", "Try"]) {
    it(`${type}: the executor reports failure`, async () => {
      bindingWith(() => ({
        success: false,
        output: null,
        stepsExecuted: 0,
        totalFuelConsumed: 0,
        totalDurationMs: 0,
        errorMessage: "resource limit exceeded: fuel exhausted",
      }));
      writeAgent(type);
      await runAgent();
      expect(output()).toContain("fuel exhausted");
      await expectReportedFailure();
    });

    it(`${type}: the binding throws`, async () => {
      bindingWith(() => {
        throw new Error("invalid gene entries JSON: boom");
      });
      writeAgent(type);
      await runAgent();
      expect(output()).toContain("invalid gene entries JSON: boom");
      await expectReportedFailure();
    });
  }

  it("control: a successful run still reports success and its output", async () => {
    bindingWith(() => ({
      success: true,
      output: { ok: true },
      stepsExecuted: 2,
      totalFuelConsumed: 10,
      totalDurationMs: 1,
      errorMessage: null,
    }));
    writeAgent("Par");
    await runAgent();
    expect(output()).toContain("Pipeline execution complete");
    expect(output()).toContain('"ok": true');
    expect(process.exit).not.toHaveBeenCalledWith(1);
  });
});
