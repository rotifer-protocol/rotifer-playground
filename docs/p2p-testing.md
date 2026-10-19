# P2P test suite — what runs, what is ignored, and why

The `p2p` module in `crates/rotifer-core/src/p2p/` has three tiers of tests. Two
of them are `#[ignore]`d by default but for **different reasons**, and only one
tier can actually be run. This document says which is which, so nobody has to
re-derive it from the attributes.

Inventory as of v0.27.0 (wire format v1):

| Tier | Count | Ignored by default? | Runnable today? |
|---|---|---|---|
| Unit tests (whole crate) | 405 | no | yes — plain `cargo test` |
| Multi-node integration | 14 (7 of them adversarial) | yes (feature-gated) | yes — see below |
| Spec scaffolds | 2 | yes (unconditional) | **no — they fail by design** |

Among the unit tests, the frozen wire format is pinned by `messages::tests`:
A.4.3 checks the `.proto`'s sha256, A.4.3b checks the hand-written prost tags
against it, and A.4.4 decodes and re-encodes golden vectors from an
independent encoder (`scripts/p2p-wire-v1-reference.py`). Gene ID v2 is pinned
the same way in `gene_id::tests`, against vectors from
`scripts/gene-id-v2-reference.py`.

## Tier 1 — unit tests

Nothing special; they run in the default `cargo test -p rotifer-core` and in the
`Cargo test (core)` CI job. They use no sockets and no external services.

## Tier 2 — multi-node integration tests (runnable)

These spin up **real libp2p nodes over loopback** and assert real behaviour.
They are gated behind the `p2p-integration` feature, which is empty and has no
build effect — it exists purely as an opt-in marker:

```rust
#[cfg_attr(
    not(feature = "p2p-integration"),
    ignore = "two-node integration: ... — enable the p2p-integration feature or run with --ignored"
)]
```

The node tests:

| Test | File | Asserts |
|---|---|---|
| `spike::tests::spike_two_nodes_connect_and_discover` | `spike.rs` | explicit dial + Kademlia discovery (harness smoke test) |
| `node::tests::two_nodes_discover_via_kademlia` | `node.rs` | B finds A in its Kademlia routing table within 10s |
| `node::tests::two_nodes_exchange_identify` | `node.rs` | Identify metadata exchange |
| `node::tests::two_nodes_gossip_authenticates_publisher` | `node.rs` | GossipSub publisher authentication |
| `node::tests::two_nodes_dht_put_get` | `node.rs` | Kademlia DHT put → get round-trip |
| `node::tests::connection_limit_rejects_inbound` | `node.rs` | inbound connections past the cap are rejected |
| `node::tests::remembered_peers_let_a_restart_reconnect_without_bootstrap` | `node.rs` | a restarted node reconnects from its peer store, no bootstrap |

The adversarial suite (`adversarial.rs`) attacks a real node. Each hostile
message is followed by a legitimate probe from the same attacker, so "not
delivered" means *rejected*, not *lost*:

| Test | Attack | Expected |
|---|---|---|
| `adv_1_publisher_is_always_the_authenticated_source` | impersonation | impossible by construction: the wire has no publisher field |
| `adv_2_non_content_id_is_rejected` | a directory name instead of a v2 gene ID | rejected and counted |
| `adv_3_stale_announcement_is_rejected` | replay an hour old | rejected (±300 s window) |
| `adv_4_future_dated_announcement_is_rejected` | timestamp an hour ahead | rejected |
| `adv_5_malformed_payload_is_dropped` | garbage and pre-v1 JSON payloads | neither crashes nor surfaces |
| `adv_6_single_identity_flood_is_rate_limited` | 100-message burst | capped by the per-peer limit |
| `adv_7_invalid_announcement_is_not_relayed` | attacker → relay → far node | stops at the relay (validated before forwarding) |

`adv_7` forces the relay to be the only path — neither end accepts inbound
connections — and asserts that precondition. Without it the far node peers
with the attacker directly and the "not relayed" check proves nothing.

Run them locally the same way CI does:

```bash
cargo test -p rotifer-core --features p2p-integration --lib -- --test-threads=1
```

`--test-threads=1` is **required**, not cosmetic: these tests bind loopback
listeners and some share fixed identity files under the temp dir, so running
them in parallel makes them contend and flake. CI runs them in the dedicated
`P2P Integration Tests` job (`.github/workflows/ci.yml`).

They are kept out of the default `cargo test` so the fast path stays
deterministic and socket-free.

## Tier 3 — spec scaffolds (not runnable)

Two tests are `#[ignore]`d **unconditionally** — no feature flag turns them on:

| Test | File | Why it cannot run |
|---|---|---|
| `node::tests::A_1_6_two_nodes_mdns_self_discover_within_3s` | `node.rs` | body ends in `unimplemented!()` — mDNS is not wired (its DNS dependency has an open advisory) |
| `cloud_sync::tests::A_6_6_strict_eventual_consistency_within_5s` | `cloud_sync.rs` | body ends in `unimplemented!()` — needs a real Supabase instance plus a live libp2p swarm |

The former A.4.3 and A.4.4 scaffolds now run as unit tests (see the top of
this page).

These are TDD placeholders that pin down acceptance criteria (the `A_x_y` names
are spec IDs). They get real bodies, and lose the `#[ignore]`, when the feature
they test lands. Until then:

- **Do not run them expecting a pass.** `cargo test -p rotifer-core --lib --
  --ignored` runs Tier 2 *and* Tier 3 together, so Tier 3's two failures are the
  expected outcome of that command, not a regression. To exercise only the
  runnable ones, use the Tier 2 command above.
- **Do not "fix" them by deleting them.** They are the executable record of what
  stage 2 owes.

CI never runs Tier 3: the `p2p-integration` job enables only the feature, which
does not affect unconditional `#[ignore]`s.
