/**
 * Invocation caller identity (migration 20261021210000) against a real local
 * Supabase stack (PostgREST + Postgres).
 *
 * A signed-in client's report is recorded under its own account, whatever
 * caller it names. The CLI (src/cloud/invocation.ts) and the MCP server send
 * the account id anyway, so their reports must land exactly as before; a
 * report naming someone else must land under the sender.
 *
 * The request bodies below are the CLI's own (recordGeneInvocation): the
 * function itself declines to report under a test runner, so the shape is
 * reproduced rather than called.
 *
 * Run against a local stack only:
 *   supabase start
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npx vitest run tests/e2e/invocation-caller-identity.test.ts
 * Without the three variables the suite is skipped. It refuses any URL that is
 * not localhost, so the service-role key can never reach a remote database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { contentHash } from "../../src/utils/content-hash.js";

const URL_ = process.env.SUPABASE_URL ?? "";
const ANON = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(URL_);
const ready = URL_ !== "" && ANON !== "" && SERVICE !== "";

if (ready && !isLocal) {
  throw new Error(`invocation-caller-identity runs against a local stack only; SUPABASE_URL is ${URL_}`);
}

describe.runIf(ready && isLocal)("an invocation report is attributed to the account that sent it (real PostgREST)", () => {
  const tag = randomUUID().slice(0, 8);
  const users: Record<"author" | "caller", { id: string; token: string }> = {
    author: { id: "", token: "" },
    caller: { id: "", token: "" },
  };
  const genes: string[] = [];

  const service = (path: string, init: RequestInit = {}) =>
    fetch(`${URL_}${path}`, {
      ...init,
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
  const report = (as: "author" | "caller", body: Record<string, unknown>, rpc = "log_gene_invocation_v2") =>
    fetch(`${URL_}/rest/v1/rpc/${rpc}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${users[as].token}` },
      body: JSON.stringify(body),
    });
  const callers = async (geneId: string) =>
    (await (await service(`/rest/v1/gene_invocation_log?gene_id=eq.${geneId}&select=caller_agent_id`)).json())
      .map((r: { caller_agent_id: string }) => r.caller_agent_id);

  beforeAll(async () => {
    for (const who of ["author", "caller"] as const) {
      const email = `${who}-${tag}@example.test`;
      const password = `pw-${randomUUID()}`;
      const created = await service("/auth/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { user_name: `${who}_${tag}` } }),
      });
      expect(created.status, await created.clone().text()).toBe(200);
      users[who].id = (await created.json()).id;
      const signIn = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: ANON, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      expect(signIn.status).toBe(200);
      users[who].token = (await signIn.json()).access_token;
    }
    for (const n of [1, 2]) {
      const phenotype = {
        name: `invoked-${tag}-${n}`, version: "0.1.0", domain: "test.invocation", fidelity: "Wrapped",
        inputSchema: { type: "object", properties: {} }, outputSchema: { type: "object", properties: {} },
      };
      const gene = await service("/rest/v1/genes", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          owner_id: users.author.id, name: phenotype.name, domain: phenotype.domain, version: phenotype.version,
          fidelity: "Wrapped", phenotype, published: true, content_hash: contentHash(phenotype),
        }),
      });
      expect(gene.status, await gene.clone().text()).toBe(201);
      genes.push((await gene.json())[0].id);
    }
  }, 60_000);

  afterAll(async () => {
    for (const id of genes) await service(`/rest/v1/genes?id=eq.${id}`, { method: "DELETE" });
    for (const u of Object.values(users)) if (u.id) await service(`/auth/v1/admin/users/${u.id}`, { method: "DELETE" });
  });

  it("the CLI's report (its own account id, v2 with a channel) is recorded as sent", async () => {
    const res = await report("caller", { p_gene_id: genes[0], p_caller_agent_id: users.caller.id, p_client_channel: "cli" });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await callers(genes[0])).toEqual([users.caller.id]);
  }, 60_000);

  it("a report naming someone else is recorded under the account that sent it", async () => {
    // The original two-argument entry point, as the CLI calls it when the
    // channel is unattributable.
    const res = await report("caller", { p_gene_id: genes[1], p_caller_agent_id: "invented-agent" }, "log_gene_invocation");
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await callers(genes[1])).toEqual([users.caller.id]);
  }, 60_000);

  it("the author's own report is a self-invocation, whatever name it gives", async () => {
    const res = await report("author", { p_gene_id: genes[1], p_caller_agent_id: "not-the-author", p_client_channel: "cli" });
    expect(res.status, await res.clone().text()).toBe(200);
    const rows = await (
      await service(`/rest/v1/gene_invocation_log?gene_id=eq.${genes[1]}&caller_agent_id=eq.${users.author.id}&select=is_self_invocation`)
    ).json();
    expect(rows).toEqual([{ is_self_invocation: true }]);
  }, 60_000);
});
