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
| The function reaches the database only as `por_issuer`, a role that can execute the three functions it calls and nothing else; it reads no broader key. Revoking and the JWKS export belong to `por_operator`, which the function never uses | migration ("The issuing and operator roles"), `store.ts`, `index.ts`, `store.test.ts`; pgTAP S7, S10–S15 |
| The token and the response carry the pseudonym, never the user id | `handler.ts`, `handler.test.ts` |

"Live" means a verifier would still accept the certificate: `exp + 60 s` has
not passed and no revocation with `not_after ≥ iat` covers it.

## Files

| File | Role |
|---|---|
| `por.ts` | Challenge bytes, PeerId, pseudonym, token signing and a reference verifier |
| `jwks.ts` | The static JWKS file with `rotifer_revoked`; `scripts/por-jwks.ts` is its CLI |
| `handler.ts` | Routing, validation, order of checks, error codes |
| `store.ts` | The two database functions, called over a connection logged in as `por_issuer` |
| `user-token.ts` | The caller's token, checked in the function before Auth is asked: ES256 only, against the project's published keys |
| `index.ts` | `Deno.serve`, environment, `auth.getUser`, the Postgres connection |
| `*.test.ts` | Deno tests: `deno test --allow-read --allow-write --allow-run --allow-env supabase/functions/node-attestation/` |
| `pgtap-deferred.sh` | Applies the deferred migration to a throwaway database and runs its pgTAP, failing on a skip (CI runs it) |
| `race-check.sh` | Multi-session checks against a local database (exits 1 on failure) |
| `e2e.ts` | End to end against a local stack, with keys created in memory and never written to disk (see its header). The function reaches the database at `db:5432`, the database's alias on the stack's network; `POR_DB_HOST` overrides it, but only with another name the function treats as local, since it refuses any other host without TLS (under colima the container name does not resolve, the alias does) |

## Database access

The function identifies the caller with `auth.getUser` (anon key) and
records through a Postgres connection logged in as `por_issuer`. That role
may execute the two issuing functions (`node_attestation_challenge`,
`node_attestation_issue`) and nothing else: no table privilege, no RLS
bypass. The function never revokes, so it gets no right to: were a
compromised function able to call `node_attestation_revoke`, it could void
any certificate. Revoking and exporting the revocation list
(`node_attestation_revoke`, `node_attestation_revocations_for_jwks`) belong
to `por_operator`, a role for operators' manual runs only. The Supabase platform puts its own full-access key
into every function's environment; this function does not read it, and
`store.test.ts` fails if its code ever does.

The connection uses [postgres.js](https://github.com/porsager/postgres)
(`npm:postgres@3.4.7`). supabase-js cannot log in as a database role of its
own choosing (PostgREST would need a JWT signed with the project's JWT
secret, which can mint a token for any role), so a Postgres driver is
needed; none was in the repository before.

## Before deploying

Nothing here is deployed. Deploying is binding-layer work and needs these,
in order:

1. The user's keyword for v0.9.5 stage 2 B1. Then move the migration into
   `supabase/migrations/`, renaming it with a timestamp later than the newest
   entry in the production ledger and later than `20261030220000`. Run
   `supabase migration list --linked` and check the pending list entry by
   entry: it must hold this migration and nothing else. If anything else is
   pending, stop and ask; never use `--include-all`. Then push it, following
   the migration rule.
2. The signing key and K_pseudo, made in the deployment environment and
   stored only as its secrets (`POR_SIGNING_KEY`, `POR_PSEUDONYM_KEY`;
   `index.ts`). Making or saving the real keys needs the user's approval.
3. A login for `por_issuer`: the migration creates the role without one.
   Give it a password in the deployment environment
   (`ALTER ROLE por_issuer LOGIN PASSWORD …`), and store the connection
   string as the function's secret `POR_DB_URL`. Through Supabase's pooler
   the user name is `por_issuer.<project ref>`; use transaction mode (the
   function prepares no statements and takes only transaction-scoped locks).
   End the string with `?sslmode=require`, or `?sslmode=verify-full`.
   `require` encrypts the connection without checking the server's
   certificate; `verify-full` checks it too, and connects only if the runtime
   trusts that certificate's CA. The function refuses to start on a
   `POR_DB_URL` for any other user, or on one without either mode unless the
   host is local (`localhost`, `127.x.x.x`, `[::1]`, or exactly `db`).
4. The public key published in `https://rotifer.dev/.well-known/jwks.json`
   (`scripts/por-jwks.ts`) and confirmed to be served, **before** the
   function signs with it. Rotation order is in the script's header.
5. A decision on the request limits. The migration allows each account **60
   requests per hour** across both operations
   (`node_attestation_rate_consume`), in fixed hours, and refuses a second
   certificate for one PeerId within 24 hours unless under 48 hours of the
   last one remain. To use another number, change the migration before pushing
   it. There is no per-IP limit yet: it needs confirming which
   `x-forwarded-for` value this platform lets a caller set.
6. Deploy with `--no-verify-jwt` as well as the `verify_jwt = false` declared
   in `supabase/config.toml`: a deploy that does not read that file turns the
   gateway check back on. The function checks tokens itself
   (`user-token.ts`). The project must sign user tokens with ES256; with no
   ES256 key published, every request fails. Probe after deploying: with no
   `Authorization` header, the function itself answers 401 with the code
   `POR_UNAUTHENTICATED`.
7. A revocation routine, and republishing the JWKS. Both run as
   `por_operator`, by an operator, never through the function: give that role
   a login only where operators run them, kept apart from `POR_DB_URL`.
   - `node_attestation_revoke`: for a banned account or a leaked node key,
     pass a far-future `not_after`, such as `253402300799`. Only a node
     replacing its own key uses the default, now; with the default the same
     PeerId can be issued a new certificate a second later.
   - Republish with `scripts/por-jwks.ts --revoked <file>`, the file holding
     `node_attestation_revocations_for_jwks()`. The flag is required, because
     leaving the list out would bring every revoked certificate back.
   - If the only signing key leaks, publish with `--emergency-no-keys`: no
     keys, revocations kept. Verifiers then accept no certificate until a new
     key is published.
