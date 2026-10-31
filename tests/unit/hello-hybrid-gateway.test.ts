/**
 * `rotifer hello` gives a Hybrid gene its network gateway (#444).
 *
 * executeGenomePipeline called every gene as `express(current)`. A Hybrid
 * gene reaches the network only through the `gatewayFetch` on its second
 * argument, so the doc-qa template's doc-retrieval stopped with "gatewayFetch
 * is required" — while `run`, `test` and `agent run` all inject it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeGenomePipeline } from "../../src/commands/hello.js";

const SCHEMA = { type: "object" };

function writeGene(genesDir: string, name: string, phenotype: Record<string, unknown>) {
  const dir = join(genesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "phenotype.json"),
    JSON.stringify({ domain: "test.hello", version: "0.1.0", createdAt: 0, inputSchema: SCHEMA, outputSchema: SCHEMA, ...phenotype }),
  );
  writeFileSync(
    join(dir, "index.mjs"),
    "export function express(input, ctx) {\n" +
      "  return { hasGateway: typeof ctx?.gatewayFetch === 'function', argCount: arguments.length };\n" +
      "}\n",
  );
}

describe("hello's genome pipeline (#444)", () => {
  let genesDir: string;

  beforeEach(() => {
    genesDir = join(mkdtempSync(join(tmpdir(), "rotifer-hello-hybrid-")), "genes");
    writeGene(genesDir, "hybrid-gene", {
      fidelity: "Hybrid",
      network: { allowedDomains: ["api.example.test"] },
    });
    writeGene(genesDir, "native-gene", { fidelity: "Native" });
  });

  afterEach(() => {
    rmSync(join(genesDir, ".."), { recursive: true, force: true });
  });

  it("passes a Hybrid gene the gatewayFetch it declares a network for", async () => {
    const outcome = await executeGenomePipeline(["hybrid-gene"], genesDir, {});
    expect(outcome.failed).toBe(false);
    expect(outcome.result).toMatchObject({ hasGateway: true });
  });

  it("calls any other gene with its input alone, as before", async () => {
    const outcome = await executeGenomePipeline(["native-gene"], genesDir, {});
    expect(outcome.failed).toBe(false);
    expect(outcome.result).toEqual({ hasGateway: false, argCount: 1 });
  });
});
