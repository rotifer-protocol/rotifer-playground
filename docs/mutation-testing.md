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
| **All** | **38.87%** | 459 | 277 | 445 |
| `cloud/auth.ts` | 55.63% | 89 | 51 | 20 |
| `cloud/client.ts` | 22.57% | 146 | 112 | 389 |
| `publish/pre-publish-check.ts` | 59.89% | 224 | 114 | 36 |

Still poor, and still the first real number this project has had — the
workflow that was supposed to produce it had been failing at load time since
v0.13.0 and measuring nothing.

The first measurement, before the refresh guards were covered, read 36.33%
overall with `auth.ts` at 36.88% and 63 of its mutants never reached. Covering
one function moved that file to 55.63% and dropped its uncovered count to 20.
Two thirds of the remaining gap is `client.ts`, where 389 mutants are still in
code no in-process test executes.

The score is not perfectly stable. Four runs of the earlier code read 36.33
(CI), 36.41, 36.41 and 36.49 — `coverageAnalysis: "perTest"` is slightly
non-deterministic under concurrency, so which mutants are attributed to which
test shifts a little and a handful land in "no coverage" on one run but not the
next. CI reads a shade under local.

`thresholds.break` is **37**, below the 38.87 measured here with room for that
jitter. It has moved once already: 35 at first measurement, 37 once the refresh
guards were covered.

The floor sits below the band rather than against it, deliberately. An earlier
draft set it 0.33 above the lowest observed run, which is close enough that an
unlucky pass fails for no reason — and a gate that goes red at random is the
failure mode this whole file exists to describe.

It is a ratchet, not a target. Raise it as the score improves; never lower it
to turn a red build green.

## The first finding, and what closing it looked like

`auth.ts` decides whether to refresh an expired credential on two lines:

```ts
if (!data.expires_at || Date.now() <= data.expires_at) return;
if (!data.refresh_token) return;
```

Ten mutants live there, and on the first run **not one was covered**. Flipping
`<=` to `>` — which reverses the decision, so expired credentials are never
renewed and valid ones are renewed constantly — left the suite green.

A test for this already existed. `tests/resilience/token-expiry.test.ts` does
exercise expiry, via `execSync('node ' + CLI)`. It tests the built binary's
behaviour and cannot see a change in the logic that produced it. The gap was
not missing intent; it was a test written at the wrong level for the question.

`tests/unit/token-refresh-guards.test.ts` closes it by importing the function
and pinning each decision through the one observable that separates them —
whether the network call happens at all:

| Case | Expected |
|---|---|
| Expired | renews |
| Still valid | does not renew |
| Exactly at `expires_at` | does not renew |
| One millisecond past | renews |
| No expiry recorded | does not renew |
| Expired, no refresh token | does not renew |
| Endpoint refuses | keeps the old credential |
| Unreadable credentials file | returns quietly |

The two boundary cases exist for one mutant: `<=` replaced by `<`, which
renews one millisecond early. Only a test sitting exactly on the instant can
tell those apart, which is the kind of case a person writing tests by
intuition rarely reaches for and a mutation report names outright.

All ten mutants are killed. `auth.ts` went from 36.88% to 55.63%.

## Configuration notes

`vitest.stryker.config.ts` excludes three test files that call
`process.chdir()`. Stryker's vitest runner executes in worker threads, where
that throws, and one failure in the dry run aborts the pass before any mutant
is tried. The excluded files cover `commands/run`, `commands/network` and
`utils/config` — none of the three mutated files — so nothing that could kill a
mutant here was dropped. They still run under `npm test`.
