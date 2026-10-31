/**
 * Run a scenario (default scenario.json) against the agent-memory edge
 * function on a local Supabase stack and print normalized results as JSON.
 *
 * "advance" steps move this agent's clock forward by shifting its entries'
 * updated_at back by the same amount, as a privileged session with triggers
 * off (expiry depends only on now - updated_at; clients cannot move the
 * Cloud clock). Each result lists the purged entry ids from
 * the response's "expired".
 *
 *   supabase start; supabase functions serve agent-memory &
 *   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=... JWT_SECRET=... \
 *   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     deno run --allow-net --allow-env --allow-run=psql --allow-read=. run-cloud.ts > cloud.json
 *
 * Same keys as l2-smoke.ts (local stack only). One throwaway user is created
 * in the local auth.users and removed at the end.
 */

import { localUrl } from "../local-only.ts";
import { errorCode, materialize, normalize, normalizeExpired, scenarioName, sleep, STEP_PAUSE_MS } from "./common.mjs";

const URL_BASE = localUrl("SUPABASE_URL", Deno.env.get("SUPABASE_URL"), "http://127.0.0.1:54321");
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SECRET = Deno.env.get("JWT_SECRET")!;
const DB_URL = localUrl("DB_URL", Deno.env.get("DB_URL"), "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
const USER = "b3e11111-1111-4111-8111-111111111111";

const scenario = JSON.parse(await Deno.readTextFile(new URL(`./${scenarioName(Deno.args[0])}`, import.meta.url)));

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function mint(sub: string): Promise<string> {
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + 900 })));
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function psql(sql: string): Promise<void> {
  const out = await new Deno.Command("psql", { args: [DB_URL, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql] }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

async function call(token: string, op: string, body: unknown) {
  const res = await fetch(`${URL_BASE}/functions/v1/agent-memory/${op}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

await psql(`DELETE FROM auth.users WHERE id = '${USER}';
  INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('${USER}', 'parity@example.com', '{"user_name":"parity_user"}');`);

const results: unknown[] = [];
try {
  const token = await mint(USER);
  const agentId = scenario.agentId;
  for (const step of scenario.steps) {
    if (step.op === "advance") {
      await psql(`SET session_replication_role = replica;
        UPDATE agent_memory_entries SET updated_at = updated_at - interval '${Number(step.seconds)} seconds'
         WHERE owner_id = '${USER}' AND agent_id = '${agentId}';`);
      results.push({ id: step.id, result: { ok: null, expired: [] } });
      await sleep(STEP_PAUSE_MS);
      continue;
    }
    let body: Record<string, unknown>;
    let op = step.op;
    if (op === "create") {
      op = "register";
      body = { agentId, quota: step.quota };
    } else if (op === "usage") {
      op = "register";
      body = { agentId };
    } else {
      const caller = scenario.genes[step.as];
      const req = materialize(step.request, scenario);
      body = op === "query" ? { agentId, caller, filter: req } : { agentId, caller, ...req };
    }
    const r = await call(token, op, body);
    let result;
    if (r.status !== 200) {
      result = { error: errorCode(r.body?.error?.code ?? `HTTP ${r.status}`) };
    } else {
      const unwrapped = {
        create: r.body.memory,
        usage: r.body.memory,
        write: r.body.entry,
        read: r.body.entry,
        query: r.body.entries,
        delete: null,
      }[step.op as "create" | "usage" | "write" | "read" | "query" | "delete"];
      result = { ok: normalize(step.op, unwrapped) };
    }
    (result as Record<string, unknown>).expired = normalizeExpired(
      ((r.body?.expired ?? []) as { entryId: string }[]).map((e) => e.entryId),
    );
    results.push({ id: step.id, result });
    await sleep(STEP_PAUSE_MS);
  }
} finally {
  await psql(`DELETE FROM agent_memory_containers WHERE owner_id = '${USER}'; DELETE FROM auth.users WHERE id = '${USER}';`);
}
console.log(JSON.stringify({ binding: "cloud", results }, null, 1));
