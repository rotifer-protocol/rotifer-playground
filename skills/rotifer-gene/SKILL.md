---
name: rotifer-gene
description: The Gene manual for Rotifer Protocol — write a Gene's express function and phenotype schema, test it on its own and inside a small Agent, publish it to the Rotifer Gene Registry and enter the Arena; run the four-layer security audit that searches your own Gene files and published records for leaked credentials and fixes what it finds, such as an absolute path in a Gene manifest, before publishing; and migrate a Gene's fidelity from Wrapped to Hybrid or Native. Invoke explicitly when building, auditing, or upgrading a Rotifer Gene. Do NOT use for general code review, dependency auditing, or framework migration — every procedure here operates on Rotifer Genes, their phenotype schemas, and the Rotifer CLI. One closing section tells contributors to Rotifer itself where the code changes when a fidelity level, phenotype field, domain or CLI command is added.
version: 1.0.12
license: Apache-2.0
compatibility: Requires the Rotifer CLI at a pinned version (@rotifer/playground@0.38.0) for the commands shown, installed with npm i -g @rotifer/playground@0.38.0 or run per command as npx --yes @rotifer/playground@0.38.0, either of which downloads it from npm. Publishing and Arena submission also need network access and an account.
metadata:
  author: rotifer-protocol
  version: "1.0.12"
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
- **What a published Gene shows its readers is English** — descriptions, schema
  fields, README, error messages — because the Registry and the Arena are shared
  across languages. That is about the Gene's own text; talk to the user in theirs.
- **A published version is immutable.** Bump, do not overwrite.

## What this Skill does on your machine

Nothing on its own. It describes commands and you run them. What each of those
commands sends, read from the CLI source at the version pinned here:

- **Every command**, from an installed CLI: one version check per day to
  `registry.npmjs.org`. It is skipped under `npx`, in CI, or with
  `ROTIFER_NO_UPDATE_CHECK` set. Installing the CLI, or running it through
  `npx`, downloads it from npm.
- **`wrap`** sends nothing itself. But when it runs in a terminal, you are
  signed in and the new Gene is ready to publish, it ends by asking
  `Publish '<name>' to Rotifer Cloud? [Y/n]`; Enter means yes, and the Gene is
  then published exactly as by `publish`. `rotifer config set default-publish
  false` stops the question.
- **`login`** signs in to Rotifer Cloud (`https://cloud.rotifer.dev`, unless
  `ROTIFER_CLOUD_ENDPOINT` names another) through your browser, with a callback
  to `localhost:9876`. `publish` and `arena submit --cloud` renew that sign-in
  with Rotifer Cloud first when it has expired.
- **`publish`** uploads the Gene to Rotifer Cloud, where it is public: name,
  domain, version, fidelity, description, the whole `phenotype.json`,
  `README.md`, the changelog you give, a content hash and the compiled WASM. `modules/audit.md` §4.1 lists what stays
  local. It also fetches the list of domains, and reads your developer
  reputation unless you pass `--skip-arena`. Only with `ROTIFER_BADGE_TOKEN`
  set does it upload the V(g) result to `badge.rotifer.dev`.
- **`arena submit`** asks Rotifer Cloud for the season's reference scale,
  sending the Gene's domain and fidelity. With `--cloud` it also sends the
  published Gene's fitness score and the runs it was measured on to the Cloud
  Arena.
- **`arena list`** and **`arena watch`** read only the local `genes/`. With
  `--cloud` they read the Cloud Arena's rankings instead.
- **`install`** fetches the Gene's record and its WASM, records one download
  (the Gene id and `cli`), and fetches the list of domains.
- **`hello`** looks a template's Gene up in Rotifer Cloud when the workspace
  does not have it.
- **`run`** and **`agent run`** send an anonymous heartbeat each time they run a
  Gene: a random machine id, the channel it ran from and the CLI version,
  nothing about the Gene or your files. When you are signed in, running a Gene
  installed from Cloud also records that invocation (the Gene id and your
  Agent) against your account. `rotifer telemetry off`, `ROTIFER_TELEMETRY=0`
  or `DO_NOT_TRACK=1` turns both off.
- **`test`, `run`, `agent run`, `hello`**, and the tests `publish` runs before
  uploading, run a Hybrid or Wrapped Gene's own code, which makes its own
  requests carrying whatever the Gene puts in them. `ctx.gatewayFetch` reaches
  only the hosts in its `network.allowedDomains`. A global `fetch` is held to the
  same list from CLI 0.37.0, so also in 0.38.0, the version pinned here; in 0.36.1 and earlier it
  is not (`modules/dev.md` §5.3). A Native Gene makes no requests.
- **`init`, `scan`, `vg`, `compile`, `agent create`** and **`telemetry`** send
  nothing beyond the version check.

Requests to Rotifer Cloud carry your access token when you are signed in,
except the heartbeat, the WASM download and the list of domains.

Nothing else leaves your machine. Read `modules/audit.md` before your first publish: it
is the difference between finding a leaked credential on your disk and finding
it in a public registry.
