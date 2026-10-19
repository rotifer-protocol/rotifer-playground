import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * `rotifer run` refuses to run a Cloud-installed gene on the unsandboxed
 * Node.js path unless the user passes --trust-unsigned. `rotifer agent run`
 * had no such check: the same gene, placed in a pipeline, ran with full host
 * privileges and nobody was asked. Reproduced against the published 0.26.1
 * package — the gene wrote a file to disk.
 *
 * Each test's gene writes marker files, so the assertions are on what the
 * gene actually did, not on what the CLI printed: `top-level` is written when
 * the module is loaded, `express` when the gene is invoked. A refusal must
 * leave neither — loading the module already runs its top-level code, so a
 * check placed after `import()` is too late.
 */

const INSTALL_MANIFEST = JSON.stringify({
  cloud_id: "00000000-0000-0000-0000-000000000000",
  owner: "someone-else",
  version: "0.1.0",
  installed_at: "2026-10-13T00:00:00Z",
});

describe("agent run must not run an installed gene unsandboxed without consent", () => {
  let projectDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function writeGene(name: string, opts: { installed: boolean; domain?: string }): void {
    const geneDir = join(projectDir, "genes", name);
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({ domain: opts.domain ?? "general", version: "0.1.0", fidelity: "Wrapped" }),
    );
    const marker = (kind: string) => JSON.stringify(join(projectDir, `MARKER-${name}-${kind}`));
    writeFileSync(
      join(geneDir, "index.ts"),
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${marker("top-level")}, "loaded");\n` +
        `export function express(input) { writeFileSync(${marker("express")}, "ran"); return { ran: true }; }\n`,
    );
    if (opts.installed) writeFileSync(join(geneDir, ".cloud-manifest.json"), INSTALL_MANIFEST);
  }

  function writeAgent(genome: string[], composition: string): void {
    mkdirSync(join(projectDir, ".rotifer", "agents"), { recursive: true });
    writeFileSync(
      join(projectDir, ".rotifer", "agents", "a.json"),
      JSON.stringify({ id: "a1", name: "agent-x", state: "Active", genome, composition }),
    );
  }

  const marked = (gene: string, kind: "top-level" | "express") =>
    existsSync(join(projectDir, `MARKER-${gene}-${kind}`));

  const output = () =>
    [
      ...errorSpy.mock.calls.map((c) => String(c[0])),
      ...logSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");

  function gateThat(passes: boolean) {
    const l0Check = vi.fn(() =>
      passes
        ? { passed: true, violations: [], checksPerformed: 4 }
        : { passed: false, violations: ["domain 'evil.hack' is not in the allowed list"], checksPerformed: 4 },
    );
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => ({ l0Check }) }));
    return l0Check;
  }

  async function runAgent(args: string[]): Promise<void> {
    const { agentRunCommand } = await import("../../src/commands/agent-run.js");
    await agentRunCommand.parseAsync(["agent-x", ...args], { from: "user" }).catch(() => {});
  }

  beforeEach(() => {
    vi.resetModules();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-agent-installed-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.doUnmock("../../src/utils/binding.js");
  });

  it("G1. Seq: an installed gene is refused even when the L0 gate passes", async () => {
    gateThat(true);
    writeGene("outsider", { installed: true });
    writeAgent(["outsider"], "Seq");

    await runAgent([]);

    expect(marked("outsider", "top-level")).toBe(false);
    expect(marked("outsider", "express")).toBe(false);
    expect(output()).toContain("--trust-unsigned");
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("G2. Seq: --trust-unsigned lets the same installed gene run", async () => {
    gateThat(true);
    writeGene("outsider", { installed: true });
    writeAgent(["outsider"], "Seq");

    await runAgent(["--trust-unsigned"]);

    expect(marked("outsider", "express")).toBe(true);
  });

  it("G3. Seq: --trust-unsigned is consent to run unsandboxed, not to skip L0", async () => {
    gateThat(false);
    writeGene("outsider", { installed: true, domain: "evil.hack" });
    writeAgent(["outsider"], "Seq");

    await runAgent(["--trust-unsigned"]);

    expect(output()).toContain("L0 gate blocked");
    expect(marked("outsider", "top-level")).toBe(false);
    expect(marked("outsider", "express")).toBe(false);
  });

  it("G4. Seq: an L0 violation blocks a local gene before its module is loaded", async () => {
    gateThat(false);
    writeGene("local", { installed: false, domain: "evil.hack" });
    writeAgent(["local"], "Seq");

    await runAgent([]);

    expect(output()).toContain("L0 gate blocked");
    // Regression point: the gate used to run after `import()`, so the
    // module's top-level code had already executed by the time it said no.
    expect(marked("local", "top-level")).toBe(false);
  });

  it("G5. TryPool: an installed gene is refused, and the pool fails over to a local one", async () => {
    gateThat(true);
    writeGene("outsider", { installed: true });
    writeGene("local", { installed: false });
    writeAgent(["outsider", "local"], "TryPool");

    await runAgent([]);

    expect(marked("outsider", "top-level")).toBe(false);
    expect(marked("outsider", "express")).toBe(false);
    expect(marked("local", "express")).toBe(true);
  });

  it("G6. Control: a local gene still runs without any flag", async () => {
    gateThat(true);
    writeGene("local", { installed: false });
    writeAgent(["local"], "Seq");

    await runAgent([]);

    expect(marked("local", "express")).toBe(true);
    expect(output()).not.toContain("--trust-unsigned");
  });
});
