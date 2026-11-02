/**
 * End to end against a real local stack: the real function served by the
 * Supabase CLI (gateway JWT check on), real auth (getUser), the real database
 * with the deferred migration applied. No mocks.
 *
 *   supabase start                              (gotrue, kong, postgrest, edge-runtime needed)
 *   psql "$DB_URL" -f supabase/migrations-deferred-v095-por/20261102200000_node_attestation.sql
 *   SUPABASE_URL=http://127.0.0.1:54321 ANON_KEY=<supabase status> SERVICE_ROLE_KEY=<supabase status> \
 *   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres [SUPABASE_WORKDIR=<dir>] \
 *     deno run --allow-net --allow-env --allow-run supabase/functions/node-attestation/e2e.ts
 *
 * Two throwaway accounts are created through the auth admin API and signed
 * in with a password, so the function sees real session tokens; they are
 * deleted at the end. The script makes a throwaway signing key, pseudonym
 * key and node keys in memory and starts `supabase functions serve node-attestation` itself,
 * handing the two server secrets over a pipe (--env-file /dev/stdin), so no
 * key is ever written to disk. It stops the server at the end.
 * SUPABASE_URL and DB_URL must point at this machine (local-only.ts).
 * Exits non-zero on the first failed check.
 */

import { localUrl } from "../agent-memory/local-only.ts";
import { buildJwks } from "./jwks.ts";
import {
  b64url,
  type Bytes,
  challengeMessage,
  fromB64url,
  importPseudonymKey,
  ISSUER,
  libp2pPublicKey,
  peerIdFromPublicKey,
  pseudonym,
  TTL_SECONDS,
  verifyToken,
} from "./por.ts";

