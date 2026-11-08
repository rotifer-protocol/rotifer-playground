/**
 * Builds the PoR JWKS file (ADR-300 locked contract v2, "JWKS 文件") from
 * public keys and a revocation list. Generates the file only: publishing it
 * at https://rotifer.dev/.well-known/jwks.json is a separate, approved step.
 *
 *   deno run --allow-read scripts/por-jwks.ts \
 *     --key current.pub.jwk.json [--key previous.pub.jwk.json ...] \
 *     --revoked revoked.json [--now <unix seconds>] > jwks.json
 *
 *   deno run --allow-read scripts/por-jwks.ts \
 *     --emergency-no-keys --revoked revoked.json > jwks.json
 *
 * --key      a public OKP / Ed25519 JWK with a kid ("-" for stdin). A file
 *            holding a private key (a "d" member) is refused. Order is kept.
 * --revoked  required: a JSON array of { "peer_id": <base58>, "not_after":
 *            <unix s> }. Publishing without it would forget every revocation
 *            and bring those certificates back, so with none to carry, pass a
 *            file holding []. Entries older than 7 days + 60 s are dropped:
 *            every token they void has expired. Duplicates keep the latest
 *            not_after.
 * --now      the clock for that pruning (default: now).
 * --emergency-no-keys
 *            a file with no public keys, revocations kept, for when the only
 *            signing key has leaked. Verifiers then accept no certificate at
 *            all until a new key is published. Cannot be combined with --key.
 *
 * Key rotation order (ADR-300 D3, revision 2, point 2):
 *   1. Add the new public key here, publish, and check it is served.
 *   2. Only then start signing with the new private key.
 *   3. Keep the old public key until the last token it signed is past its
 *      acceptance deadline (that token's exp + 60 s), then drop it here.
 *   Exception: a leaked private key — drop its public key at once. If it was
 *   the only one, publish with --emergency-no-keys.
 * After replacing a node's identity.key, revoke the old PeerId: its tokens
 * stay valid otherwise (ADR-300 D4, revision 2).
 *
 * Exits 1 with a message on stderr, writing nothing to stdout, on any error.
 */

import { buildJwks, JwksError } from "../supabase/functions/node-attestation/jwks.ts";

function fail(message: string): never {
  console.error(`por-jwks: ${message}`);
  Deno.exit(1);
}

function readText(path: string): string {
  if (path !== "-") return Deno.readTextFileSync(path);
  const chunks: Uint8Array[] = [];
  const buf = new Uint8Array(4096);
  for (let n; (n = Deno.stdin.readSync(buf)) !== null;) chunks.push(buf.slice(0, n));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  chunks.reduce((at, c) => (all.set(c, at), at + c.length), 0);
  return new TextDecoder().decode(all);
}

/**
 * "-" reads standard input (once), so a key never has to be written to a file.
 * A parse error names the input only: JSON.parse's own message quotes the text.
 */
function readJson(path: string): unknown {
  let text: string;
  try {
    text = readText(path);
  } catch (err) {
    fail(`cannot read ${path}: ${(err as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${path} is not JSON`);
  }
}

const keyFiles: string[] = [];
let revokedFile: string | undefined;
let now = Math.floor(Date.now() / 1000);
let emergencyNoKeys = false;
const args = [...Deno.args];
while (args.length > 0) {
  const flag = args.shift()!;
  if (flag === "--emergency-no-keys") {
    emergencyNoKeys = true;
    continue;
  }
  const value = args.shift();
  if (value === undefined) fail(`${flag} needs a value`);
  if (flag === "--key") keyFiles.push(value);
  else if (flag === "--revoked") revokedFile = value;
  else if (flag === "--now") {
    if (!/^\d+$/.test(value)) fail("--now must be unix seconds");
    now = Number(value);
  } else fail(`unknown argument ${flag}`);
}
const usage = "usage: por-jwks.ts --key <public JWK file> [--key ...] --revoked <file> [--now <unix s>]\n       por-jwks.ts --emergency-no-keys --revoked <file> [--now <unix s>]";
if (emergencyNoKeys && keyFiles.length > 0) fail("--emergency-no-keys publishes no keys, so it cannot be combined with --key");
if (!emergencyNoKeys && keyFiles.length === 0) fail(usage);
if (revokedFile === undefined) fail(`--revoked is required: leaving it out would forget every revocation (use a file holding [] if there are none)\n${usage}`);

if ([...keyFiles, revokedFile].filter((f) => f === "-").length > 1) fail("only one input can be read from stdin");

const revoked = readJson(revokedFile);
if (!Array.isArray(revoked)) fail("--revoked must hold a JSON array");

try {
  const { jwks, pruned } = buildJwks(keyFiles.map(readJson), revoked, now, { allowNoKeys: emergencyNoKeys });
  if (emergencyNoKeys) console.error("por-jwks: EMERGENCY: this file has no public keys; verifiers will accept no certificate until a new key is published");
  console.log(JSON.stringify(jwks, null, 2));
  console.error(`por-jwks: ${jwks.keys.length} key(s), ${jwks.rotifer_revoked.length} revocation(s) kept, ${pruned} expired revocation(s) dropped`);
} catch (err) {
  if (err instanceof JwksError) fail(err.message);
  throw err;
}
