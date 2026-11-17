import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CloudCredentials } from "../../src/cloud/types.js";

/**
 * `rotifer run` and `rotifer agent run` refuse to load an external gene (wrapped
 * from ClawHub, or installed from Cloud) on the unsandboxed Node.js path unless
 * the user passes --trust-unsigned. Three other entry points loaded the same
 * gene's source with the host's full privileges and asked nobody:
 *
 *   - `rotifer hello`: the pipeline imported any gene that had source, even one
 *     with a compiled artifact beside it, and the output renderer imported the
 *     last gene again to look for display();
 *   - `rotifer test`: the §47.5 T1 suite took the Node path for a gene with no
 *     IR, though Test 6 of the same command refuses that gene;
 *   - `rotifer publish`: the T1 publishing gate did the same.
 *
 * The L0 gate does not cover this: it reads metadata, so a ClawHub-wrapped gene
 * with an ordinary phenotype passes it. The assertions are on what the gene
 * did, not on what the CLI printed: its top-level code writes a marker file the
 * moment the module is loaded, and a refusal must leave none.
 */

const WRAP_MARKER = JSON.stringify({ geneId: "x", name: "outsider", fromClawhub: "some-skill" });

const INPUT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

// One positive case and one negative case. The gene answers both, so the
// negative requirement is unmet and the publish gate blocks either way: when
// the gene is allowed to run, publish still stops before the network.
const SUITE = {
  testCases: [{ input: { text: "hi" } }, { input: { text: 42 } }],
  config: { fuzzIterations: 10, seed: 1 },
};

