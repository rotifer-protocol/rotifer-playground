/**
 * A throwaway PoR issuer for rotifer-core's cross-layer tests (ADR-300
 * locked contract v2). It signs tokens with the Cloud issuer's own code
 * (supabase/functions/node-attestation: signToken, pseudonym, buildJwks), so
 * the node-side verifier is checked against what the real function issues,
 * not against a second reading of the contract.
 *
 *   deno run --allow-net=127.0.0.1 crates/rotifer-core/tests/por-issuer/issue.ts <me> <other>
 *
 * <me> and <other> are libp2p PeerIds. Keys are generated in memory and never
 * leave the process. The JWKS (revoking <me> for tokens issued up to two
 * minutes ago) is served on a loopback port; one JSON line on stdout gives
 * its URL, the pseudonym and the tokens:
 *   valid    for <me>, issued a minute ago
 *   expired  for <other>, issued eight days ago (<me>'s revocation would
 *            cover a token this old)
 *   revoked  for <me>, issued ten minutes ago (before the revocation)
 *   stolen   for <other>, valid in itself (for <me> to present as its own)
 *   tampered the valid token with its pseudonym swapped
 * The server runs until stdin closes.
 */

import { buildJwks } from "../../../../supabase/functions/node-attestation/jwks.ts";
import {
  b64url,
  importPseudonymKey,
  importSigningJwk,
  ISSUER,
  pseudonym,
  signToken,
  TTL_SECONDS,
} from "../../../../supabase/functions/node-attestation/por.ts";

const [me, other] = Deno.args;
if (!me || !other) {
  console.error("usage: issue.ts <me PeerId> <other PeerId>");
  Deno.exit(2);
}

const KID = "cross-layer-1";
const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const signer = await importSigningJwk({ ...privateJwk, kid: KID });
const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
const sub = await pseudonym(await importPseudonymKey(crypto.getRandomValues(new Uint8Array(32))), "cross-layer-user");

const now = Math.floor(Date.now() / 1000);
const token = (peer_id: string, iat: number) =>
  signToken(signer, { iss: ISSUER, sub, peer_id, iat, exp: iat + TTL_SECONDS });

const valid = await token(me, now - 60);
const [h, , s] = valid.split(".");
const swapped = { iss: ISSUER, sub: b64url(new Uint8Array(32)), peer_id: me, iat: now - 60, exp: now - 60 + TTL_SECONDS };
const tokens = {
  valid,
  expired: await token(other, now - 8 * 24 * 3600),
  revoked: await token(me, now - 600),
  stolen: await token(other, now - 60),
  tampered: `${h}.${b64url(new TextEncoder().encode(JSON.stringify(swapped)))}.${s}`,
};

const { jwks } = buildJwks(
  [{ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, kid: KID, alg: "EdDSA", use: "sig" }],
  [{ peer_id: me, not_after: now - 120 }],
  now,
);
const body = JSON.stringify(jwks);

const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, (req) => {
  if (new URL(req.url).pathname !== "/.well-known/jwks.json") return new Response("not found", { status: 404 });
  return new Response(body, { headers: { "content-type": "application/json", "cache-control": "public, max-age=300" } });
});
const url = `http://127.0.0.1:${server.addr.port}/.well-known/jwks.json`;
console.log(JSON.stringify({ url, iss: ISSUER, sub, tokens }));

// Serve until the test closes our stdin (or dies).
for await (const _ of Deno.stdin.readable) { /* drain */ }
await server.shutdown();
