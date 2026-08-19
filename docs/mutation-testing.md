# Mutation testing

Coverage says a line ran. Mutation testing says whether an assertion would have
noticed it change. Stryker rewrites the source one small edit at a time — flips
a comparison, empties a string, drops a guard — and reruns the tests. A mutant
that survives is a change to production code that no test objects to.

```bash
npm run test:mutation
```

Roughly five minutes. The report lands in `reports/mutation/index.html`.

## What is measured, and why only that

Three files:

| File | Why |
|---|---|
| `src/cloud/auth.ts` | Reads, writes and refreshes the credential |
| `src/cloud/client.ts` | Carries the credential on every request |
| `src/publish/pre-publish-check.ts` | The V(g) gate that decides what may be published |

Four modules a reader might expect here are deliberately absent —
`commands/login.ts`, `commands/api-key.ts`, `commands/vg.ts` and
`utils/sandbox-defaults.ts`. They are not untested; they are tested by suites
that spawn the CLI as a child process. That child runs the built code, so
Stryker's edits never reach it and every mutant would survive no matter how
good those tests are. Including them would report a worse number without
learning anything from it.

That distinction is worth carrying: **a subprocess test proves behaviour, and
cannot detect a change in logic.** Both kinds are useful; only one of them
answers the question this tool asks.

## The score

As of 2026-08-19, on 1,181 mutants:

| | Score | Killed | Survived | No coverage |
|---|---|---|---|---|
| **All** | **36.41%** | 430 | 263 | 488 |
| `cloud/auth.ts` | 37.50% | 60 | 37 | 63 |
| `cloud/client.ts` | 22.57% | 146 | 112 | 389 |
| `publish/pre-publish-check.ts` | 59.89% | 224 | 114 | 36 |

This is poor, and it is the first real number this project has had — the
workflow that was supposed to produce it had been failing at load time since
v0.13.0 and measuring nothing.

The score is not perfectly stable — three runs of the same code gave 36.41,
36.41 and 36.49, moving by a fraction of a point as a handful of mutants time
out differently under load. `thresholds.break` is set to **36**: a floor under
the measured score with enough margin to absorb that jitter, so the number
cannot fall meaningfully without failing the build.

It is a ratchet, not a target. Raise it as the score improves; never lower it
to turn a red build green.

## The finding worth acting on first

`auth.ts` decides whether to refresh an expired credential on two lines:

```ts
if (!data.expires_at || Date.now() <= data.expires_at) return;
if (!data.refresh_token) return;
```

Ten mutants live on those two lines and **not one is covered**. Flip `<=` to
`>=`, or delete either guard, and the suite stays green.

There is a test for this — `tests/resilience/token-expiry.test.ts` — and it
does exercise expiry. It runs `execSync('node ' + CLI)`, so it tests the built
binary's behaviour and cannot see a change in the logic that produced it. The
gap is not missing intent; it is a test written at the wrong level for the
question.

Closing it means an in-process test that imports `refreshIfNeeded` and asserts
on the boundary: not expired, expired, expired with no refresh token.

## Configuration notes

`vitest.stryker.config.ts` excludes three test files that call
`process.chdir()`. Stryker's vitest runner executes in worker threads, where
that throws, and one failure in the dry run aborts the pass before any mutant
is tried. The excluded files cover `commands/run`, `commands/network` and
`utils/config` — none of the three mutated files — so nothing that could kill a
mutant here was dropped. They still run under `npm test`.