const BASE = localUrl("SUPABASE_URL", Deno.env.get("SUPABASE_URL"), "http://127.0.0.1:54321");
const DB_URL = localUrl("DB_URL", Deno.env.get("DB_URL"), "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
const ANON = Deno.env.get("ANON_KEY");
const SERVICE = Deno.env.get("SERVICE_ROLE_KEY");
if (!ANON || !SERVICE) throw new Error("ANON_KEY and SERVICE_ROLE_KEY are required (the local stack's, from supabase status)");
const WORKDIR = Deno.env.get("SUPABASE_WORKDIR");
const FN = `${BASE}/functions/v1/node-attestation`;
const AUD = FN;

const EMAILS = ["e2e-por-1@example.com", "e2e-por-2@example.com"];
const enc = new TextEncoder();
let failures = 0;

function check(ok: boolean, what: string, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
}

async function psql(sql: string): Promise<string> {
  const out = await new Deno.Command("psql", { args: [DB_URL, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql] }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

/** A confirmed account made through the auth admin API, signed in with a password. */
async function account(email: string): Promise<{ id: string; jwt: string }> {
  const password = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const created = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: SERVICE!, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (created.status !== 200) throw new Error(`creating ${email}: ${created.status}`);
  const { id } = await created.json();
  const login = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON!, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (login.status !== 200) throw new Error(`signing in ${email}: ${login.status}`);
  return { id, jwt: (await login.json()).access_token };
}

async function nodeKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const pb = libp2pPublicKey(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  return {
    pb,
    peerId: peerIdFromPublicKey(pb)!,
    sign: async (m: Bytes) => new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, m)),
  };
}
type Node = Awaited<ReturnType<typeof nodeKey>>;

async function call(op: string, jwt: string | null, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers.Authorization = `Bearer ${jwt}`;
  const res = await fetch(`${FN}/${op}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, body: parsed };
}

async function signedIssueBody(jwt: string, user: string, node: Node) {
  const ch = await call("challenge", jwt, {});
  if (ch.status !== 200) throw new Error(`challenge failed: ${ch.status} ${JSON.stringify(ch.body)}`);
  const nonce = fromB64url(ch.body.nonce as string)!;
  const msg = challengeMessage(ch.body.aud as string, user, nonce, ch.body.challengeExp as number);
  return { publicKey: b64url(node.pb), signature: b64url(await node.sign(msg)), nonce: ch.body.nonce, challengeExp: ch.body.challengeExp };
}

async function cleanup(): Promise<void> {
  const emails = EMAILS.map((e) => `'${e}'`).join(", ");
  await psql(`SET session_replication_role = replica;
    DELETE FROM node_attestation_issuances WHERE user_id IN (SELECT id FROM auth.users WHERE email IN (${emails}));
    SET session_replication_role = origin;
    DELETE FROM auth.users WHERE email IN (${emails});`);
}

// ── keys, in memory only ───────────────────────────────────
const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const kid = `e2e-${Date.now()}`;
const privJwk = { ...(await crypto.subtle.exportKey("jwk", signing.privateKey)), kid, alg: "EdDSA" };
const pubJwk = await crypto.subtle.exportKey("jwk", signing.publicKey);
const { jwks } = buildJwks([{ kty: "OKP", crv: "Ed25519", x: pubJwk.x, kid }], [], Math.floor(Date.now() / 1000));
const pseudoRaw = crypto.getRandomValues(new Uint8Array(32));
const pseudoKey = await importPseudonymKey(pseudoRaw);

// ── server ─────────────────────────────────────────────────
const serveArgs = ["functions", "serve", "node-attestation", "--env-file", "/dev/stdin"];
if (WORKDIR) serveArgs.push("--workdir", WORKDIR);
const server = new Deno.Command("supabase", { args: serveArgs, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
{
  const w = server.stdin.getWriter();
  // dotenv: single-quoted values are taken literally.
  await w.write(enc.encode(
    `POR_SIGNING_KEY='${JSON.stringify(privJwk)}'\nPOR_PSEUDONYM_KEY=${b64url(pseudoRaw)}\nNODE_ATTESTATION_AUD=${AUD}\n`,
  ));
  await w.close();
}
const serverLog: string[] = [];
for (const stream of [server.stdout, server.stderr]) {
  (async () => {
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) serverLog.push(chunk);
  })();
}

try {
  await cleanup();
  const { id: U1, jwt: jwt1 } = await account(EMAILS[0]);
  const { id: U2, jwt: jwt2 } = await account(EMAILS[1]);

  // Wait for the function to answer (the edge runtime boots after `serve` starts).
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await call("challenge", jwt1, {});
      // Up means the function itself answered: a 200 or one of its own error codes.
      up = r.status === 200 || String((r.body.error as { code?: unknown } | undefined)?.code ?? "").startsWith("POR_");
      if (!up) await new Promise((res) => setTimeout(res, 1000));
    } catch {
      await new Promise((res) => setTimeout(res, 1000));
    }
  }
  if (!up) throw new Error(`function did not come up:\n${serverLog.join("")}`);
  await psql(`DELETE FROM node_attestation_challenges WHERE user_id = '${U1}'`);

  // 1. challenge, sign, verify, issue
  const n1 = await nodeKey();
  const body1 = await signedIssueBody(jwt1, U1, n1);
  check(body1.nonce !== undefined && fromB64url(body1.nonce as string)?.length === 32, "challenge returns a 32-byte nonce");
  const r1 = await call("issue", jwt1, body1);
  check(r1.status === 200, "issue: 200", JSON.stringify(r1.body));
  const token = r1.body.token as string;
  const now = Math.floor(Date.now() / 1000);
  const v = await verifyToken(token, { issuer: ISSUER, keys: jwks.keys }, now);
  check(v.ok && !v.expired, "the token verifies against a JWKS built by por-jwks from the public key", JSON.stringify(v));
  if (v.ok) {
    check(v.claims.peer_id === n1.peerId, "peer_id is the PeerId of the node key");
    check(v.claims.exp - v.claims.iat === TTL_SECONDS, "lifetime is 7 days");
    check(v.claims.sub === await pseudonym(pseudoKey, U1), "sub is HMAC(K_pseudo, user id)");
  }
  const decoded = token.split(".").slice(0, 2).map((s) => new TextDecoder().decode(fromB64url(s)!)).join("");
  check(!decoded.includes(U1) && !JSON.stringify(r1.body).includes(U1), "P0: no plaintext user id in the token or the response");
  check(JSON.parse(new TextDecoder().decode(fromB64url(token.split(".")[0])!)).kid === kid, "header kid is the signing key's");

  // 2. replay
  const replay = await call("issue", jwt1, body1);
  check(replay.status === 400 && (replay.body.error as { code: string })?.code === "POR_CHALLENGE_INVALID", "P0: a replayed nonce is refused", JSON.stringify(replay.body));

  // 3. limit
  for (const i of [2, 3]) {
    const r = await call("issue", jwt1, await signedIssueBody(jwt1, U1, await nodeKey()));
    check(r.status === 200, `PeerId ${i} of U1 issued`, JSON.stringify(r.body));
  }
  const n4 = await nodeKey();
  const r4 = await call("issue", jwt1, await signedIssueBody(jwt1, U1, n4));
  check(r4.status === 409 && (r4.body.error as { code: string })?.code === "POR_QUOTA_EXCEEDED", "P0: the 4th PeerId is refused", JSON.stringify(r4.body));
  check(!("token" in r4.body), "the refusal carries no token");
  const renew = await call("issue", jwt1, await signedIssueBody(jwt1, U1, n1));
  check(renew.status === 200, "renewing PeerId 1 at the limit is allowed", JSON.stringify(renew.body));

  // 4. rebinding
  const rb = await call("issue", jwt2, await signedIssueBody(jwt2, U2, n1));
  check(rb.status === 409 && (rb.body.error as { code: string })?.code === "POR_PEER_BOUND_ELSEWHERE", "P0: U2 cannot take U1's live PeerId", JSON.stringify(rb.body));

  // 5. a signature made for another account
  const forU1 = await signedIssueBody(jwt1, U1, await nodeKey());
  const stolen = await call("issue", jwt2, forU1);
  check(stolen.status === 403 || stolen.status === 400, "U2 cannot redeem U1's signed challenge", JSON.stringify(stolen.body));

  // 6. not signed in
  const anon = await call("challenge", null, {});
  check(anon.status === 401, "no token: 401", `${anon.status}`);

  // 7. what the database holds
  check(await psql(`SELECT count(*) FROM nodes WHERE user_id = '${U1}'`) === "3", "nodes: 3 rows for U1");
  check(await psql(`SELECT count(*) FROM node_attestation_issuances WHERE user_id = '${U1}'`) === "4", "issuance log: 3 certificates + 1 renewal");
  check(await psql(`SELECT count(*) FROM node_attestation_issuances WHERE peer_id = '${n4.peerId}'`) === "0", "nothing recorded for the refused 4th PeerId");
  check(await psql(`SELECT user_id FROM nodes WHERE peer_id = '${n1.peerId}'`) === U1, "PeerId 1 still belongs to U1");
} finally {
  try {
    await cleanup();
  } finally {
    server.kill("SIGTERM");
    await server.status;
  }
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
Deno.exit(failures === 0 ? 0 : 1);
