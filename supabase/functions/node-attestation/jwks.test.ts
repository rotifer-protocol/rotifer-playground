import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { buildJwks, JwksError, revocationStillNeeded } from "./jwks.ts";
import { TTL_SECONDS } from "./por.ts";

const PEER_A = "12D3KooWA4Xop1JaT3MHxwYMkCepYsv4iPVopMXwCz5iHYdBfeSB";
const PEER_B = "12D3KooWK99VoVxNE7XzyBwXEzW7xhK7Gpv85r9F3V3fyKSUKPH5";
const NOW = 1767225600;

async function keyPair(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { pub: { kty: pub.kty, crv: pub.crv, x: pub.x, kid }, priv: { ...priv, kid } };
}

Deno.test("the file is a JWK Set plus rotifer_revoked; keys keep their order and are normalised", async () => {
  const k1 = await keyPair("2026-11-a");
  const k2 = await keyPair("2026-10-z");
  const { jwks } = buildJwks([k1.pub, { ...k2.pub, key_ops: ["verify"], ext: true }], [{ peer_id: PEER_A, not_after: NOW }], NOW);
  assertEquals(Object.keys(jwks), ["keys", "rotifer_revoked"]);
  assertEquals(jwks.keys.map((k) => k.kid), ["2026-11-a", "2026-10-z"]);
  assertEquals(jwks.keys[1], { kty: "OKP", crv: "Ed25519", x: k2.pub.x!, kid: "2026-10-z", alg: "EdDSA", use: "sig" });
  assertEquals(jwks.rotifer_revoked, [{ peer_id: PEER_A, not_after: NOW }]);
});

Deno.test("a private key is refused, so it can never reach the published file", async () => {
  const k = await keyPair("k");
  assertThrows(() => buildJwks([k.priv], [], NOW), JwksError, "private key");
});

Deno.test("other key types, a missing kid, a duplicate kid, a short x and no keys are refused", async () => {
  const k = await keyPair("k");
  assertThrows(() => buildJwks([{ ...k.pub, crv: "X25519" }], [], NOW), JwksError);
  assertThrows(() => buildJwks([{ kty: "EC", crv: "P-256", x: k.pub.x, kid: "k" }], [], NOW), JwksError);
  assertThrows(() => buildJwks([{ ...k.pub, kid: undefined }], [], NOW), JwksError, "kid");
  assertThrows(() => buildJwks([k.pub, k.pub], [], NOW), JwksError, "duplicate kid");
  assertThrows(() => buildJwks([{ ...k.pub, x: "AAAA" }], [], NOW), JwksError, "32-byte");
  assertThrows(() => buildJwks([{ ...k.pub, alg: "HS256" }], [], NOW), JwksError, "EdDSA");
  assertThrows(() => buildJwks([{ ...k.pub, x5u: "https://x" }], [], NOW), JwksError, "x5u");
  assertThrows(() => buildJwks([], [], NOW), JwksError);
});

Deno.test("revocations: kept until not_after + 7 days + 60 s, then dropped; the boundary second is kept", async () => {
  const k = await keyPair("k");
  const last = NOW - TTL_SECONDS - 60; // still needed exactly at NOW
  const gone = last - 1;
  const { jwks, pruned } = buildJwks([k.pub], [{ peer_id: PEER_A, not_after: last }, { peer_id: PEER_B, not_after: gone }], NOW);
  assertEquals(jwks.rotifer_revoked, [{ peer_id: PEER_A, not_after: last }]);
  assertEquals(pruned, 1);
  assert(revocationStillNeeded({ peer_id: PEER_A, not_after: last }, NOW));
  assertEquals(revocationStillNeeded({ peer_id: PEER_A, not_after: last }, NOW + 1), false);
});

Deno.test("duplicate peer_ids collapse to the latest not_after; output is sorted by peer_id", async () => {
  const k = await keyPair("k");
  const { jwks } = buildJwks(
    [k.pub],
    [{ peer_id: PEER_B, not_after: NOW - 5 }, { peer_id: PEER_A, not_after: NOW - 9 }, { peer_id: PEER_B, not_after: NOW - 1 }],
    NOW,
  );
  assertEquals(jwks.rotifer_revoked, [{ peer_id: PEER_A, not_after: NOW - 9 }, { peer_id: PEER_B, not_after: NOW - 1 }]);
});

Deno.test("malformed revocations are refused", async () => {
  const k = await keyPair("k");
  for (
    const bad of [
      { peer_id: "not-base58-0OIl", not_after: NOW },
      { peer_id: PEER_A, not_after: "1767225600" },
      { peer_id: PEER_A, not_after: 1.5 },
      { peer_id: PEER_A, not_after: NOW, reason: "x" },
      [PEER_A, NOW],
    ]
  ) {
    assertThrows(() => buildJwks([k.pub], [bad], NOW), JwksError, undefined, JSON.stringify(bad));
  }
});

// The command-line wrapper, end to end. Only public keys go to the temp dir.
Deno.test({
  name: "scripts/por-jwks.ts writes the file to stdout, and nothing to stdout on a private key",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const dir = await Deno.makeTempDir();
    try {
      const k = await keyPair("k1");
      await Deno.writeTextFile(`${dir}/k1.json`, JSON.stringify(k.pub));
      await Deno.writeTextFile(`${dir}/revoked.json`, JSON.stringify([{ peer_id: PEER_A, not_after: NOW }]));
      const script = new URL("../../../scripts/por-jwks.ts", import.meta.url).pathname;
      const run = async (args: string[], stdin?: string) => {
        const child = new Deno.Command(Deno.execPath(), {
          args: ["run", `--allow-read=${dir}`, script, ...args],
          stdin: stdin === undefined ? "null" : "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        if (stdin !== undefined) {
          const w = child.stdin.getWriter();
          await w.write(new TextEncoder().encode(stdin));
          await w.close();
        }
        return child.output();
      };
      const ok = await run(["--key", `${dir}/k1.json`, "--revoked", `${dir}/revoked.json`, "--now", String(NOW)]);
      assert(ok.success, new TextDecoder().decode(ok.stderr));
      const out = JSON.parse(new TextDecoder().decode(ok.stdout));
      assertEquals(out.keys[0].kid, "k1");
      assertEquals(out.rotifer_revoked, [{ peer_id: PEER_A, not_after: NOW }]);

      // The throwaway private JWK goes through a pipe, never to disk.
      const refused = await run(["--key", "-"], JSON.stringify(k.priv));
      assertEquals(refused.success, false);
      assertEquals(refused.stdout.length, 0);
      const why = new TextDecoder().decode(refused.stderr);
      assert(why.includes("private key"), why);

      // A file that is not JSON is named, and none of its text is repeated.
      const notJson = await run(["--key", "-", "--revoked", `${dir}/revoked.json`], '{"kty":"OKP","d":FAKEPRIVATEKEYTEXT}');
      assertEquals(notJson.success, false);
      const notJsonWhy = new TextDecoder().decode(notJson.stderr);
      assert(notJsonWhy.includes("is not JSON"), notJsonWhy);
      assertEquals(notJsonWhy.includes("FAKEPRIVAT"), false, notJsonWhy);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
