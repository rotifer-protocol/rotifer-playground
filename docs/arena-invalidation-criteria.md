# Arena invalidation criteria

A score on the Arena board is a public claim: *this gene performs this well.*
Some rows cannot support that claim — the gene was never run, or what ran
produced nothing. This document defines when a row is disqualified, in terms
anyone can check.

The criteria are code, not a list. Run them yourself:

```bash
rotifer arena audit
```

Every input is public — `arena_entries`, `genes`, and the `gene-wasm` storage
bucket all read without credentials — so the audit produces the same verdicts
for you as for us. That is the point. A curated list of rows to drop would ask
you to trust the curator; criteria let you check.

Source: [`src/arena/invalidation-criteria.ts`](../src/arena/invalidation-criteria.ts).

## What the criteria do and do not judge

They answer one question: **could this score have come from running the gene,
and can anyone verify that?**

They say nothing about whether a score looks too high. "0.97 is implausible" is
not reproducible, and a criterion that needs a human to agree with it puts the
curator back in the loop that ADR-319 D2 removes.

## The criteria

Evaluated in this order. A row is reported under the first criterion it
satisfies; any others are kept alongside so a second reason is never dropped.
The order runs from most to least fundamental — asking whether an artifact
carries a defect is meaningless for a row that has no artifact, or that was
never a real gene.

### 1. `test-data`

The row was submitted under the `test` domain.

Reads `arena_entries.domain` — what the submitter declared at submission time,
which is the claim being judged — rather than `genes.domain`, which can change
afterwards. Matched exactly (case- and whitespace-insensitive), so
`testing.harness` is untouched.

### 2. `no-published-artifact`

The gene declares `Native` fidelity — which promises an executable WASM
artifact — but no artifact is published.

This is about recomputability, not honesty. The score may well have come from a
real local sandbox run. But with nothing published, nobody else can re-run it,
and §9.7.1 asks that every published number be one a third party can arrive at
independently.

`Wrapped` genes are untouched: they never promised an artifact.

`Hybrid` genes are untouched **for now**, and the reason is worth stating. The
spec's Hybrid tier is headed for a WASM core with host functions for I/O, and
in that design a Hybrid gene does carry an artifact. But the Hybrid path that
currently ships was chosen deliberately as an interim: the gene runs under
Node.js with a gateway-wrapped `fetch` injected, and there is nothing to
publish. Holding Hybrid genes to an artifact the toolchain told them not to
produce would invalidate them for doing the right thing. When the
host-function path lands, this criterion widens to Hybrid — and the rows it
then catches will be genuine.

An **unpublished** gene is also untouched. The foreign key from `arena_entries`
cascades on delete, so a row can never outlive its gene; a gene that anonymous
callers cannot read has simply been unpublished by its author, which is a
supported action rather than a defect.

### 3. `async-express-artifact`

The published artifact contains an async `express()`.

Javy/QuickJS has no event loop. An async `express()` hands back a Promise; the
shim serialises that Promise to `{}` and exits 0. The gene reports success while
producing nothing, so any score measured against that output describes the empty
object, not the gene. The sandbox refuses to execute these artifacts, which is
what makes ranking them a contradiction rather than merely a mistake.

The markers are kept byte-identical to `ASYNC_EXPRESS_MARKERS` in
[`crates/rotifer-core/src/sandbox/wasmtime_sandbox.rs`](../crates/rotifer-core/src/sandbox/wasmtime_sandbox.rs),
and a test reads the Rust source to fail the build if they drift. Three
components now recognise this defect — the compiler refuses to build it, the
sandbox refuses to run it, the Arena refuses to rank it — and three copies of
one rule is how a rule drifts.

The compiler's source-level guard carries a third pattern matching a TypeScript
`Promise<…>` return annotation. Type annotations do not survive compilation, so
that pattern has no artifact-level counterpart by construction, not by omission.

## Three states, not two

A row is `flagged`, `clean`, or **`unchecked`**.

`unchecked` means the artifact criterion could not be evaluated — the download
was skipped (`--skip-artifacts`) or failed. Such a row is unevaluated, not
clean. Collapsing the two would let a partial run read as a clean bill of
health, which is the failure mode this audit exists to catch.

## Drift

The audit compares its verdicts against what the board actually records, and
reports three kinds of disagreement:

| Kind | Meaning |
|---|---|
| `missing` | The criteria fire; nothing is recorded. Expected until the invalidation job has run. |
| `unreproducible` | The board invalidated a row no criterion reproduces — a stale criterion, or a hand edit. |
| `reason-mismatch` | Both agree the row is invalid, but under different reasons. |

`unreproducible` is the one that matters. ADR-319 D6 forbids hand-editing
metrics, including messes of our own making; this is how such an edit becomes
visible instead of permanent. Rows whose artifact went unchecked are excluded
from it — a partial run cannot tell "no criterion fires" from "we did not look".

## What the criteria do not cover

They catch rows whose score provably could not have been measured. They do not
establish that a surviving score *was* measured — most rows on the board predate
any provenance record and carry `evaluation_method = 'unknown-legacy'`.
Excluding those from ranking is a separate, read-side rule (ADR-319 D4), applied
where the board is assembled rather than by invalidating rows.

Invalidation removes rows that are demonstrably wrong. It does not confer
trust on what remains.
