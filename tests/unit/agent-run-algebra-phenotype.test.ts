import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { tryLoadBinding } from "../../src/utils/binding.js";

/**
 * `agent run` sends Par / Cond / Try to the Rust AlgebraExecutor, which
 * deserializes each phenotype into `rotifer_core::types::gene::Phenotype`.
 * A phenotype.json as the CLI writes it does not have that shape: `irHash` is
 * a 64-char hex string where Rust wants `[u8; 32]`, `createdAt` may be an ISO
 * string (`rotifer wrap`) where Rust wants epoch milliseconds, and
 * `dependencies` lists gene names where Rust wants gene ids. Passing it as-is
 * failed every compiled multi-gene run with
 * `invalid gene entries JSON: invalid type: string "…", expected an array of
 * length 32`.
 *
 * These tests run the real native binding (no mock) on a real compiled gene,
 * because the bug lives in the TS → Rust contract. They assert the contract
 * layer only: the phenotypes now deserialize. Whether the gene then finishes
 * depends on the fuel the binding allows, which is tested separately.
 */

const binding = tryLoadBinding();
const REPO_GENES = fileURLToPath(new URL("../../genes", import.meta.url));
const INPUT = JSON.stringify({ width: 8, height: 8, generations: 2 });

describe.skipIf(!binding?.executeAlgebra)("agent run: Par / Cond / Try accept real-shape phenotypes", () => {
  let projectDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const output = () =>
    [...errorSpy.mock.calls, ...logSpy.mock.calls].map((c) => c.map(String).join(" ")).join("\n");

  // A compiled gene whose phenotype.json has the shapes the CLI really writes.
  function writeGene(name: string, overrides: Record<string, unknown>): void {
    const geneDir = join(projectDir, "genes", name);
    mkdirSync(geneDir, { recursive: true });
    copyFileSync(join(REPO_GENES, "evolve-life", "gene.ir.wasm"), join(geneDir, "gene.ir.wasm"));
    const phenotype = JSON.parse(readFileSync(join(REPO_GENES, "evolve-life", "phenotype.json"), "utf-8"));
    writeFileSync(join(geneDir, "phenotype.json"), JSON.stringify({ ...phenotype, ...overrides }));
  }

  function writeAgent(name: string, genome: string[], composition: Record<string, unknown>): void {
    const agentsDir = join(projectDir, ".rotifer", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      join(agentsDir, `${name}.json`),
      JSON.stringify({ id: `id-${name}`, name, state: "Active", genome, composition }),
    );
  }

  async function runAgent(name: string): Promise<void> {
    const { agentRunCommand } = await import("../../src/commands/agent-run.js");
    await agentRunCommand.parseAsync([name, "--input", INPUT], { from: "user" }).catch(() => {});
  }

  // Rust accepted every phenotype: the run got past deserialization and
  // reached the executor (which then reports success or a runtime error).
  function expectPhenotypesAccepted(composition: string): void {
    expect(output()).not.toContain("invalid gene entries JSON");
    expect(output()).toMatch(new RegExp(`${composition} execution (completed|failed: (?!invalid))`));
  }

  beforeEach(() => {
    vi.resetModules();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-agent-algebra-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    // irHash: 64-char hex (as `rotifer compile` writes it);
    // createdAt: ISO string (as `rotifer wrap` writes it) and epoch ms;
    // dependencies: gene names.
    writeGene("life-a", {
      irHash: "177efba7f402d54251c8153fce9095957abd8a1fa2a031b8b2fec7c92c5e54cb",
      createdAt: "2026-04-02T02:44:47.982Z",
    });
    writeGene("life-b", {
      irHash: "a7ad86d8d689bf611c38d13d080e8050240903928889e309466861ebb1031fca",
      createdAt: 1741906800000,
      dependencies: ["life-a"],
    });
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    // Recorded, not thrown: the failure path calls exit from a promise.
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("Par: phenotypes deserialize", async () => {
    writeAgent("par", ["life-a", "life-b"], { type: "Par", merge: "first" });
    await runAgent("par");
    expectPhenotypesAccepted("Par");
  });

  it("Cond: phenotypes deserialize", async () => {
    writeAgent("cond", ["life-a", "life-b"], { type: "Cond" });
    await runAgent("cond");
    expectPhenotypesAccepted("Cond");
  });

  it("Try: phenotypes deserialize", async () => {
    writeAgent("try", ["life-a", "life-b"], { type: "Try" });
    await runAgent("try");
    expectPhenotypesAccepted("Try");
  });
});