describe("an external gene is not loaded on Node.js without --trust-unsigned", () => {
  let projectDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const genesDir = () => join(projectDir, "genes");

  function writeGene(name: string, opts: { external: boolean; wasm?: boolean; suite?: boolean }): string {
    const geneDir = join(genesDir(), name);
    mkdirSync(geneDir, { recursive: true });
    writeFileSync(
      join(geneDir, "phenotype.json"),
      JSON.stringify({
        domain: "general", version: "0.1.0", fidelity: "Wrapped",
        inputSchema: INPUT_SCHEMA,
        outputSchema: { type: "object" },
      }),
    );
    const marker = JSON.stringify(join(projectDir, `LOADED-${name}`));
    writeFileSync(
      join(geneDir, "index.ts"),
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${marker}, "loaded");\n` +
        `export function express(input) { return { ok: true }; }\n` +
        `export function display(output) {}\n`,
    );
    if (opts.external) writeFileSync(join(geneDir, ".gene-manifest.json"), WRAP_MARKER);
    if (opts.wasm) writeFileSync(join(geneDir, "gene.ir.wasm"), "\0asm\x01\x00\x00\x00");
    if (opts.suite) writeFileSync(join(geneDir, "testsuite.json"), JSON.stringify(SUITE));
    return geneDir;
  }

  const loaded = (name: string) => existsSync(join(projectDir, `LOADED-${name}`));

  const output = () =>
    [
      ...errorSpy.mock.calls.map((c) => String(c[0])),
      ...logSpy.mock.calls.map((c) => String(c[0])),
    ].join("\n");

  beforeEach(() => {
    vi.resetModules();
    projectDir = mkdtempSync(join(tmpdir(), "rotifer-external-node-"));
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "test", version: "0.1.0", author: "test", genes_dir: "genes" }),
    );
    // The L0 gate runs and passes: what stops the gene has to be the consent
    // check, not L0 being unable to run.
    const l0Check = vi.fn(() => ({ passed: true, violations: [], checksPerformed: 4 }));
    vi.doMock("../../src/utils/binding.js", () => ({ tryLoadBinding: () => ({ l0Check }) }));
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
    vi.doUnmock("../../src/commands/agent-run.js");
  });

  type Pipeline = (g: string[], d: string, i: unknown, o?: { trustUnsigned?: boolean }) =>
    Promise<{ failed?: boolean; error?: string; result?: unknown }>;
  type Display = (g: string, d: string, out: unknown, o: { verbose: boolean; trustUnsigned?: boolean }) => Promise<boolean>;

  const hello = async () => {
    const mod = (await import("../../src/commands/hello.js")) as Record<string, unknown>;
    return { pipeline: mod.executeGenomePipeline as Pipeline, display: mod.tryGeneDisplay as Display };
  };

  describe("rotifer hello", () => {
    it("E1. a ClawHub-wrapped gene with only source is refused, and its module is never loaded", async () => {
      writeGene("outsider", { external: true });
      const { pipeline } = await hello();

      const result = await pipeline(["outsider"], genesDir(), { text: "hi" });

      expect(loaded("outsider")).toBe(false);
      expect(result.failed).toBe(true);
      expect(String(result.error)).toContain("Genes wrapped from ClawHub cannot run via Node.js without sandbox.");
      expect(String(result.error)).toContain("--trust-unsigned");
    });

    it("E2. --trust-unsigned lets the same gene run on Node.js, as under `rotifer run`", async () => {
      writeGene("outsider", { external: true });
      const { pipeline } = await hello();

      const result = await pipeline(["outsider"], genesDir(), { text: "hi" }, { trustUnsigned: true });

      expect(loaded("outsider")).toBe(true);
      expect(result.failed).toBeFalsy();
    });

    it("E3. an external gene with a compiled artifact runs in the sandbox, not from its source", async () => {
      writeGene("outsider", { external: true, wasm: true });
      const executor = vi.fn(async () => ({ success: true, output: { via: "sandbox" }, engine: "wasm", durationMs: 0 }));
      const build = vi.fn(async () => executor);
      vi.doMock("../../src/commands/agent-run.js", async (importOriginal) => ({
        ...(await importOriginal<Record<string, unknown>>()),
        buildGeneExecutor: build,
      }));
      const { pipeline } = await hello();

      const result = await pipeline(["outsider"], genesDir(), { text: "hi" });

      expect(loaded("outsider")).toBe(false);
      expect(build).toHaveBeenCalled();
      expect(result.failed).toBeFalsy();
      expect(result.result).toEqual({ via: "sandbox" });
    });

    it("E4. the output renderer does not load an external gene to find display()", async () => {
      writeGene("outsider", { external: true });
      const { display } = await hello();

      const rendered = await display("outsider", genesDir(), { ok: true }, { verbose: false });

      expect(loaded("outsider")).toBe(false);
      expect(rendered).toBe(false);
    });

    it("E5. the renderer loads it when the user passed --trust-unsigned", async () => {
      writeGene("outsider", { external: true });
      const { display } = await hello();

      const rendered = await display("outsider", genesDir(), { ok: true }, { verbose: false, trustUnsigned: true });

      expect(loaded("outsider")).toBe(true);
      expect(rendered).toBe(true);
    });

    it("E6. a local gene with source still runs from source and renders with its display()", async () => {
      writeGene("mine", { external: false, wasm: true });
      const { pipeline, display } = await hello();

      const result = await pipeline(["mine"], genesDir(), { text: "hi" });
      expect(result.failed).toBeFalsy();
      expect(loaded("mine")).toBe(true);
      expect(await display("mine", genesDir(), { ok: true }, { verbose: false })).toBe(true);
    });
  });

  describe("rotifer test", () => {
    const runTest = async (name: string) => {
      const { testCommand } = await import("../../src/commands/test.js");
      await testCommand.parseAsync([name], { from: "user" }).catch(() => {});
    };

    it("E7. the T1 suite does not load an external gene that has no IR", async () => {
      writeGene("outsider", { external: true, suite: true });

      await runTest("outsider");

      expect(loaded("outsider")).toBe(false);
      expect(output()).toContain("T1 TestSuite: Genes wrapped from ClawHub cannot run via Node.js without sandbox.");
      expect(output()).toContain("rotifer compile outsider");
    });

    it("E8. a local gene with no IR still has its suite run on Node.js", async () => {
      writeGene("mine", { external: false, suite: true });

      await runTest("mine");

      expect(loaded("mine")).toBe(true);
      expect(output()).toContain("T1 TestSuite (spec §47.5, via Node)");
    });
  });

  describe("rotifer publish", () => {
    const CREDS: CloudCredentials = {
      access_token: "test-token-not-used-offline",
      refresh_token: "test-refresh-not-used-offline",
      expires_at: Date.now() + 3_600_000,
      provider: "github",
      user: {
        id: "00000000-0000-0000-0000-000000000000",
        username: "offline-test",
        avatar_url: null,
        provider_id: "offline-test",
      },
    } as CloudCredentials;

    const publish = async (name: string, geneDir: string, trustUnsigned?: boolean) => {
      const { publishSingleGene } = await import("../../src/commands/publish.js");
      return publishSingleGene(
        name,
        geneDir,
        CREDS,
        { skipSecurity: true, skipArena: true, skipVg: true, ...(trustUnsigned ? { trustUnsigned } : {}) },
        false,
      );
    };

    it("E9. the T1 gate does not load an uncompiled external gene, and says how to go on", async () => {
      const geneDir = writeGene("outsider", { external: true, suite: true });

      const result = await publish("outsider", geneDir);

      expect(loaded("outsider")).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/§47\.5 T1 gate/);
      expect(output()).toContain("Genes wrapped from ClawHub cannot run via Node.js without sandbox.");
      expect(output()).toContain("rotifer compile <gene>");
      expect(output()).toContain("--trust-unsigned");
    });

    it("E10. with --trust-unsigned the gate runs the suite on Node.js, as before", async () => {
      const geneDir = writeGene("outsider", { external: true, suite: true });

      const result = await publish("outsider", geneDir, true);

      expect(loaded("outsider")).toBe(true);
      // The gene answers the negative case, so the gate still blocks: on the
      // verdict now, not on being unable to run it.
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/T1 not satisfied/);
    });
  });
});
