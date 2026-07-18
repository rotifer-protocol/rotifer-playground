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

- [x] **Unit-test `types::Agent`** — added a `#[cfg(test)]` module covering `Agent::new`,
  `Agent::activate` and `Agent::terminate`: initial state, id uniqueness, the
  `Created → Active` transition, idempotent activation, termination from any state, the
  irreversibility of termination, `AgentState::Unknown` forward-compatible
  deserialisation, and a serde round-trip.
