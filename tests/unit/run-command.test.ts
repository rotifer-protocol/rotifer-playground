import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("run command", () => {
  let projectDir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-run-command-"));
    mkdirSync(join(projectDir, "genes", "test-gene"), { recursive: true });

    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }, null, 2),
    );
    writeFileSync(
      join(projectDir, "genes", "test-gene", "phenotype.json"),
      JSON.stringify({
        domain: "test.unit",
        version: "0.2.0",
        fidelity: "Native",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
      }, null, 2),
    );
    writeFileSync(join(projectDir, "genes", "test-gene", "gene.ir.wasm"), "not-real-wasm");

    // Point the project lookup at projectDir without process.chdir(): Stryker runs tests in worker threads, where chdir throws (#405).
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(projectDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(projectDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("exits non-zero when sandbox execution returns success=false", async () => {
    vi.doMock("../../src/utils/binding.js", () => ({
      tryLoadBinding: () => ({
        executeGene: () => ({
          success: false,
          errorMessage: "sandbox boom",
          durationMs: 5,
        }),
      }),
    }));

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => { throw new Error(`EXIT:${code}`); }) as never);

    const { runCommand } = await import("../../src/commands/run.js");

    await expect(
      runCommand.parseAsync(["test-gene"], { from: "user" })
    ).rejects.toThrow("EXIT:1");

    const joined = [
      ...errorSpy.mock.calls.map((c) => String(c[0])),
      ...logSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");

    expect(joined).toContain("Execution failed: sandbox boom");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
