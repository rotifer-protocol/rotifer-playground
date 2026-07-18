# P2P test suite — what runs, what is ignored, and why

The `p2p` module in `crates/rotifer-core/src/p2p/` has three tiers of tests. Two
of them are `#[ignore]`d by default but for **different reasons**, and only one
tier can actually be run. This document says which is which, so nobody has to
re-derive it from the attributes.

Inventory as of `rotifer-core` v0.9.0:

| Tier | Count | Ignored by default? | Runnable today? |
|---|---|---|---|
| Unit tests | ~320 | no | yes — plain `cargo test` |
| Two-node integration | 6 | yes (feature-gated) | yes — see below |
| Stage-1 spec scaffolds | 4 | yes (unconditional) | **no — they fail by design** |

## Tier 1 — unit tests

Nothing special; they run in the default `cargo test -p rotifer-core` and in the
`Cargo test (core)` CI job. They use no sockets and no external services.

## Tier 2 — two-node integration tests (runnable)

These spin up **real libp2p nodes over loopback** and assert real behaviour.
They are gated behind the `p2p-integration` feature, which is empty and has no
build effect — it exists purely as an opt-in marker:

```rust
#[cfg_attr(
    not(feature = "p2p-integration"),
    ignore = "two-node integration: ... — enable the p2p-integration feature or run with --ignored"
)]
```

The six tests:

| Test | File | Asserts |
|---|---|---|
| `spike::tests::spike_two_nodes_connect_and_discover` | `spike.rs` | explicit dial + Kademlia discovery (harness smoke test) |
| `node::tests::two_nodes_discover_via_kademlia` | `node.rs` | B finds A in its Kademlia routing table within 10s |
| `node::tests::two_nodes_exchange_identify` | `node.rs` | Identify metadata exchange |
| `node::tests::two_nodes_gossip_authenticates_publisher` | `node.rs` | GossipSub publisher authentication |
| `node::tests::two_nodes_dht_put_get` | `node.rs` | Kademlia DHT put → get round-trip |
| `node::tests::connection_limit_rejects_inbound` | `node.rs` | inbound connections past the cap are rejected |

Run them locally the same way CI does:

```bash
cargo test -p rotifer-core --features p2p-integration --lib -- --test-threads=1
```

`--test-threads=1` is **required**, not cosmetic: these tests share fixed
identity files under the temp dir and bind loopback listeners, so running them
in parallel makes them contend and flake. CI runs them in the dedicated
`P2P Integration Tests` job (`.github/workflows/ci.yml`).

They are kept out of the default `cargo test` so the fast path stays
deterministic and socket-free.

## Tier 3 — stage-1 spec scaffolds (not runnable)

Four tests are `#[ignore]`d **unconditionally** — no feature flag turns them on:

| Test | File | Why it cannot run |
|---|---|---|
| `node::tests::A_1_6_two_nodes_mdns_self_discover_within_3s` | `node.rs` | body ends in `unimplemented!()` — the mDNS event loop is not wired |
| `messages::tests::A_4_3_strict_proto_schema_frozen_sha256` | `messages.rs` | `FROZEN_PROTO_SCHEMA_SHA256` is still `None`, so the test panics on purpose; also needs `ROTIFER_PROTO_PATH` |
| `messages::tests::A_4_4_cross_language_round_trip` | `messages.rs` | body ends in `unimplemented!()` — needs a ts-proto consumer on the other end |
| `cloud_sync::tests::A_6_6_strict_eventual_consistency_within_5s` | `cloud_sync.rs` | body ends in `unimplemented!()` — needs a real Supabase instance plus a live libp2p swarm |

These are TDD placeholders written during stage 1 to pin down the acceptance
criteria (the `A_x_y` names are spec IDs). Stage 2 fills in the bodies and drops
the `#[ignore]`. Until then:

- **Do not run them expecting a pass.** `cargo test -p rotifer-core --lib --
  --ignored` runs Tier 2 *and* Tier 3 together, so Tier 3's four failures are the
  expected outcome of that command, not a regression. To exercise only the
  runnable ones, use the Tier 2 command above.
- **Do not "fix" them by deleting them.** They are the executable record of what
  stage 2 owes.

CI never runs Tier 3: the `p2p-integration` job enables only the feature, which
does not affect unconditional `#[ignore]`s.
