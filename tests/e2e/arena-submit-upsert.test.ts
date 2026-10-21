/**
 * `arenaSubmit` against a real local Supabase stack (PostgREST + Postgres):
 * re-submitting the same gene must update its arena_entries row.
 *
 * arena_entries has one row per gene (`gene_id` is UNIQUE). The CLI upserts
 * with `Prefer: resolution=merge-duplicates`, and PostgREST resolves that
 * conflict on the primary key unless told otherwise — so without
 * `?on_conflict=gene_id` every second submission of a gene hit
 * arena_entries_gene_id_key and failed with 409, leaving the first values in
 * place (found end to end in T-53). A mocked fetch cannot catch this: the
 * conflict target is decided by PostgREST, which is why this test talks to a
 * real one.
 *
 * Run against a local stack only:
 *   supabase start
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx vitest run tests/e2e/arena-submit-upsert.test.ts
 * Without the three variables the suite is skipped. It refuses any URL that is
 * not localhost, so the service-role key can never reach a remote database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { contentHash } from "../../src/utils/content-hash.js";

const URL_ = process.env.SUPABASE_URL ?? "";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(URL_);
const ready = URL_ !== "" && ANON !== "" && SERVICE !== "";

if (ready && !isLocal) {
  throw new Error(`arena-submit-upsert runs against a local stack only; SUPABASE_URL is ${URL_}`);
}

describe.runIf(ready && isLocal)("arena submit re-submits the same gene (real PostgREST)", () => {
  const saved = {
    HOME: process.env.HOME,
    ROTIFER_CLOUD_ENDPOINT: process.env.ROTIFER_CLOUD_ENDPOINT,
    ROTIFER_CLOUD_ANON_KEY: process.env.ROTIFER_CLOUD_ANON_KEY,
  };
  const tag = randomUUID().slice(0, 8);
  const email = `upsert-${tag}@example.test`;
  const password = `pw-${randomUUID()}`;
  let home = "";
  let userId = "";
  let geneId = "";

  const service = (path: string, init: RequestInit = {}) =>
    fetch(`${URL_}${path}`, {
      ...init,
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    // A user of our own, signed in the way `rotifer login` leaves the CLI.
    const created = await service("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { user_name: `upsert_${tag}` } }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    userId = (await created.json()).id;
    const token = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(token.status).toBe(200);
    const session = await token.json();

    // A published gene owned by that user.
    const phenotype = {
      name: `upsert-${tag}`, version: "0.1.0", domain: "test.upsert", fidelity: "Native",
      inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} },
    };
    const gene = await service("/rest/v1/genes", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        owner_id: userId, name: phenotype.name, domain: phenotype.domain, version: phenotype.version,
        fidelity: "Native", phenotype, published: true, content_hash: contentHash(phenotype),
      }),
    });
    expect(gene.status, await gene.clone().text()).toBe(201);
    geneId = (await gene.json())[0].id;

    home = mkdtempSync(join(tmpdir(), "rotifer-upsert-"));
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    writeFileSync(
      join(home, ".rotifer", "credentials.json"),
      JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: Date.now() + 3_600_000 }),
    );
    process.env.HOME = home;
    process.env.ROTIFER_CLOUD_ENDPOINT = URL_;
    process.env.ROTIFER_CLOUD_ANON_KEY = ANON;
    vi.resetModules();
  }, 60_000);

  afterAll(async () => {
    if (geneId) await service(`/rest/v1/genes?id=eq.${geneId}`, { method: "DELETE" });
    if (userId) await service(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
    if (home) rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const report = (value: number) => ({
    value, base_fitness: value, fidelity_discount: 1, safety_score: 0.9, success_rate: 1,
    latency_score: 0.5, resource_efficiency: 0.5, evaluation_method: "estimated" as const, evaluation_n: 3,
  });

  it("the second submission overwrites the first instead of failing with 409", async () => {
    const { arenaSubmit } = await import("../../src/cloud/client.js");
    await arenaSubmit(geneId, report(0.25));
    await arenaSubmit(geneId, report(0.75));

    const rows = await (await service(`/rest/v1/arena_entries?gene_id=eq.${geneId}&select=fitness_value,base_fitness`)).json();
    expect(rows).toEqual([{ fitness_value: 0.75, base_fitness: 0.75 }]);
  }, 60_000);
});
