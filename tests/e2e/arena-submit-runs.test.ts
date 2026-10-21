/**
 * `rotifer arena submit --cloud` publishes the runs it measured even while the
 * score is filed as `estimated` — against a real local Supabase stack.
 *
 * Every submission is `estimated` while C_util / R_rob are placeholders
 * (ADR-318 D4). The runs were only uploaded for `sandbox` submissions, so none
 * ever reached arena_evaluation_runs: production held 0 rows, and the season
 * median F(g) is scaled by (get_fitness_reference) could never gather a sample
 * (found in T-53). The runs are measurements whatever the score is labelled;
 * they are uploaded whenever the Gene actually ran. The label and the
 * leaderboard tier must not change because of it.
 *
 * Needs a local stack (`supabase start`), SUPABASE_URL / SUPABASE_ANON_KEY /
 * SUPABASE_SERVICE_ROLE_KEY, a built CLI (`npm run build`) and the native
 * module. Skipped otherwise; refuses any non-localhost URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { contentHash } from "../../src/utils/content-hash.js";
import { tryLoadBinding } from "../../src/utils/binding.js";

const URL_ = process.env.SUPABASE_URL ?? "";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(URL_);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(REPO, "dist", "index.js");
const GENE = "particle-spatial";
const ready = URL_ !== "" && ANON !== "" && SERVICE !== "" && existsSync(CLI) && tryLoadBinding() !== null;

if (URL_ !== "" && !isLocal) {
  throw new Error(`arena-submit-runs runs against a local stack only; SUPABASE_URL is ${URL_}`);
}

describe.runIf(ready && isLocal)("an estimated submission still publishes its runs (real stack)", () => {
  const tag = randomUUID().slice(0, 8);
  const email = `runs-${tag}@example.test`;
  const password = `pw-${randomUUID()}`;
  let userId = "";
  let geneId = "";
  let home = "";
  let project = "";
  let run: { code: number; out: string } = { code: -1, out: "" };

  const service = (path: string, init: RequestInit = {}) =>
    fetch(`${URL_}${path}`, {
      ...init,
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    const created = await service("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { user_name: `runs_${tag}` } }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    userId = (await created.json()).id;
    const token = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const session = await token.json();

    // The repo's compiled Native gene, published under that user.
    const phenotype = JSON.parse(readFileSync(join(REPO, "genes", GENE, "phenotype.json"), "utf-8"));
    const gene = await service("/rest/v1/genes", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        owner_id: userId, name: GENE, domain: phenotype.domain, version: phenotype.version,
        fidelity: phenotype.fidelity, phenotype, published: true, content_hash: contentHash(phenotype),
      }),
    });
    expect(gene.status, await gene.clone().text()).toBe(201);
    geneId = (await gene.json())[0].id;

    project = mkdtempSync(join(tmpdir(), "rotifer-runs-project-"));
    writeFileSync(join(project, "rotifer.json"), JSON.stringify({
      name: "runs-e2e", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general",
    }));
    cpSync(join(REPO, "genes", GENE), join(project, "genes", GENE), { recursive: true });
    writeFileSync(join(project, "genes", GENE, ".cloud-manifest.json"), JSON.stringify({
      cloud_id: geneId, owner: `runs_${tag}`, version: phenotype.version,
    }));

    home = mkdtempSync(join(tmpdir(), "rotifer-runs-home-"));
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    writeFileSync(join(home, ".rotifer", "credentials.json"), JSON.stringify({
      access_token: session.access_token, refresh_token: session.refresh_token, expires_at: Date.now() + 3_600_000,
    }));

    try {
      const r = await promisify(execFile)("node", [CLI, "arena", "submit", GENE, "--cloud"], {
        cwd: project,
        encoding: "utf-8",
        timeout: 240_000,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          ROTIFER_CLOUD_ENDPOINT: URL_,
          ROTIFER_CLOUD_ANON_KEY: ANON,
          ROTIFER_TELEMETRY: "off",
          ROTIFER_NO_UPDATE_CHECK: "1",
          FORCE_COLOR: "0",
        },
      });
      run = { code: 0, out: r.stdout + r.stderr };
    } catch (e: any) {
      run = { code: typeof e.code === "number" ? e.code : 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  }, 300_000);

  afterAll(async () => {
    if (geneId) await service(`/rest/v1/genes?id=eq.${geneId}`, { method: "DELETE" });
    if (userId) await service(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
    for (const dir of [home, project]) if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("the submission ran in the sandbox and reached the cloud Arena", () => {
    expect(run.code, run.out).toBe(0);
    expect(run.out).toContain("Sandbox verified (3 runs)");
    expect(run.out).toContain("Submitted to cloud Arena");
  });

  it("its three runs are in arena_evaluation_runs, recorded by the author", async () => {
    const rows = await (await service(
      `/rest/v1/arena_evaluation_runs?gene_id=eq.${geneId}&select=run_index,sandbox_success,latency_ms,resource_cost,evaluator&order=run_index`,
    )).json();
    expect(rows.map((r: { run_index: number }) => r.run_index)).toEqual([0, 1, 2]);
    for (const r of rows) {
      expect(r.evaluator).toBe(userId);
      expect(r.latency_ms).toBeGreaterThan(0);
      expect(r.resource_cost).toBeGreaterThan(0);
    }
  });

  it("the entry is still recorded as estimated, with its run count", async () => {
    const [row] = await (await service(`/rest/v1/arena_entries?gene_id=eq.${geneId}&select=evaluation_method,evaluation_n`)).json();
    expect(row).toEqual({ evaluation_method: "estimated", evaluation_n: 3 });
  });

  it("the leaderboard tier is unchanged by the runs: an estimate does not rank", async () => {
    const board = await (await service("/rest/v1/rpc/get_arena_leaderboard", {
      method: "POST",
      body: JSON.stringify({ p_domain: "sim.particle", p_limit: 200, p_offset: 0 }),
    })).json();
    const mine = board.find((r: { gene_id: string }) => r.gene_id === geneId);
    expect(mine?.tier).toBe("not_evaluated");
  });
});
