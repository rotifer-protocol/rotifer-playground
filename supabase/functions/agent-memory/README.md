# agent-memory

Cloud side of v0.9.4 Agent Memory (spec §38). Table, quota, eviction and
RLS: `supabase/migrations/20261030220000_agent_memory_entries.sql`.

`POST /functions/v1/agent-memory/<op>`, `op` ∈ `register | write | read | query | delete`.
Request and response shapes: `wire.ts`. Signed-in accounts only; every query
runs as the caller (anon key + the caller's JWT) under RLS.

| File | Role |
|---|---|
| `wire.ts` | camelCase JSON ↔ rows, validation, error codes |
| `access.ts` | §38.2 gene-scope checks |
| `handler.ts` | routing, responses, 4 MiB response limit |
| `store.ts` | Supabase calls (`agent_memory_write`, `_read`, `_query`, `_delete`, `_container`; PostgREST only to register an agent) |
| `index.ts` | `Deno.serve`, JWT role check, client per request |
| `*.test.ts` | Deno tests (CI: `deno test supabase/functions/agent-memory/`) |
| `l2-smoke.ts` | contract check against a real local stack (run by hand; see its header) |
| `local-only.ts` | refuses a non-local `SUPABASE_URL` / `DB_URL` in the test scripts |

## Before deploying

Not deployed. Deploying needs, in order:

1. The user's keyword for `supabase db push` of the migration and for the function deploy.
2. Rate limiting (below) — a deploy gate. Not built yet, and its
   approach waits for an ADR (below).
3. `verify_jwt = true` stays in `supabase/config.toml`.

## Rate limiting — plan (deploy gate)

> **Waiting for an ADR.** This plan goes a different way from ADR-298 (new rate
> limiting goes through Cloudflare Durable Objects, not Supabase); the reasons are
> below. Nothing here is built until an ADR decides it and the user
> approves. Until then the Cloud function is not deployed.

**Recommendation: a per-account fixed-window limit inside Postgres, consumed by the
same calls the function already makes. Not ADR-298's Durable Objects.**

Why not reuse ADR-298. ADR-298 moved rotifer.ai's limiter to Cloudflare Durable
Objects because that limiter guards *anonymous* traffic at a Cloudflare edge, and
reaching Supabase from there needed a privileged key. This function is a Supabase
Edge Function, not a Cloudflare Worker, and every caller is already a signed-in
account. Calling a DO from here would need a public Worker endpoint and a shared
secret — a new credential, the opposite of ADR-298's goal. The chat function's
in-memory limiter (`chat/rate-limiter.ts`) is per isolate, so it resets whenever
Supabase starts a new one and does not hold across instances.

What to build (one additive migration plus small function changes):

- Table `agent_memory_rate_buckets (owner_id uuid PK → profiles, window_start timestamptz, calls int, bytes bigint)`.
  No client grants at all.
- `agent_memory_rate_consume(p_bytes bigint)` SECURITY DEFINER, `search_path` pinned,
  EXECUTE for `authenticated` only, keyed on `auth.uid()` (never a parameter). In
  one `INSERT … ON CONFLICT DO UPDATE`: reset the window when it has passed, add
  one call and `p_bytes`, and raise `MEMORY_RATE_LIMITED` (SQLSTATE 53400 is taken by
  quota; use a distinct one, e.g. `54000`) when over.
- Call it first inside `agent_memory_write` and `agent_memory_query`, and from
  read/delete via one extra RPC call. The edge function maps it to HTTP 429.
- **This limits only the RPC paths.** `authenticated` still has direct
  SELECT/INSERT/UPDATE/DELETE grants on both tables (the edge function itself
  reads and updates rows through PostgREST), so a signed-in client calling
  PostgREST with the public anon key and its own JWT bypasses the RPCs, and with
  them this limit. RLS keeps it to its own rows and the quota triggers cap the
  totals, but nothing caps how often. Covering direct writes needs the limit on
  the tables' triggers; covering direct reads needs those grants withdrawn; the
  ADR decides how far to go.
- Numbers are production configuration, set by the user at deploy time. A starting
  proposal: 600 calls and 50 MiB written per account per hour; with the 200 MiB
  per-account quota ceiling this bounds both storage and write volume per account.
- Error code: `MEMORY_RATE_LIMITED`, HTTP 429 — reserved, not yet emitted by
  anything.
- Tests: pgTAP for window reset, limit hit, isolation between accounts, and that
  the bucket table is unreadable and unwritable by clients; Deno for the 429
  mapping.

Not covered by this: many accounts from one person. Production sign-up requires
email confirmation (checked 2026-10-31:
`mailer_autoconfirm=false`), so each account needs a working mailbox; that
raises the cost of multiplying the limit, it does not remove it. It is a
platform setting, not this function's.

## Known limitations (v0.9.4)

- Gene scopes are checked by the function and the RPCs, not by RLS. The calling
  gene's id and domain are declared by the user's own client, so they protect an
  agent's genes from each other, not one account from another. An owner writing
  the table directly is not gene-checked. (Migration header R3.)
- Gene scopes are checked inside `agent_memory_write`, `agent_memory_delete` and
  `agent_memory_query` (writeScope under the same per-key and row locks as the
  write or delete) and again in the function, which gives the
  clearer error.
- Within one agent, a gene can take a key first.
- No server-side audit log. The write response lists evicted entries so the
  client writes its audit lines.
- `maxRetentionDays` is enforced lazily: the memory RPCs purge an
  agent's expired entries before reading or writing it, so an expired entry is
  never returned or counted. A direct table SELECT can still see one until the
  next call. An entry with no policy inherits the agent's DataPolicy; the Cloud
  stores none, so it never expires. `autoDeleteOnTermination` is stored, not
  acted on — there is no agent termination yet. Every response (write, read,
  query, delete) reports the purged entry ids as `expired` (`[]` when none) for
  the client's audit lines — error responses too: purging does not depend on
  the caller's permissions, so a refused call's purge is committed and
  reported.
- `DEPLOYER_CONFIGURED` always denies; only `PRIVATE` is accepted as sharePolicy.
