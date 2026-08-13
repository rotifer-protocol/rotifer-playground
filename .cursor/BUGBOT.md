# Bugbot — Regression Review Instructions

> Policy: daily automatic Bugbot stays **OFF** (cost). Bugbot runs on release day.

## Focus

Review for **regression risk** — changes that could break behavior users already rely on.

## Priority checks

1. **Behavior without tests** — logic changed but no new/updated tests in the same PR.
2. **Weakened tests** — deleted tests, new `.skip` / `.todo` / `.only`, or assertions made less strict.
3. **Public surface** — CLI commands, MCP tools, HTTP routes, or wire formats changed without migration notes.
4. **Release PRs** — CHANGELOG claims match the diff; version bumps are intentional.

## Where this applies

| Class | Scope | Pre-merge gate | Release-day Bugbot |
|-------|-------|----------------|-------------------|
| **A — published packages** | this repo and the MCP server | PR CI + branch protection | **Required** on the Release PR before merge |
| **B — auto-deploying sites** | sites where a push to `main` deploys | PR CI only | Retrospective; still run on a Release PR if one exists |

## Release PR workflow

On each Release PR (published packages are primary; the VS Code family goes through its own release workflow; sites only if logic changed):

1. Comment `bugbot run`, or trigger the Cursor review on GitHub.
2. Wait for completion; fix or explicitly accept remaining 🔴 items.
3. Do **not** merge until the safety belt passes: CI green, coverage not down versus base, skips not up.

## Accepting a risk

When a finding is intentional, reply on the PR:

```
接受回归风险：[reason] — [name] [date]
```

## Out of scope

- Style-only nits with no regression impact.
- Proposing daily Bugbot on every PR — the policy is release-day only.
