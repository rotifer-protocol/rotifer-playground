/**
 * `rotifer network attest` end to end: the real CLI and daemon, the real
 * node-attestation function, real Auth and Postgres on a local stack, and a
 * second real node that checks the certificate it hears in a heartbeat.
 * No mocks. Nothing here touches a hosted project (local-only.ts).
 *
 * Stack setup is the one supabase/functions/node-attestation/e2e.ts describes:
 *
 *   supabase start                              (gotrue, kong, postgrest, edge-runtime needed)
 *   psql "$DB_URL" -f supabase/migrations-deferred-v095-por/20261102200000_node_attestation.sql
 *   (cd crates/rotifer-napi && npx napi build --release --platform) && npm run build
 *   node scripts/use-checkout-napi.mjs          (the CLI must load this checkout's addon;
 *                                                in a worktree, point POR_CLI at a copy that does)
 *   SUPABASE_URL=http://127.0.0.1:54321 ANON_KEY=<supabase status> \
 *   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   [SUPABASE_WORKDIR=<dir>] [POR_ADDON=<path to the built .node>] \
 *     deno run --allow-all tests/por-e2e/run.ts
 *
 * Exits non-zero if any check failed.
 */
import { localUrl } from "../../supabase/functions/agent-memory/local-only.ts";
import { buildJwks } from "../../supabase/functions/node-attestation/jwks.ts";
import { b64url, fromB64url, ISSUER, TTL_SECONDS, verifyToken } from "../../supabase/functions/node-attestation/por.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const BASE = localUrl("SUPABASE_URL", Deno.env.get("SUPABASE_URL"), "http://127.0.0.1:54321");
const DB_URL = localUrl("DB_URL", Deno.env.get("DB_URL"), "postgresql://postgres:postgres@127.0.0.1:54322/postgres");
const ANON = Deno.env.get("ANON_KEY");
if (!ANON) throw new Error("ANON_KEY is required (the local stack's, from supabase status)");
const WORKDIR = Deno.env.get("SUPABASE_WORKDIR");
const FN = `${BASE}/functions/v1/node-attestation`;
const EMAIL = "e2e-por-cli@example.com";
const enc = new TextEncoder();
const dec = new TextDecoder();

let failures = 0;
function check(ok: boolean, what: string, detail = ""): void {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok || !detail ? "" : `: ${detail}`}`);
  if (!ok) failures++;
}

async function psql(sql: string): Promise<string> {
  const out = await new Deno.Command("psql", { args: [DB_URL, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql] }).output();
  if (!out.success) throw new Error(dec.decode(out.stderr));
  return dec.decode(out.stdout).trim();
}

/** For SQL that carries a secret: sent on stdin, so it never appears in a process list. */
async function psqlStdin(sql: string): Promise<void> {
  const p = new Deno.Command("psql", { args: [DB_URL, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"], stdin: "piped", stdout: "null", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(enc.encode(sql));
  await w.close();
  const out = await p.output();
  if (!out.success) throw new Error(dec.decode(out.stderr));
}

async function cleanup(): Promise<void> {
  await psql(`SET session_replication_role = replica;
    DELETE FROM node_attestation_issuances WHERE user_id IN (SELECT id FROM auth.users WHERE email = '${EMAIL}');
    SET session_replication_role = origin;
    DELETE FROM auth.users WHERE email = '${EMAIL}';`);
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ── the CLI, as a user or an agent runs it ─────────────────
const seen: string[] = [];

interface CliResult {
  code: number;
  body: Record<string, any>;
  text: string;
}

async function cli(home: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const out = await new Deno.Command("node", {
    args: [Deno.env.get("POR_CLI") ?? `${REPO}dist/index.js`, ...args],
    env: { HOME: home, ROTIFER_CLOUD_ENDPOINT: BASE, ...env },
    cwd: home,
    stdin: "null",
  }).output();
  const text = dec.decode(out.stdout) + dec.decode(out.stderr);
  seen.push(text);
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(dec.decode(out.stdout));
  } catch {
    // Not every command prints JSON.
  }
  return { code: out.code, body, text };
}

const attest = (home: string, sub: string[], env?: Record<string, string>) => cli(home, ["--json", "network", "attest", ...sub], env);
const ACCEPT = "--accept-public-pseudonym";

function statePath(home: string): string {
  return `${home}/.rotifer/p2p/attestation.json`;
}

function readState(home: string): Record<string, any> {
  return JSON.parse(Deno.readTextFileSync(statePath(home)));
}

async function homeFor(session: { id: string; jwt: string } | null): Promise<string> {
  const home = await Deno.makeTempDir({ prefix: "por-e2e-" });
  if (session) await signIn(home, session.jwt, session.id);
  return home;
}

async function signIn(home: string, jwt: string, id: string): Promise<void> {
  await Deno.mkdir(`${home}/.rotifer`, { recursive: true });
  await Deno.writeTextFile(
    `${home}/.rotifer/credentials.json`,
    JSON.stringify({ access_token: jwt, refresh_token: "", expires_at: Date.now() + 3_600_000, provider: "email", user: { id, username: "e2e", avatar_url: "", provider_id: "" } }),
    { mode: 0o600 },
  );
}

function failed(r: CliResult, code: string, what: string): void {
  check(r.code === 1 && r.body.ok === false && r.body.error?.code === code, `${what}: ${code}`, r.text);
  check(!/\n\s+at /.test(r.text), `${what}: no stack trace`);
}

// ── keys and the JWKS the second node fetches ──────────────
const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
const kid = `e2e-${Date.now()}`;
const privJwk = { ...(await crypto.subtle.exportKey("jwk", signing.privateKey)), kid, alg: "EdDSA" };
const pubJwk = await crypto.subtle.exportKey("jwk", signing.publicKey);
const { jwks } = buildJwks([{ kty: "OKP", crv: "Ed25519", x: pubJwk.x, kid }], [], Math.floor(Date.now() / 1000));
const pseudoRaw = crypto.getRandomValues(new Uint8Array(32));

const jwksServer = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  () => new Response(JSON.stringify(jwks), { headers: { "content-type": "application/json", "cache-control": "max-age=60" } }),
);
const JWKS_URL = `http://127.0.0.1:${jwksServer.addr.port}/jwks.json`;

