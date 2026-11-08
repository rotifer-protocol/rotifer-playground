/**
 * `rotifer hello` treats a gene's refusal as a failure on the source path too.
 *
 * Run from WASM, a lone __rotifer_error becomes INVALID_INPUT in the sandbox.
 * Run from source it is just a return value, so the pipeline passed it on and
 * the template reported the refusal as its successful result.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeGenomePipeline } from "../../src/commands/hello.js";

const MESSAGE = "missing required field 'source'";

function writeGene(genesDir: string, name: string, phenotype: Record<string, unknown>, body: string) {
  const dir = join(genesDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "phenotype.json"),
    JSON.stringify({
      domain: "test.hello",
      version: "0.1.0",
      createdAt: 0,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      ...phenotype,
    }),
  );
  writeFileSync(join(dir, "index.mjs"), `export function express(input, ctx) {\n${body}\n}\n`);
}

const REFUSE = `return { __rotifer_error: { message: ${JSON.stringify(MESSAGE)} } };`;

describe("hello's pipeline on a gene that refuses its input", () => {
  let root: string;
  let genesDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-hello-refusal-"));
    genesDir = join(root, "genes");
    writeGene(genesDir, "native-refuser", { fidelity: "Native" }, REFUSE);
    writeGene(
      genesDir,
      "hybrid-refuser",
      { fidelity: "Hybrid", network: { allowedDomains: ["api.example.test"] } },
      `if (typeof ctx?.gatewayFetch !== "function") throw new Error("no gateway");\n${REFUSE}`,
    );
    writeGene(
      genesDir,
      "downstream",
      { fidelity: "Native" },
      `import("node:fs").then((fs) => fs.writeFileSync(${JSON.stringify(join(root, "downstream-ran"))}, ""));\nreturn { ran: true };`,
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it.each(["native-refuser", "hybrid-refuser"])("reports %s as the failed gene, with its reason", async (gene) => {
    const outcome = await executeGenomePipeline([gene], genesDir, {});
    expect(outcome.failed).toBe(true);
    expect(outcome.failedGene).toBe(gene);
    expect(outcome.error).toContain(MESSAGE);
  });

  it("does not run the next gene, or hand it the refusal", async () => {
    const outcome = await executeGenomePipeline(["native-refuser", "downstream"], genesDir, {});
    await new Promise((settle) => setTimeout(settle, 20));
    expect(outcome.failedGene).toBe("native-refuser");
    expect(existsSync(join(root, "downstream-ran"))).toBe(false);
  });

  it("still passes on an output that merely contains the key among others", async () => {
    writeGene(genesDir, "not-a-refusal", { fidelity: "Native" }, `return { __rotifer_error: {}, value: 1 };`);
    const outcome = await executeGenomePipeline(["not-a-refusal"], genesDir, {});
    expect(outcome.failed).toBe(false);
    expect(outcome.result).toEqual({ __rotifer_error: {}, value: 1 });
  });
});
