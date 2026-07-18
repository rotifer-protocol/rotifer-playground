# TODO

Small, self-contained maintenance tasks for the Rust workspace (`crates/`).
Each entry is scoped so it can be implemented and verified in one sitting:
change the code, then confirm `cargo test --all-features --workspace`,
`cargo clippy --all-targets --all-features` and the existing CI gates stay green.

Tasks marked **[manual]** need a human decision first and should not be picked up
opportunistically.

## Open

- [ ] **Widen the clippy gate to `--all-targets`** — CI currently runs
  `cargo clippy --workspace -- -D warnings`, which skips test, example and bench
  targets, so lint drift in test code goes unnoticed. The workspace already passes
  `cargo clippy --all-targets --all-features` locally with zero warnings, so this is a
  one-line change to `.github/workflows/ci.yml` that should land green.
  *Blocked: a `regression-guard` job is being added to `.github/workflows/ci.yml` right
  now and its composite action is not committed yet. Fold this one line into that change
  rather than touching the same file in parallel.*

- [ ] **[manual] Decide the `cargo fmt` policy** — `cargo fmt --check` reports drift
  across 33 files (essentially the whole workspace); there is no fmt gate in CI. This is
  an all-or-nothing call: either reformat the workspace in one commit and record it in
  `.git-blame-ignore-revs`, then add `cargo fmt --check` to CI, or drop the check
  deliberately. Piecemeal reformatting would churn `git blame` and collide with
  in-flight branches.

## Done

<!-- Move completed entries here with the commit that resolved them. -->

- [x] **Document why the four p2p tests are ignored** — the premise was partly stale: all
  four (`A_1_6` / `A_4_3` / `A_4_4` / `A_6_6`) already carried `#[ignore = "..."]` reason
  strings since #74, so nothing needed attaching. The real gap was the `docs/` note, now
  added as `docs/p2p-testing.md` and linked from CONTRIBUTING. It separates the six
  `p2p-integration` feature-gated two-node tests (runnable — `cargo test -p rotifer-core
  --features p2p-integration --lib -- --test-threads=1`) from these four unconditionally
  ignored stage-1 scaffolds, which **cannot** be run: three end in `unimplemented!()` and
  `A_4_3` panics while `FROZEN_PROTO_SCHEMA_SHA256` is `None`. Verified by running
  `--ignored` (6 pass, those 4 fail by design). No test behaviour changed.

- [x] **Unit-test `types::Agent`** — added a `#[cfg(test)]` module covering `Agent::new`,
  `Agent::activate` and `Agent::terminate`: initial state, id uniqueness, the
  `Created → Active` transition, idempotent activation, termination from any state, the
  irreversibility of termination, `AgentState::Unknown` forward-compatible
  deserialisation, and a serde round-trip.