// ── the function, on its own login ─────────────────────────
const issuerPassword = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
await psqlStdin(`ALTER ROLE por_issuer LOGIN PASSWORD '${issuerPassword}';`);
const dbHost = Deno.env.get("POR_DB_HOST") ?? "db:5432";
const serveArgs = ["functions", "serve", "node-attestation", "--env-file", "/dev/stdin"];
if (WORKDIR) serveArgs.push("--workdir", WORKDIR);
const server = new Deno.Command("supabase", { args: serveArgs, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
{
  const w = server.stdin.getWriter();
  await w.write(enc.encode(
    `POR_SIGNING_KEY='${JSON.stringify(privJwk)}'\nPOR_PSEUDONYM_KEY=${b64url(pseudoRaw)}\nNODE_ATTESTATION_AUD=${FN}\n` +
      `POR_DB_URL=postgresql://por_issuer:${issuerPassword}@${dbHost}/postgres\n`,
  ));
  await w.close();
}
const serverLog: string[] = [];
for (const stream of [server.stdout, server.stderr]) {
  (async () => {
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) serverLog.push(chunk);
  })();
}

const homes: string[] = [];
let daemonHome: string | null = null;

try {
  await cleanup();
  const password = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const signup = await fetch(`${BASE}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: ANON, "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  const account = await signup.json();
  if (typeof account.access_token !== "string") throw new Error(`no session from sign-up (keys: ${Object.keys(account).sort().join(",")})`);
  const session = { id: account.user.id as string, jwt: account.access_token as string };

  // Wait for the function to answer (the edge runtime boots after `serve` starts).
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch(`${FN}/challenge`, { method: "POST", headers: { authorization: `Bearer ${session.jwt}`, "content-type": "application/json" }, body: "{}" });
      const body = await r.json().catch(() => ({}));
      up = r.status === 200 || String(body?.error?.code ?? "").startsWith("POR_");
    } catch {
      // not up yet
    }
    if (!up) await sleep(1000);
  }
  if (!up) throw new Error(`function did not come up:\n${serverLog.join("")}`);
  await psql(`DELETE FROM node_attestation_challenges WHERE user_id = '${session.id}'`);

  const fresh = async () => {
    const h = await homeFor(session);
    homes.push(h);
    return h;
  };

  // ── off by default ──
  const a = await fresh();
  const offView = await attest(a, ["status"]);
  check(offView.code === 0 && offView.body.attestation?.state === "off", "off until asked for", offView.text);
  const noFlag = await attest(a, ["enable"]);
  failed(noFlag, "POR_CONSENT_REQUIRED", "not interactive, flag left out");
  check(noFlag.body.error?.fix?.includes(ACCEPT), "the error names the missing flag");
  let noFile = true;
  try {
    Deno.statSync(statePath(a));
    noFile = false;
  } catch {
    // expected
  }
  check(noFile, "nothing was enabled");

  // ── failures against the real thing ──
  const nobody = await homeFor(null);
  homes.push(nobody);
  failed(await attest(nobody, ["enable", ACCEPT]), "POR_NOT_LOGGED_IN", "no sign-in");

  const stale = await homeFor(null);
  homes.push(stale);
  await signIn(stale, "not.a.session", session.id);
  failed(await attest(stale, ["enable", ACCEPT]), "POR_SESSION_EXPIRED", "a session the function rejects");

  failed(await attest(a, ["enable", ACCEPT], { ROTIFER_CLOUD_ENDPOINT: `${BASE}/not-deployed` }), "POR_SERVICE_NOT_OPEN", "function not deployed");
  const elsewhere = await attest(a, ["enable", ACCEPT], { ROTIFER_CLOUD_ENDPOINT: BASE.replace("127.0.0.1", "localhost") });
  failed(elsewhere, "POR_AUD_MISMATCH", "challenge issued for another address");
  check(String(elsewhere.body.error?.message).includes(FN) && String(elsewhere.body.error?.message).includes(FN.replace("127.0.0.1", "localhost")), "the error names both the expected and the actual aud", elsewhere.text);

  // ── enable ──
  const enabled = await attest(a, ["enable", ACCEPT]);
  check(enabled.code === 0 && enabled.body.attestation?.state === "active", "enable: a certificate from the real function", enabled.text);
  const notices = String(enabled.body.notices?.join("\n"));
  check(notices.includes("你的节点会和一个账号假名关联公开，Cloud 能反查") && notices.includes("7 天"), "the agreed wording and the 7 days are stated");
  const peerA = enabled.body.attestation.peerId as string;
  check((Deno.statSync(statePath(a)).mode! & 0o777) === 0o600, "the state file is private");
  const firstToken = readState(a).token as string;
  const v = await verifyToken(firstToken, { issuer: ISSUER, keys: jwks.keys }, Math.floor(Date.now() / 1000));
  check(v.ok && !v.expired, "the token verifies against the issuer's published keys", JSON.stringify(v));
  const sub = v.ok ? v.claims.sub : "?";
  if (v.ok) {
    check(v.claims.peer_id === peerA, "it is for this node's PeerId");
    check(v.claims.exp - v.claims.iat === TTL_SECONDS, "it lasts 7 days");
  }
  check(!dec.decode(fromB64url(firstToken.split(".")[1])!).includes(session.id), "no plaintext account id in the token");

  // ── the too-early rule, as ADR-300's open question asks it ──
  failed(await attest(a, ["renew"]), "POR_RENEWAL_TOO_EARLY", "renewing a fresh certificate");
  const kept = Deno.readTextFileSync(statePath(a));
  Deno.removeSync(statePath(a));
  failed(await attest(a, ["enable", ACCEPT]), "POR_RENEWAL_TOO_EARLY", "local copy lost within 24 hours");
  Deno.writeTextFileSync(statePath(a), kept, { mode: 0o600 });

  // A leaked key is replaced by a new key, which is a new PeerId: not too early.
  const rotated = await fresh();
  const reissue = await attest(rotated, ["enable", ACCEPT]);
  check(reissue.code === 0 && reissue.body.attestation.peerId !== peerA, "a new key gets a certificate at once: the too-early rule does not block emergency reissue", reissue.text);

  // ── key change, on the real files ──
  const moved = await fresh();
  await attest(moved, ["enable", ACCEPT]);
  const movedPeer = readState(moved).peerId as string;
  check(typeof movedPeer === "string", "third PeerId of the account issued");
  Deno.removeSync(`${moved}/.rotifer/identity.pem`);
  const changed = await attest(moved, ["status"]);
  check(changed.body.attestation?.state === "key_changed", "a replaced key is noticed", changed.text);
  check(String(changed.body.notices).includes("not voided") && String(changed.body.notices).includes("attest enable"), "and the user is told what it means");
  failed(await attest(moved, ["renew"]), "POR_KEY_CHANGED", "renew after a key change");

  // ── the slots are full now: A, rotated, moved ──
  const fourth = await fresh();
  failed(await attest(fourth, ["enable", ACCEPT]), "POR_QUOTA_EXCEEDED", "a fourth PeerId");

  // ── automatic renewal by the real daemon, at the limit ──
  // Age PeerId A's issuance past the 24 h rule, and make its certificate look
  // nearly expired to the daemon. The log is append-only; the trigger is bypassed.
  await psql(`SET session_replication_role = replica;
    UPDATE node_attestation_issuances SET iat = iat - 90000, exp = exp - 90000 WHERE peer_id = '${peerA}';
    SET session_replication_role = origin;`);
  const before = readState(a);
  Deno.writeTextFileSync(statePath(a), JSON.stringify({ ...before, exp: Math.floor(Date.now() / 1000) + 3600 }), { mode: 0o600 });

  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const started = await cli(a, ["network", "start", "-p", String(port)]);
  daemonHome = a;
  check(started.code === 0, "the daemon starts", started.text);

  let renewed: Record<string, any> | null = null;
  for (let i = 0; i < 40 && !renewed; i++) {
    const s = readState(a);
    if (s.token !== firstToken) renewed = s;
    else await sleep(500);
  }
  check(renewed !== null, "the daemon renewed the certificate on its own, with all 3 slots taken");
  if (renewed) {
    check(renewed.peerId === peerA, "same PeerId");
    check(renewed.exp - Math.floor(Date.now() / 1000) > 6 * 86400, "a full new lifetime");
    check(renewed.lastFailure === null, "no failure recorded");
    check(await psql(`SELECT count(DISTINCT peer_id) FROM node_attestation_issuances WHERE user_id = '${session.id}'`) === "3", "renewal took no extra slot");
    failed(await attest(fourth, ["enable", ACCEPT]), "POR_QUOTA_EXCEEDED", "a fourth PeerId, after the renewal");
  }
  const running = await cli(a, ["network", "status"]);
  check(running.text.includes("Certificate") && running.text.includes("Active"), "network status shows it", running.text);

  // ── another real node checks it ──
  const b = await homeFor(null);
  homes.push(b);
  const addon = Deno.env.get("POR_ADDON") ?? `${REPO}crates/rotifer-napi/index.${Deno.build.os === "darwin" ? `darwin-${Deno.build.arch === "aarch64" ? "arm64" : "x64"}` : "linux-x64-gnu"}.node`;
  const verifier = await new Deno.Command("node", {
    args: [`${REPO}tests/por-e2e/second-node.mjs`, addon, `/ip4/127.0.0.1/tcp/${port}/p2p/${peerA}`, peerA, ISSUER, JWKS_URL, "400"],
    env: { HOME: b },
  }).output();
  const verifierText = dec.decode(verifier.stdout);
  seen.push(dec.decode(verifier.stderr));
  let heard: { status?: string; exp?: number } = {};
  try {
    heard = JSON.parse(verifierText);
  } catch {
    // reported by the check below
  }
  check(heard.status === "valid", "a second real node heard the certificate in a heartbeat and verified it", verifierText + dec.decode(verifier.stderr));
  check(renewed !== null && heard.exp === renewed.exp, "and it is the renewed one");

  // ── disable ──
  const off = await attest(a, ["disable"]);
  check(off.body.ok === true && off.body.attestation.state === "off" && off.body.daemon === "loaded", "disable reaches the running daemon", off.text);
  check(String(off.body.notices).includes("not voided"), "and says the certificate is not voided");
  await cli(a, ["network", "stop"]);
  daemonHome = null;

  // ── nothing secret was printed ──
  let daemonLog = "";
  try {
    daemonLog = Deno.readTextFileSync(`${a}/.rotifer/daemon.log`);
  } catch {
    // no log is fine
  }
  const everything = seen.join("\n") + daemonLog;
  check(!everything.includes(session.jwt), "no session token in any output or log");
  check(!everything.includes(firstToken) && (renewed === null || !everything.includes(renewed.token)), "no certificate in any output or log");
  check(!everything.includes(sub), "no account pseudonym in any output or log");
  check(!everything.includes(session.id), "no account id in any output or log");
  const keyBody = Deno.readTextFileSync(`${a}/.rotifer/identity.pem`).split("\n").filter((l) => l && !l.startsWith("-----"));
  check(keyBody.length > 0 && keyBody.every((l) => !everything.includes(l)), "no private key in any output or log");
} finally {
  try {
    if (daemonHome) await cli(daemonHome, ["network", "stop"]);
    await cleanup();
    await psql("ALTER ROLE por_issuer NOLOGIN PASSWORD NULL");
  } finally {
    server.kill("SIGTERM");
    await server.status;
    await jwksServer.shutdown();
    for (const h of homes) await Deno.remove(h, { recursive: true }).catch(() => {});
  }
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
Deno.exit(failures === 0 ? 0 : 1);
