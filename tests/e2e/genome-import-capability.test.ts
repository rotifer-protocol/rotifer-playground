import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { hasNativeGeneIdV2 } from "../../src/utils/binding.js";
import { resolveAnonKey } from "../../src/cloud/types.js";
import { startRegistryProxy, type RegistryProxy } from "./genome-registry-proxy.js";
import { CAPABILITY_DOMAIN, GENES, REGISTRY_E2E, cliEnv, runCli } from "./genome-registry-fixture.js";

/**
 * #30-e: on the real Registry, capability mode must read real evidence, reject
 * each candidate for the reason that evidence gives, and fall back to lock mode
 * — and must do so because no candidate qualifies, not because evidence could
 * not be read. (Actually *selecting* a candidate is #30-c's unit test; no Arena
 * row is `verified` yet, see #30-e2.)
 */
describe.runIf(REGISTRY_E2E && hasNativeGeneIdV2())("genome import capability mode against the real Registry", () => {
  const D = join(tmpdir(), `genome-capability-${randomUUID()}`);
  let proxy: RegistryProxy;
  let env: Record<string, string>;
  let capFile: string;

  beforeAll(async () => {
    mkdirSync(join(D, "home"), { recursive: true });
    proxy = await startRegistryProxy();
    env = cliEnv(join(D, "home"), proxy.endpoint);

    // A real Blueprint for grammar-checker, then reduced to capabilities + hints without cloudId.
    expect((await runCli(["init", "src", "--no-genesis"], D, env)).code).toBe(0);
    const src = join(D, "src");
    expect((await runCli(["install", GENES.grammarChecker.id], src, env)).code).toBe(0);
    expect((await runCli(["agent", "create", "cap", "-g", GENES.grammarChecker.name], src, env)).code).toBe(0);
    const full = join(D, "full.rgenome");
    expect((await runCli(["genome", "export", "cap", "-o", full], src, env)).code).toBe(0);
    const bp = JSON.parse(readFileSync(full, "utf-8"));
    expect(bp.capabilities[GENES.grammarChecker.name].domain).toBe(CAPABILITY_DOMAIN);
    delete bp.resolutionHints[GENES.grammarChecker.name].cloudId;
    capFile = join(D, "cap.rgenome");
    writeFileSync(capFile, JSON.stringify(bp));
    expect((await runCli(["init", "dst", "--no-genesis"], D, env)).code).toBe(0);
  }, 300_000);

  afterAll(async () => {
    await proxy?.close();
    rmSync(D, { recursive: true, force: true });
  });

  it("#30-e takes real evidence, rejects each candidate for its real reason, and falls back", async () => {
    const requestsBefore = proxy.requests.length;
    const r = await runCli(["--json", "genome", "import", capFile, "--dry-run"], join(D, "dst"), env);
    expect(r.code, r.out).toBe(0); // evidence read failures exit 1 — this must not be one
    const result = JSON.parse(r.stdout);
    const role = result.roles[0];
    expect(role.mode).toBe("fallback");
    expect(role.fallback).toBe("no-admissible-candidate");
    expect(role.cloudId).toBe(GENES.grammarChecker.id); // lock mode found 0.2.1 through the version list

    // ① evidence comes from the real leaderboard, and is non-empty
    const candidates: any[] = role.candidates;
    expect(candidates.length).toBeGreaterThan(0);
    const board = await fetch(`${proxy.endpoint}/rest/v1/rpc/get_arena_leaderboard`, {
      method: "POST",
      // The public, RLS-guarded publishable key the CLI itself ships with.
      headers: { "content-type": "application/json", apikey: resolveAnonKey(undefined, undefined) },
      body: JSON.stringify({ p_domain: CAPABILITY_DOMAIN, p_limit: 200, p_offset: 0 }),
    }).then((res) => res.json() as Promise<any[]>);
    for (const c of candidates) {
      const real = board.find((b) => b.gene_id === c.cloudId);
      expect(real, `candidate ${c.cloudId} is on the real board`).toBeDefined();
      expect(c.evidence.tier).toBe(real.tier);
      expect(c.evidence.tier).toBeTruthy();
      expect(c.evidence.fitness_value).toBe(real.fitness_value);
      expect(c.evidence.safety_score).toBe(real.safety_score);
      expect(c.evidence.evaluation_method).toBe(real.evaluation_method);
      expect(c.evidence.last_evaluated).toBe(real.last_evaluated);
      expect(c.evidence.safety_score_source).toBe("submitter-declared");

      // ③ the rejection reasons are the ones that evidence implies
      const codes: string[] = c.rejections.map((x: { code: string }) => x.code);
      expect(c.admitted).toBe(false);
      if (real.tier !== "verified") expect(codes).toContain("not-verified");
      if (real.invalidation_reason) expect(codes).toContain("invalidated");
      if (real.fitness_value === null) expect(codes).toContain("missing-evidence");
    }

    // ② each candidate's schema came from getGene(<UUID>) — a real request per candidate
    const seen = proxy.requests.slice(requestsBefore).filter((x) => x === "GET /rest/v1/genes");
    expect(seen.length).toBeGreaterThanOrEqual(candidates.length);

    // ④ the fallback is a decision, not a read failure: nothing was installed and nothing written
    expect(proxy.blockedWrites).toEqual([]);
  }, 300_000);
});
