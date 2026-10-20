import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { hasNativeGeneIdV2 } from "../../src/utils/binding.js";
import { startRegistryProxy, type RegistryProxy } from "./genome-registry-proxy.js";
import { GENES, REGISTRY_E2E, cliEnv, runCli } from "./genome-registry-fixture.js";

// Real Registry, read-only (#30-a, #30-b, #30-f). Opt in: ROTIFER_E2E_REGISTRY=1.
describe.runIf(REGISTRY_E2E && hasNativeGeneIdV2())("genome export → import --pinned against the real Registry", () => {
  const D = join(tmpdir(), `genome-roundtrip-${randomUUID()}`);
  let proxy: RegistryProxy;
  let env: Record<string, string>;
  const ws = (n: string) => join(D, n);
  const read = (f: string) => JSON.parse(readFileSync(f, "utf-8"));

  async function newWorkspace(name: string): Promise<string> {
    expect((await runCli(["init", name, "--no-genesis"], D, env)).code).toBe(0);
    return ws(name);
  }

  async function installAll(dir: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      const r = await runCli(["install", id], dir, env);
      expect(r.code, r.out).toBe(0);
    }
  }

  /** export → fresh workspace → import --pinned → export again; returns both Blueprints. */
  async function roundtrip(label: string, ids: string[], createArgs: string[]) {
    const src = await newWorkspace(`${label}-src`);
    await installAll(src, ids);
    expect((await runCli(["agent", "create", label, ...createArgs], src, env)).code).toBe(0);
    const first = join(D, `${label}-1.rgenome`);
    expect((await runCli(["genome", "export", label, "-o", first], src, env)).code).toBe(0);

    const dst = await newWorkspace(`${label}-dst`);
    const imp = await runCli(["genome", "import", first, "--pinned"], dst, env);
    expect(imp.code, imp.out).toBe(0);
    const second = join(D, `${label}-2.rgenome`);
    expect((await runCli(["genome", "export", label, "-o", second], dst, env)).code).toBe(0);
    return { first: read(first), second: read(second), dst };
  }

  beforeAll(async () => {
    mkdirSync(join(D, "home"), { recursive: true });
    proxy = await startRegistryProxy();
    env = cliEnv(join(D, "home"), proxy.endpoint);
  });

  afterAll(async () => {
    await proxy?.close();
    rmSync(D, { recursive: true, force: true });
  });

  it("#30-a Native: snapshot.genes and composition survive the round trip", async () => {
    const { first, second } = await roundtrip(
      "native-pair",
      [GENES.grammarChecker.id, GENES.readabilityAnalyzer.id],
      ["-g", GENES.grammarChecker.name, GENES.readabilityAnalyzer.name, "--composition", "Seq"],
    );
    expect(second.snapshot.genes).toEqual(first.snapshot.genes);
    expect(second.snapshot.composition).toEqual(first.snapshot.composition);
    expect(first.resolutionHints[GENES.grammarChecker.name].fidelity).toBe("Native");
  }, 300_000);

  it("#30-a Hybrid: snapshot.genes and composition survive the round trip", async () => {
    const { first, second } = await roundtrip("hybrid-one", [GENES.polymarketScanner.id], ["-g", GENES.polymarketScanner.name]);
    expect(second.snapshot.genes).toEqual(first.snapshot.genes);
    expect(second.snapshot.composition).toEqual(first.snapshot.composition);
    expect(first.resolutionHints[GENES.polymarketScanner.name].fidelity).toBe("Hybrid");
  }, 300_000);

  it("#30-b a geneId with one digit changed fails with geneId mismatch; Wrapped hints fail under --pinned", async () => {
    const src = await newWorkspace("tamper-src");
    await installAll(src, [GENES.textSummarizer.id]);
    expect((await runCli(["agent", "create", "tamper", "-g", GENES.textSummarizer.name], src, env)).code).toBe(0);
    const file = join(D, "tamper.rgenome");
    expect((await runCli(["genome", "export", "tamper", "-o", file], src, env)).code).toBe(0);

    const bp = read(file);
    const id: string = bp.snapshot.genes[0].geneId;
    const tampered = id.slice(0, -1) + (id.endsWith("0") ? "1" : "0");
    bp.snapshot.genes[0].geneId = tampered;
    bp.snapshot.composition.Gene.geneRef.geneId = tampered;
    writeFileSync(file, JSON.stringify(bp));
    const dst = await newWorkspace("tamper-dst");
    const r = await runCli(["genome", "import", file, "--pinned"], dst, env);
    expect(r.code).toBe(1);
    expect(r.out).toContain("geneId mismatch");

    for (const fidelity of ["Wrapped", "wrapped"]) {
      const w = read(file);
      w.snapshot.genes[0].geneId = id;
      w.snapshot.composition.Gene.geneRef.geneId = id;
      w.resolutionHints[GENES.textSummarizer.name].fidelity = fidelity;
      const wf = join(D, `wrapped-${fidelity}.rgenome`);
      writeFileSync(wf, JSON.stringify(w));
      const wr = await runCli(["genome", "import", wf, "--pinned"], dst, env);
      expect(wr.code).toBe(1);
      expect(wr.out).toContain("does not support installing Wrapped genes");
    }
  }, 300_000);

  it("#30-f an older version still imports after the author published a newer one — by cloudId and by version list", async () => {
    const src = await newWorkspace("old-src");
    await installAll(src, [GENES.urlExtractorOld.id]);
    expect((await runCli(["agent", "create", "old", "-g", GENES.urlExtractorOld.name], src, env)).code).toBe(0);
    const file = join(D, "old.rgenome");
    expect((await runCli(["genome", "export", "old", "-o", file], src, env)).code).toBe(0);
    const bp = read(file);
    expect(bp.resolutionHints[GENES.urlExtractorOld.name]).toMatchObject({
      version: GENES.urlExtractorOld.version,
      cloudId: GENES.urlExtractorOld.id,
    });

    for (const variant of ["with-cloudId", "without-cloudId"]) {
      const f = join(D, `old-${variant}.rgenome`);
      const copy = read(file);
      if (variant === "without-cloudId") delete copy.resolutionHints[GENES.urlExtractorOld.name].cloudId;
      writeFileSync(f, JSON.stringify(copy));
      const dst = await newWorkspace(`old-dst-${variant}`);
      const r = await runCli(["--json", "genome", "import", f, "--pinned"], dst, env);
      expect(r.code, r.out).toBe(0);
      const result = JSON.parse(r.stdout);
      expect(result.roles[0].cloudId).toBe(GENES.urlExtractorOld.id);
      expect(result.executionSnapshot.resolvedDeps[GENES.urlExtractorOld.name]).toBe(bp.snapshot.genes[0].geneId);
      const phenotype = read(join(dst, "genes", GENES.urlExtractorOld.name, "phenotype.json"));
      expect(phenotype.version).toBe(GENES.urlExtractorOld.version);
    }
    expect(proxy.requests.some((r) => r.startsWith("GET /rest/v1/genes"))).toBe(true);
  }, 300_000);

  it("never wrote to the Registry; installs were counted through track_download", () => {
    expect(proxy.blockedWrites).toEqual([]);
    expect(proxy.trackedDownloads.length).toBeGreaterThan(0);
    for (const t of proxy.trackedDownloads) expect(t.p_source).toBe("cli");
  });
});
