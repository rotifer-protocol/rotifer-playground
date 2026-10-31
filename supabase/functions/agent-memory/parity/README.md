# Cross-binding parity (v0.9.4)

One scenario runs on two bindings; the normalized results must be identical
step by step. Only `createdAt` / `updatedAt` are dropped before comparing
(`common.mjs`); error codes, every returned field, eviction order, query
order and the ids reported as `expired` are compared as returned.

| Scenario | Steps | Covers |
|---|---|---|
| `scenario.json` | 39 | writes, reads, queries, deletes, gene scopes, policy changes, quota and eviction, refusals |
| `scenario-expiry.json` | 32 | `maxRetentionDays` expiry, including purges reported by refused calls |

| Side | Runner | Store |
|---|---|---|
| local | `run-napi.mjs` (Node) | rotifer-napi `PlaygroundBinding`, SQLite in rotifer-core |
| Cloud | `run-cloud.ts` (Deno) | the `agent-memory` edge function on a local Supabase stack |

```bash
# local side: a release build of crates/rotifer-napi, copied to a .node name
# (--features test-clock is needed for scenario-expiry.json only)
cargo build --release -p rotifer-napi --features test-clock
cp target/release/librotifer_napi.dylib /tmp/rotifer_napi.node   # .so on Linux
ROTIFER_NAPI=/tmp/rotifer_napi.node node run-napi.mjs > napi.json

# Cloud side: local stack + served function (keys as in ../l2-smoke.ts)
supabase start && supabase functions serve agent-memory &
deno run --allow-net --allow-env --allow-run=psql --allow-read=. run-cloud.ts > cloud.json

node compare.mjs napi.json cloud.json   # exits 1 on any difference
```

For the expiry scenario, pass `scenario-expiry.json` as the last argument to
all three commands.

`run-cloud.ts` and `../l2-smoke.ts` refuse a `SUPABASE_URL` or `DB_URL` whose
host is not this machine (`../local-only.ts`).

## Result

rotifer-core 77ff4e4 (rotifer-playground#503) against this function, napi
built from an empty `CARGO_TARGET_DIR` with and without `test-clock`:

| Scenario | Result |
|---|---|
| main, napi without test-clock | **39/39** |
| main, napi with test-clock | **39/39** (the two napi outputs are byte-identical) |
| expiry, napi with test-clock | **32/32** |

Earlier rounds found four differences, each resolved by settling the rule
and aligning both bindings: which calls record `lastAccessedBy` (read and
write, not query); whether `DEPLOYER_CONFIGURED` can be written (no); whether
a caller id that is not `v2:<64 hex>` is accepted (no); and whether a refused
call keeps the expiry purge it already did (yes, and reports it).
