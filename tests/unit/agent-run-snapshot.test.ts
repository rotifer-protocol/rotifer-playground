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

  // `agent run` executes a gene from gene.ir.wasm in the WASM sandbox before it
  // ever looks for index.ts, so a compiled Native gene with no source next to
  // it (as `rotifer install` leaves one) runs. The snapshot counted only source
  // files and reported "Executable Genes: 0/1" right after that gene had run.
  it("counts a compiled Native gene with no source file as executable", async () => {
    const { printProtocolInsights } = await import("../../src/commands/agent-run.js");
    const plain = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    mkdirSync(join(genesDir, "gamma"), { recursive: true });
    writeFileSync(
      join(genesDir, "gamma", "phenotype.json"),
      JSON.stringify({ domain: "text.x", fidelity: "Native" }, null, 2),
    );
    writeFileSync(join(genesDir, "gamma", "gene.ir.wasm"), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));

    printProtocolInsights(["gamma"], genesDir, 1);
    expect(plain()).toMatch(/Executable Genes\W+1\/1/);
    expect(plain()).not.toContain("metadata-only");

    // A gene with neither wasm nor source still counts as not executable.
    logSpy.mockClear();
    printProtocolInsights(["gamma", "beta"], genesDir, 1);
    expect(plain()).toMatch(/Executable Genes\W+1\/2/);
    expect(plain()).toContain("metadata-only");
  });
});
