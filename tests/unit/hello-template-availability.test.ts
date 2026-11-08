/**
 * Keeps "this template works out of the box" true (T-167).
 *
 * Offline on purpose: this runs on every PR, and a Registry outage must not
 * fail a PR that has nothing to do with it. What needs the real Registry — a
 * `cloud` template's genes existing there with code — is in
 * tests/live/cloud-live.test.ts, on the daily schedule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const fakeBinding = vi.hoisted(() => ({
  available: true,
  executeGene: vi.fn(),
  l0Check: vi.fn(() => ({ passed: true, violations: [], checksPerformed: 1 })),
}));

vi.mock("../../src/utils/binding.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tryLoadBinding: () => (fakeBinding.available ? fakeBinding : null),
}));

import { TEMPLATES, executeGenomePipeline } from "../../src/commands/hello.js";
import { GENES_SEEDED_BY_INIT } from "../../src/commands/init.js";

const REPO = join(__dirname, "..", "..");
const genesDirInRepo = join(REPO, "genes");
const npmignore = readFileSync(join(genesDirInRepo, ".npmignore"), "utf-8").split("\n").map((l) => l.trim());

describe("templates marked bundled really are", () => {
  const bundled = TEMPLATES.filter((t) => t.availability === "bundled");

  it("has at least one, or the README's first command has nothing to run", () => {
    expect(bundled.map((t) => t.id)).toContain("quality-advisor");
  });

  for (const template of bundled) {
    for (const gene of template.genes) {
      it(`${template.id}: init copies ${gene}`, () => {
        expect(GENES_SEEDED_BY_INIT).toContain(gene);
      });

      it(`${template.id}: ${gene} has runnable source in genes/`, () => {
        expect(existsSync(join(genesDirInRepo, gene, "phenotype.json"))).toBe(true);
        expect(["index.ts", "index.js", "index.mjs"].some((f) => existsSync(join(genesDirInRepo, gene, f)))).toBe(true);
      });

      it(`${template.id}: ${gene} is let into the npm package`, () => {
        expect(npmignore).toContain(`!${gene}/`);
        expect(npmignore).toContain(`!${gene}/**`);
      });
    }
  }
});

describe("every template declares where its genes come from", () => {
  it("uses only the three known values", () => {
    for (const t of TEMPLATES) {
      expect(["bundled", "cloud", "unavailable"]).toContain(t.availability);
    }
  });
});

describe("hello's pipeline does not report work that did not happen", () => {
  let root: string;
  let genesDir: string;

  function gene(name: string, phenotype: Record<string, unknown> = {}): string {
    const dir = join(genesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "phenotype.json"),
      JSON.stringify({ name, version: "0.1.0", domain: "t", fidelity: "Native", inputSchema: {}, outputSchema: {}, ...phenotype }),
    );
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-hello-pipeline-"));
    genesDir = join(root, "genes");
    fakeBinding.executeGene.mockReset();
    fakeBinding.available = true;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("fails on a gene with neither source nor WASM, naming its fidelity", async () => {
    gene("empty", { fidelity: "Hybrid" });
    const outcome = await executeGenomePipeline(["empty"], genesDir, { q: 1 });
    expect(outcome.failed).toBe(true);
    expect(outcome.failedGene).toBe("empty");
    expect(outcome.error).toMatch(/no runnable code/);
    expect(outcome.error).toMatch(/Hybrid/);
  });

  it("does not run the genes after one with no code", async () => {
    gene("empty");
    const second = gene("second");
    writeFileSync(join(second, "index.mjs"), `export function express() { return { ran: true }; }\n`);
    const outcome = await executeGenomePipeline(["empty", "second"], genesDir, {});
    expect(outcome.failed).toBe(true);
    expect(outcome.result).not.toMatchObject({ ran: true });
  });

  it("fails on a source file that exports no express()", async () => {
    const dir = gene("no-express");
    writeFileSync(join(dir, "index.mjs"), `export const nothing = 1;\n`);
    const outcome = await executeGenomePipeline(["no-express"], genesDir, {});
    expect(outcome.failed).toBe(true);
    expect(outcome.failedGene).toBe("no-express");
    expect(outcome.error).toMatch(/express/);
  });

  it("runs a WASM-only gene, the way an installed Native gene arrives, through the sandbox", async () => {
    const dir = gene("from-cloud", { irHash: "abc" });
    writeFileSync(join(dir, "gene.ir.wasm"), Buffer.from([0, 97, 115, 109]));
    fakeBinding.executeGene.mockReturnValue({
      success: true, output: { computed: 42 }, errorMessage: null, fuelConsumed: 1, memoryPeakKb: 1, durationMs: 1, sandboxType: "wasm",
    });

    const outcome = await executeGenomePipeline(["from-cloud"], genesDir, { n: 21 });

    expect(outcome.failed).toBe(false);
    expect(outcome.result).toEqual({ computed: 42 });
    expect(fakeBinding.executeGene).toHaveBeenCalledTimes(1);
    const [wasm, input, phenotype] = fakeBinding.executeGene.mock.calls[0];
    expect(Buffer.isBuffer(wasm)).toBe(true);
    expect(JSON.parse(input as string)).toEqual({ n: 21 });
    // The same call `agent run` makes: the declared phenotype, minus irHash.
    expect(JSON.parse(phenotype as string)).toMatchObject({ name: "from-cloud", fidelity: "Native" });
    expect(JSON.parse(phenotype as string)).not.toHaveProperty("irHash");
  });

  it("fails when the sandbox reports the gene failed", async () => {
    const dir = gene("from-cloud");
    writeFileSync(join(dir, "gene.ir.wasm"), Buffer.from([0, 97, 115, 109]));
    fakeBinding.executeGene.mockReturnValue({
      success: false, output: null, errorMessage: "trap", fuelConsumed: 1, memoryPeakKb: 1, durationMs: 1, sandboxType: "wasm",
    });
    const outcome = await executeGenomePipeline(["from-cloud"], genesDir, {});
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toBe("trap");
  });

  it("fails plainly on a local WASM-only gene when the sandbox did not load", async () => {
    const dir = gene("local-wasm");
    writeFileSync(join(dir, "gene.ir.wasm"), Buffer.from([0, 97, 115, 109]));
    fakeBinding.available = false;
    const outcome = await executeGenomePipeline(["local-wasm"], genesDir, {});
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toMatch(/sandbox/);
  });

  it("keeps a gene with source on the source path", async () => {
    const dir = gene("both");
    writeFileSync(join(dir, "gene.ir.wasm"), Buffer.from([0, 97, 115, 109]));
    writeFileSync(join(dir, "index.mjs"), `export function express() { return { via: "source" }; }\n`);
    const outcome = await executeGenomePipeline(["both"], genesDir, {});
    expect(outcome.result).toEqual({ via: "source" });
    expect(fakeBinding.executeGene).not.toHaveBeenCalled();
  });

  it("holds a WASM-only gene to the L0 gate before the sandbox", async () => {
    const dir = gene("blocked");
    writeFileSync(join(dir, "gene.ir.wasm"), Buffer.from([0, 97, 115, 109]));
    fakeBinding.l0Check.mockReturnValueOnce({ passed: false, violations: ["nope"], checksPerformed: 1 });
    const outcome = await executeGenomePipeline(["blocked"], genesDir, {});
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toMatch(/L0/);
    expect(fakeBinding.executeGene).not.toHaveBeenCalled();
  });
});
