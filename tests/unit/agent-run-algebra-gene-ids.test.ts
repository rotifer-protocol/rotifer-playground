import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

/**
 * A TryCatch handler receives `{ error: GeneError, original_input }`, and
 * §15.2 GeneError.geneId must be the v2 ID of the gene that actually ran —
 * not the executor's lookup key, which agent-run derives from the gene's local
 * name. The Rust executor cannot compute v2 IDs (it holds a converted
 * phenotype, not the gene directory), so agent-run must hand them over with
 * the gene entries: `v2Id`, computed by geneIdV2 from the very directory the
 * wasm is read from.
 *
 * The binding is mocked to capture what agent-run sends; the executor side is
 * covered by the Rust tests in crates/rotifer-core/src/algebra/executor.rs.
 */

describe("agent run: gene entries carry each gene's v2 ID", () => {
  let projectDir: string;
  let executeAlgebra: ReturnType<typeof vi.fn>;
  let geneIdV2: ReturnType<typeof vi.fn>;

  const nameKey = (name: string) => createHash("sha256").update(name).digest("hex");

  function writeGene(name: string): void {
    const geneDir = join(projectDir, "genes", name);
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(join(geneDir, "gene.ir.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ domain: "general", version: "0.1.0", fidelity: "Native", inputSchema: {}, outputSchema: {} }),
    );
  }

  async function runTryAgent(): Promise<Record<string, { v2Id?: string }>> {
    const agentsDir = join(projectDir, ".rotifer", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, "a.json"),
      JSON.stringify({ id: "id-a", name: "a", state: "Active", genome: ["primary", "handler"], composition: { type: "Try" } }),
    );
    const { agentRunCommand } = await import("../../src/commands/agent-run.js");
    await agentRunCommand.parseAsync(["a"], { from: "user" }).catch(() => {});
    expect(executeAlgebra).toHaveBeenCalledTimes(1);
    return JSON.parse(executeAlgebra.mock.calls[0][1] as string);
  }

  beforeEach(() => {
    vi.resetModules();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-agent-gene-ids-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    writeGene("primary");
    writeGene("handler");
    executeAlgebra = vi.fn(() => ({
      success: true,
      output: { ok: true },
      stepsExecuted: 1,
      totalFuelConsumed: 1,
      totalDurationMs: 1,
      errorMessage: null,
    }));
    geneIdV2 = vi.fn();
    vi.doMock("../../src/utils/binding.js", () => ({
      tryLoadBinding: () => ({
        l0Check: () => ({ passed: true, violations: [], checksPerformed: 4 }),
        executeAlgebra,
      }),
      geneIdV2,
    }));
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.doUnmock("../../src/utils/binding.js");
  });

  it("sends the v2 ID computed from each installed gene's directory", async () => {
    const v2 = (name: string) => `v2:${createHash("sha256").update(`v2-${name}`).digest("hex")}`;
    geneIdV2.mockImplementation((_root: string, name: string) => ({ id: v2(name) }));

    const entries = await runTryAgent();

    expect(geneIdV2).toHaveBeenCalledWith(join(projectDir, "genes"), "primary");
    expect(geneIdV2).toHaveBeenCalledWith(join(projectDir, "genes"), "handler");
    expect(entries[nameKey("primary")].v2Id).toBe(v2("primary"));
    expect(entries[nameKey("handler")].v2Id).toBe(v2("handler"));
    // The lookup key is the name hash; the reported ID must not be.
    expect(entries[nameKey("primary")].v2Id).not.toBe(nameKey("primary"));
  });

  it("omits v2Id when it cannot be computed, rather than sending the name hash", async () => {
    geneIdV2.mockReturnValue({ reason: "native module not available" });

    const entries = await runTryAgent();

    expect(entries[nameKey("primary")]).not.toHaveProperty("v2Id");
    expect(entries[nameKey("handler")]).not.toHaveProperty("v2Id");
  });
});
