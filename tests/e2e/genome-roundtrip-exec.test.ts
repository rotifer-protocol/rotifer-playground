import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { hasNativeGeneIdV2 } from "../../src/utils/binding.js";
import { startRegistryProxy, type RegistryProxy } from "./genome-registry-proxy.js";
import { fileURLToPath } from "node:url";
import { GENES, LOCAL_NATIVE_E2E, REGISTRY_E2E, cliEnv, extractFinalOutput, runCli } from "./genome-registry-fixture.js";

/**
 * #30-g: the imported agent behaves like the original — same output for the
 * same input, not just exit 0. Real Registry genes (Native, offline-runnable,
 * all taking { text }). Opt in: ROTIFER_E2E_REGISTRY=1.
 */
describe.runIf(REGISTRY_E2E && hasNativeGeneIdV2())("imported agents run like the originals", () => {
  const D = join(tmpdir(), `genome-exec-${randomUUID()}`);
  let proxy: RegistryProxy;
  let env: Record<string, string>;
  const src = join(D, "src");
  const dst = join(D, "dst");
  const TEXT_A = { text: "Visit https://example.com today. The quick brown fox jumps over the lazy dog." };
  const TEXT_B = { text: "Short note without links, written plainly for a simple test." };

  function agentRecord(dir: string, name: string): any {
    const agentsDir = join(dir, ".rotifer", "agents");
    for (const f of readdirSync(agentsDir)) {
      const a = JSON.parse(readFileSync(join(agentsDir, f), "utf-8"));
      if (a.name === name) return { ...a, file: join(agentsDir, f) };
    }
    throw new Error(`no agent ${name} in ${dir}`);
  }

  async function runAgent(dir: string, name: string, input: unknown): Promise<unknown> {
    const r = await runCli(["agent", "run", name, "--input", JSON.stringify(input)], dir, env);
    expect(r.code, r.out).toBe(0);
    return extractFinalOutput(r.out);
  }

  /** Create in src, export, import --pinned into dst. */
  async function transplant(name: string, createArgs: string[], edit?: (record: any) => void): Promise<void> {
    expect((await runCli(["agent", "create", name, ...createArgs], src, env)).code).toBe(0);
    if (edit) {
      const rec = agentRecord(src, name);
      edit(rec);
      const { file, ...body } = rec;
      writeFileSync(file, JSON.stringify(body, null, 2));
    }
    const file = join(D, `${name}.rgenome`);
    expect((await runCli(["genome", "export", name, "-o", file], src, env)).code).toBe(0);
    const imp = await runCli(["genome", "import", file, "--pinned"], dst, env);
    expect(imp.code, imp.out).toBe(0);
  }

  beforeAll(async () => {
    mkdirSync(join(D, "home"), { recursive: true });
    proxy = await startRegistryProxy();
    env = cliEnv(join(D, "home"), proxy.endpoint);
    expect((await runCli(["init", "src", "--no-genesis"], D, env)).code).toBe(0);
    expect((await runCli(["init", "dst", "--no-genesis"], D, env)).code).toBe(0);
    for (const g of [GENES.grammarChecker, GENES.readabilityAnalyzer, GENES.textSummarizer, GENES.urlExtractorNew]) {
      expect((await runCli(["install", g.id], src, env)).code).toBe(0);
    }
  }, 300_000);

  afterAll(async () => {
    await proxy?.close();
    rmSync(D, { recursive: true, force: true });
  });

  it("Seq", async () => {
    await transplant("x-seq", ["-g", GENES.grammarChecker.name, GENES.readabilityAnalyzer.name, "--composition", "Seq"]);
    expect(await runAgent(dst, "x-seq", TEXT_A)).toEqual(await runAgent(src, "x-seq", TEXT_A));
  }, 300_000);

  it("Par with three branches (flat n-ary after import)", async () => {
    await transplant("x-par", [
      "-g", GENES.grammarChecker.name, GENES.readabilityAnalyzer.name, GENES.textSummarizer.name,
      "--composition", "Par", "--par-merge", "merge",
    ]);
    expect(agentRecord(dst, "x-par").composition).toEqual(agentRecord(src, "x-par").composition);
    expect(await runAgent(dst, "x-par", TEXT_A)).toEqual(await runAgent(src, "x-par", TEXT_A));
  }, 300_000);

  it("Cond takes the same branch for each input, with the original predicate", async () => {
    await transplant("x-cond", ["-g", GENES.urlExtractorNew.name, GENES.grammarChecker.name, "--composition", "Cond"], (rec) => {
      rec.composition.predicate = { field: "text", op: "Contains", value: "https://" };
    });
    expect(agentRecord(dst, "x-cond").composition.predicate).toEqual({ field: "text", op: "Contains", value: "https://" });
    const thenOut = await runAgent(src, "x-cond", TEXT_A);
    const elseOut = await runAgent(src, "x-cond", TEXT_B);
    expect(thenOut).not.toEqual(elseOut);
    expect(await runAgent(dst, "x-cond", TEXT_A)).toEqual(thenOut);
    expect(await runAgent(dst, "x-cond", TEXT_B)).toEqual(elseOut);
  }, 300_000);

  it("Try", async () => {
    await transplant("x-try", ["-g", GENES.textSummarizer.name, GENES.grammarChecker.name, "--composition", "Try"]);
    expect(await runAgent(dst, "x-try", TEXT_A)).toEqual(await runAgent(src, "x-try", TEXT_A));
  }, 300_000);

  // F5 (red-team round 5): the failing path end to end — import → agent run →
  // Rust executor → handler. The body is a real Registry gene given more work
  // than the default 500M fuel allows. No published gene returns its input, so
  // after import only the handler's WASM is swapped for a local probe that
  // does; the agent, the body gene and its v2 ID stay exactly as imported.
  it.runIf(LOCAL_NATIVE_E2E)("Try whose body runs out of fuel: the handler gets FUEL_EXHAUSTED naming the body's v2 ID", async () => {
    const dstFuel = join(D, "dst-fuel");
    expect((await runCli(["init", "dst-fuel", "--no-genesis"], D, env)).code).toBe(0);
    expect((await runCli(["install", GENES.evolveLife.id], src, env)).code).toBe(0);
    const created = await runCli(
      ["agent", "create", "x-try-fuel", "-g", GENES.evolveLife.name, GENES.grammarChecker.name, "--composition", "Try"],
      src,
      env,
    );
    expect(created.code, created.out).toBe(0);
    const file = join(D, "x-try-fuel.rgenome");
    expect((await runCli(["genome", "export", "x-try-fuel", "-o", file], src, env)).code).toBe(0);
    const pin = JSON.parse(readFileSync(file, "utf-8")).snapshot.genes[0];
    expect(pin.role).toBe(GENES.evolveLife.name);
    const imp = await runCli(["genome", "import", file, "--pinned"], dstFuel, env);
    expect(imp.code, imp.out).toBe(0);

    const probe = join(dstFuel, "genes", "echo-probe");
    mkdirSync(probe, { recursive: true });
    writeFileSync(
      join(probe, "phenotype.json"),
      JSON.stringify({
        domain: "test.probe",
        version: "0.1.0",
        fidelity: "Wrapped",
        transparency: "Open",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { received: {} } },
      }),
    );
    writeFileSync(join(probe, "index.ts"), "export function express(input) { return { received: input }; }\n");
    // The TS→WASM toolchain (esbuild, javy) is a dev dependency of this repo.
    // javy-cli keeps its binary in the user's cache directory; link that into
    // the test HOME so it uses the binary already there instead of downloading.
    const bin = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
    const cacheRoot = (home: string) =>
      process.platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache");
    mkdirSync(cacheRoot(env.HOME), { recursive: true });
    const realCache = join(cacheRoot(homedir()), "binarycache");
    if (existsSync(realCache)) symlinkSync(realCache, join(cacheRoot(env.HOME), "binarycache"));
    const compiled = await runCli(["compile", "echo-probe"], dstFuel, { ...env, PATH: `${bin}:${env.PATH}` });
    expect(compiled.code, compiled.out).toBe(0);
    copyFileSync(join(probe, "gene.ir.wasm"), join(dstFuel, "genes", GENES.grammarChecker.name, "gene.ir.wasm"));

    const input = { width: 512, height: 512, generations: 10000, preset: "random", seed: 1 };
    const run = await runCli(["agent", "run", "x-try-fuel", "--input", JSON.stringify(input)], dstFuel, env);
    expect(run.code, run.out).toBe(0);
    const got = extractFinalOutput(run.out) as { received: { error: Record<string, unknown>; original_input: unknown } };
    expect(got.received.error.errorCode).toBe("FUEL_EXHAUSTED");
    expect(got.received.error.geneId).toBe(pin.geneId);
    expect(got.received.original_input).toEqual(input);
  }, 600_000);

  it("wrote nothing to the Registry", () => {
    expect(proxy.blockedWrites).toEqual([]);
  });
});
