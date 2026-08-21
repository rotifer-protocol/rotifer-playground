---
name: rotifer-gene
description: The Gene manual for Rotifer Protocol — write a Gene's express function and phenotype schema, run the four-layer security audit before publishing, and migrate a Gene's fidelity from Wrapped to Hybrid or Native. Invoke explicitly when building, auditing, or upgrading a Rotifer Gene. Do NOT use for general code review, dependency auditing, or framework migration — every procedure here operates on Rotifer Genes, their phenotype schemas, and the Rotifer CLI, and nothing else.
version: 1.0.0
license: Apache-2.0
compatibility: Requires the Rotifer CLI (npx @rotifer/playground) for the commands shown. Publishing and Arena submission also need network access and an account.
metadata:
  author: rotifer-protocol
  version: "1.0.0"
---

# Working on a Gene

Three manuals, one per thing you might be doing. Read the one you need — they are
long because they are references, not tutorials.

| What you are doing | Read |
|--------------------|------|
| Writing a Gene: init, express, phenotype, test, compile, publish, Arena | [`modules/dev.md`](modules/dev.md) |
| Checking one before it ships: credential and artifact scanning, four layers | [`modules/audit.md`](modules/audit.md) |
| Upgrading fidelity: Wrapped → Hybrid → Native, and proving it still works | [`modules/migration.md`](modules/migration.md) |

## Which one

Match what the reader is asking for:

| They say | Go to |
|----------|-------|
| create, write, initialize, compile, publish, Arena, fitness | `modules/dev.md` |
| audit, scan, security, credential, is this safe to publish | `modules/audit.md` |
| upgrade, Wrapped to Native, rewrite, fidelity, refactor | `modules/migration.md` |

If it is ambiguous, say so and offer the choice rather than guessing — these are
long documents and loading the wrong one costs the reader more than a question does.

## What holds across all three

- **Fidelity is declared honestly.** Native means the logic is in WASM with no
  external calls; Hybrid means WASM plus calls to an allowlist; Wrapped means a
  shell around someone else's API. A Wrapped Gene labelled Native is a broken
  promise, not an optimization.
- **F(g) is multiplicative.** Any factor at zero eliminates the Gene, so a
  failure mode cannot be averaged away by strength elsewhere.
- **Everything a reader sees is English** — descriptions, schema fields, README,
  error messages.
- **A published version is immutable.** Bump, do not overwrite.

## What this Skill does on your machine

Nothing on its own. It describes commands — `rotifer init`, `test`, `compile`,
`publish`, `arena submit` — and you run them. The ones that reach the network are
`publish`, `arena submit --cloud` and `login`; the rest are local. Read
`modules/audit.md` before your first publish: it is the difference between
finding a leaked credential on your disk and finding it in a public registry.
