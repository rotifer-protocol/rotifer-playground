import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("printProtocolInsights", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let projectDir: string;
  let genesDir: string;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-agent-snapshot-"));
    genesDir = join(projectDir, "genes");
    mkdirSync(join(genesDir, "alpha"), { recursive: true });
    mkdirSync(join(genesDir, "beta"), { recursive: true });

    writeFileSync(
      join(genesDir, "alpha", "phenotype.json"),
      JSON.stringify({ domain: "web3.analysis", fidelity: "Native" }, null, 2),
    );
    writeFileSync(join(genesDir, "alpha", "index.ts"), "export function express() { return {}; }\n");

    writeFileSync(
      join(genesDir, "beta", "phenotype.json"),
      JSON.stringify({ domain: "web3.security", fidelity: "Wrapped" }, null, 2),
    );
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("prints a deterministic genome snapshot without heuristic fitness wording", async () => {
    const { printProtocolInsights } = await import("../../src/commands/agent-run.js");

    printProtocolInsights(["alpha", "beta"], genesDir, 123);
    const first = logSpy.mock.calls.map((c) => String(c[0])).join("\n");

    logSpy.mockClear();
    printProtocolInsights(["alpha", "beta"], genesDir, 123);
    const second = logSpy.mock.calls.map((c) => String(c[0])).join("\n");

    expect(first).toContain("Genome Snapshot");
    expect(first).toContain("Distinct Domains");
    expect(first).toContain("Executable Genes");
    expect(first).toContain("Run Duration");
    expect(first).not.toContain("Protocol Insights");
    expect(first).not.toContain("Fitness Score");
    expect(first).toBe(second);
  });
});
