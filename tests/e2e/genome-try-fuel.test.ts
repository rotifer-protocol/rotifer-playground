import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hasNativeGeneIdV2 } from "../../src/utils/binding.js";
import { startRegistryProxy, type RegistryProxy } from "./genome-registry-proxy.js";
import { GENES, cliEnv, extractFinalOutput, runCli } from "./genome-registry-fixture.js";

/**
 * F5 (red-team round 5): a Try whose body fails, end to end — export → import
 * --pinned → agent run → Rust executor → handler. The handler must get the
 * spec GeneError (#411): errorCode FUEL_EXHAUSTED and the v2 ID of the body
 * that ran.
 *
 * Unlike the other genome e2e suites this one runs by default, CI included:
 * it needs only a native module that has #411 (npm 0.29.0 and later). It reads
 * the public Registry through the write-blocking proxy, so CI depends on the
 * Registry being reachable for this test.
 */
describe.runIf(hasNativeGeneIdV2())("a Try body that runs out of fuel reaches the handler as FUEL_EXHAUSTED", () => {
  const D = join(tmpdir(), `genome-try-fuel-${randomUUID()}`);
  const src = join(D, "src");
  const dst = join(D, "dst");
  let proxy: RegistryProxy;
  let env: Record<string, string>;

  beforeAll(async () => {
    mkdirSync(join(D, "home"), { recursive: true });
    proxy = await startRegistryProxy();
    env = cliEnv(join(D, "home"), proxy.endpoint);
    expect((await runCli(["init", "src", "--no-genesis"], D, env)).code).toBe(0);
    expect((await runCli(["init", "dst", "--no-genesis"], D, env)).code).toBe(0);
    for (const g of [GENES.evolveLife, GENES.grammarChecker]) {
      const r = await runCli(["install", g.id], src, env);
      expect(r.code, r.out).toBe(0);
    }
  }, 300_000);

  afterAll(async () => {
    await proxy?.close();
    rmSync(D, { recursive: true, force: true });
  });

  // The body is a real Registry gene given more work than the default 500M fuel
  // allows. No published gene returns its input, so after import only the
  // handler's WASM is swapped for a local probe that does; the agent, the body
  // gene and its v2 ID stay exactly as imported.
  it("the handler gets errorCode FUEL_EXHAUSTED and the body's v2 ID", async () => {
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
    const imp = await runCli(["genome", "import", file, "--pinned"], dst, env);
    expect(imp.code, imp.out).toBe(0);

    const probe = join(dst, "genes", "echo-probe");
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
    // javy-cli keeps its binary in the user's cache directory; where one exists,
    // link it into the test HOME instead of downloading another (a fresh CI
    // runner has none, and javy-cli fetches its release binary there).
    const bin = fileURLToPath(new URL("../../node_modules/.bin", import.meta.url));
    const cacheRoot = (home: string) =>
      process.platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache");
    mkdirSync(cacheRoot(env.HOME), { recursive: true });
    const realCache = join(cacheRoot(homedir()), "binarycache");
    if (existsSync(realCache)) symlinkSync(realCache, join(cacheRoot(env.HOME), "binarycache"));
    const compiled = await runCli(["compile", "echo-probe"], dst, { ...env, PATH: `${bin}:${env.PATH}` });
    expect(compiled.code, compiled.out).toBe(0);
    copyFileSync(join(probe, "gene.ir.wasm"), join(dst, "genes", GENES.grammarChecker.name, "gene.ir.wasm"));

    const input = { width: 512, height: 512, generations: 10000, preset: "random", seed: 1 };
    const run = await runCli(["agent", "run", "x-try-fuel", "--input", JSON.stringify(input)], dst, env);
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
