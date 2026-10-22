/**
 * The gene delete guard (migration 20261021220000) against a real local
 * Supabase stack (PostgREST + Postgres).
 *
 * A gene's Arena row and evaluation runs cascade away with it, so a client
 * may not delete a published gene or one carrying that evidence. The CLI
 * never deletes genes — it publishes, and takes versions down through
 * unpublish_gene() — so the path that must keep working is publishing, and
 * the path that must stop is a DELETE sent with the author's own token.
 *
 * Run against a local stack only:
 *   supabase start
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx vitest run tests/e2e/gene-delete-guard.test.ts
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
  throw new Error(`gene-delete-guard runs against a local stack only; SUPABASE_URL is ${URL_}`);
}

describe.runIf(ready && isLocal)("a client cannot delete a gene that carries evidence (real PostgREST)", () => {
  const saved = {
    HOME: process.env.HOME,
    ROTIFER_CLOUD_ENDPOINT: process.env.ROTIFER_CLOUD_ENDPOINT,
    ROTIFER_CLOUD_ANON_KEY: process.env.ROTIFER_CLOUD_ANON_KEY,
  };
  const tag = randomUUID().slice(0, 8);
  const email = `delete-${tag}@example.test`;
  const password = `pw-${randomUUID()}`;
  let home = "";
  let userId = "";
  let token = "";
  const created: string[] = [];

  const service = (path: string, init: RequestInit = {}) =>
    fetch(`${URL_}${path}`, {
      ...init,
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  const asUser = (path: string, init: RequestInit = {}) =>
    fetch(`${URL_}${path}`, {
      ...init,
      headers: { apikey: ANON, Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });

  beforeAll(async () => {
    const user = await service("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { user_name: `delete_${tag}` } }),
    });
    expect(user.status, await user.clone().text()).toBe(200);
    userId = (await user.json()).id;
    const signIn = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: ANON, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    expect(signIn.status).toBe(200);
    const session = await signIn.json();
    token = session.access_token;

    // Signed in the way `rotifer login` leaves the CLI.
    home = mkdtempSync(join(tmpdir(), "rotifer-delete-"));
    mkdirSync(join(home, ".rotifer"), { recursive: true });
    writeFileSync(
      join(home, ".rotifer", "credentials.json"),
      JSON.stringify({
        access_token: session.access_token, refresh_token: session.refresh_token,
        expires_at: Date.now() + 3_600_000, provider: "github",
        user: { id: userId, username: `delete_${tag}`, avatar_url: null, provider_id: "" },
      }),
    );
    process.env.HOME = home;
    process.env.ROTIFER_CLOUD_ENDPOINT = URL_;
    process.env.ROTIFER_CLOUD_ANON_KEY = ANON;
    vi.resetModules();
  }, 60_000);

  afterAll(async () => {
    for (const id of created) await service(`/rest/v1/genes?id=eq.${id}`, { method: "DELETE" });
    if (userId) await service(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
    if (home) rmSync(home, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const phenotypeFor = (name: string) => ({
    name, version: "0.1.0", domain: "test.delete", fidelity: "Wrapped",
    inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} },
  });

  it("a gene published through the CLI cannot be deleted with the author's token", async () => {
    const { publishGene } = await import("../../src/cloud/client.js");
    const phenotype = phenotypeFor(`delete-${tag}`);
    const gene = await publishGene({
      name: phenotype.name, domain: phenotype.domain, version: phenotype.version, fidelity: "Wrapped",
      description: "delete guard e2e", phenotype, wasmBytes: null, contentHash: contentHash(phenotype),
    });
    created.push(gene.id);

    const del = await asUser(`/rest/v1/genes?id=eq.${gene.id}`, { method: "DELETE" });
    expect(del.status, await del.clone().text()).toBe(403);
    const left = await (await service(`/rest/v1/genes?id=eq.${gene.id}&select=id`)).json();
    expect(left).toEqual([{ id: gene.id }]);
  }, 60_000);

  it("a never-published draft can still be deleted by its owner", async () => {
    const phenotype = phenotypeFor(`draft-${tag}`);
    const draft = await asUser("/rest/v1/genes", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        owner_id: userId, name: phenotype.name, domain: phenotype.domain, version: phenotype.version,
        fidelity: "Wrapped", phenotype, published: false, content_hash: contentHash(phenotype),
      }),
    });
    expect(draft.status, await draft.clone().text()).toBe(201);
    const id = (await draft.json())[0].id;
    created.push(id);

    const del = await asUser(`/rest/v1/genes?id=eq.${id}`, { method: "DELETE" });
    expect(del.status, await del.clone().text()).toBe(204);
    const left = await (await service(`/rest/v1/genes?id=eq.${id}&select=id`)).json();
    expect(left).toEqual([]);
  }, 60_000);
});
