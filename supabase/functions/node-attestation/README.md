# node-attestation

Cloud side of v0.9.5 A1, node attestation (Proof of Registration, P2P RFC
§8.4). It follows ADR-300 revision 2, "locked contract v2". A signed-in
account proves it holds a node's libp2p key and receives a 7-day EdDSA token
binding that PeerId to an opaque account pseudonym. Nodes put the token in
`NodeHeartbeat.cloud_attestation`; checking it is the P2P side's job
(rotifer-core).

Tables, RLS and the recording transaction live in
`supabase/migrations-deferred-v095-por/20261102200000_node_attestation.sql`.
That migration is deferred: it is kept out of `supabase/migrations/`, and
that directory's README says why.

## API

`POST /functions/v1/node-attestation/<op>`. Both operations need a signed-in
account.

| op | body | 200 |
|---|---|---|
| `challenge` | `{}` | `{ nonce, aud, challengeExp }` |
| `issue` | `{ publicKey, signature, nonce, challengeExp }` | `{ token, peerId, iat, exp }` |

- Binary fields are unpadded base64url. `publicKey` is the libp2p protobuf
  public key, and only Ed25519 is accepted.
- `signature` is the node's Ed25519 signature over the contract's challenge
  bytes:

      LP("rotifer-por-v1") || LP(aud) || LP(user_id) || LP(nonce) || LP(u64_be(challengeExp))
      LP(x) = u32_be(len(x)) || x

  Here `aud` is the value `/challenge` returned and `user_id` is the
  signed-in account's id. `por.ts` `challengeMessage()` builds these bytes,
  and the ADR's golden vector is a test in `por.test.ts`.
- `challengeExp` is echoed back from `/challenge`, so the function can rebuild
  the signed bytes. The database checks it against the stored challenge, so
  a changed value matches nothing.
- Errors are `{ error: { code, message } }`. The codes and statuses are listed
  in `handler.ts`.

Token (`por.ts`):

- Header: `{ alg: "EdDSA", typ: "rotifer-por+jwt", kid }`.
- Payload: `{ iss: "https://rotifer.dev", sub, peer_id, iat, exp = iat + 7 days }`.
- `sub` = base64url(HMAC-SHA256(K_pseudo, "rotifer-por-sub-v1\0" ‖ user_id)).
  It is the same for all of an account's nodes, and only the holder of
  K_pseudo can link it to the account.

## Rules enforced, and where

| Rule (contract v2) | Where |
|---|---|
| The PeerId comes from the submitted key; a claimed PeerId is not accepted | `handler.ts` |
| The signature covers this account, this `aud`, the nonce and the deadline | `handler.ts`, `por.ts` |
| A nonce is valid ≤ 5 minutes and used once, consumed even when the redemption is refused | `node_attestation_issue` |
| The account is re-checked at redemption (closed, banned or deleted) | `node_attestation_issue` |
| A PeerId live under another account is refused until that certificate expires or is revoked | `node_attestation_issue` |
| ≤ 3 distinct live PeerIds per account, counted on the append-only log (deleting a `nodes` row frees nothing); a renewal takes no extra slot; revoked certificates stop counting | `node_attestation_issue` |
| Concurrent redemptions are serialised: PeerId lock, then account lock | `node_attestation_issue`, `race-check.sh` |
| The token and the response carry the pseudonym, never the user id | `handler.ts`, `handler.test.ts` |

"Live" means a verifier would still accept the certificate: `exp + 60 s` has
not passed and no revocation with `not_after ≥ iat` covers it.

## Files

| File | Role |
|---|---|
| `por.ts` | Challenge bytes, PeerId, pseudonym, token signing and a reference verifier |
| `jwks.ts` | The static JWKS file with `rotifer_revoked`; `scripts/por-jwks.ts` is its CLI |
| `handler.ts` | Routing, validation, order of checks, error codes |
| `store.ts` | The two database functions, called with the service role |
| `index.ts` | `Deno.serve`, environment, `auth.getUser` |
| `*.test.ts` | Deno tests: `deno test --allow-read --allow-write --allow-run --allow-env supabase/functions/node-attestation/` |
| `race-check.sh` | Multi-session checks against a local database (exits 1 on failure) |
| `e2e.ts` | End to end against a local stack, with keys created in memory and never written to disk (see its header) |

## Before deploying

Nothing here is deployed. Deploying is binding-layer work and needs these,
in order:

1. The user's keyword for v0.9.5 stage 2 B1. Then move the migration into
   `supabase/migrations/` and push it, following the migration rule.
2. The signing key and K_pseudo, made in the deployment environment and
   stored only as its secrets (`POR_SIGNING_KEY`, `POR_PSEUDONYM_KEY`;
   `index.ts`). Making or saving the real keys needs the user's approval.
3. The public key published in `https://rotifer.dev/.well-known/jwks.json`
   (`scripts/por-jwks.ts`) and confirmed to be served, **before** the
   function signs with it. Rotation order is in the script's header.
4. Rate limiting for both operations. The database caps open challenges at 5
   per account, but that is not a request limit.
5. `[functions.node-attestation] verify_jwt = true` in `supabase/config.toml`.
6. A revocation routine for banned accounts and replaced node keys
   (`node_attestation_revoke`), and republishing the JWKS from
   `node_attestation_revocations_for_jwks()`.
