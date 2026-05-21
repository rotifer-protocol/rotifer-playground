# DCO Validation Marker

This file is throwaway content for end-to-end DCO + branch protection
validation per ADR-287 §D-02 post-deployment dry-run (2026-05-21).

**Will not be merged** — PR will be closed after validation.

## Commit A (this commit)

- Status: SIGNED (with `git commit -s`)
- Expected DCO workflow result: this commit alone would pass

## Commit B (this commit)

- Status: UNSIGNED (intentionally no `-s` flag)
- Expected DCO workflow result: workflow fails because of this unsigned commit
- Expected branch protection behavior: "Required status checks have not passed"
  message appears in PR UI; merge button gated for non-admin users
