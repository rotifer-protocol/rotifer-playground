#!/usr/bin/env bash
# Regression Guard — CI gate for PRs.
# Hard-fail: net test-file loss, new .skip/.todo/.only in TS tests, new
#            unconditional #[ignore] on Rust tests.
# Warn-only: source changed without any test change in the same PR.
#
# Rust unit tests live inline in the source file under `#[cfg(test)]`, so path
# matching alone cannot see them — the checks below look at diff content for
# `.rs` files and at paths for everything else.
set -euo pipefail

BASE_REF="${GITHUB_BASE_REF:-main}"
FAIL=0

git fetch origin "${BASE_REF}" --depth=50 2>/dev/null || true
MERGE_BASE="$(git merge-base "origin/${BASE_REF}" HEAD 2>/dev/null || git merge-base "${BASE_REF}" HEAD 2>/dev/null || echo "")"
if [ -z "${MERGE_BASE}" ]; then
  echo "::warning::Regression Guard: could not resolve merge base — skipping diff checks"
  exit 0
fi

is_test_path() {
  case "$1" in
    tests/*|*/tests/*|*.test.ts|*.test.tsx|*.spec.ts|*.spec.tsx|*.e2e.ts|*.e2e.tsx)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

is_src_path() {
  case "$1" in
    src/*|functions/*|crates/*|worker/src/*|site/src/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

added_tests=0
deleted_tests=0
src_touched=0
tests_touched=0

while IFS=$'\t' read -r status path extra; do
  [ -z "${path:-}" ] && continue
  case "${status}" in
    A) is_test_path "$path" && added_tests=$((added_tests + 1)) ;;
    D) is_test_path "$path" && deleted_tests=$((deleted_tests + 1)) ;;
    R*|C*)
      old="${extra:-}"
      is_test_path "$path" && added_tests=$((added_tests + 1))
      [ -n "$old" ] && is_test_path "$old" && deleted_tests=$((deleted_tests + 1))
      ;;
  esac
  is_src_path "$path" && src_touched=1
  is_test_path "$path" && tests_touched=1
done < <(git diff --name-status "${MERGE_BASE}" HEAD)

# Rust: a `#[test]` added inside a source file is a test change even though the
# path looks like plain source. Without this, a Rust-only test PR trips the
# "source changed but no tests" warning.
RUST_TESTS_ADDED="$(git diff "${MERGE_BASE}" HEAD -- '*.rs' 2>/dev/null \
  | grep -cE '^\+[[:space:]]*#\[(tokio::|async_std::)?test\]' || true)"
if [ "${RUST_TESTS_ADDED}" -gt 0 ]; then
  tests_touched=1
fi

if [ "${deleted_tests}" -gt "${added_tests}" ]; then
  echo "::error::Regression Guard: test surface shrank (deleted ${deleted_tests}, added ${added_tests}). Restore tests or document intentional removal in the PR."
  FAIL=1
fi

# Anchored on the paren so `it.skip(`/`test.skip(`/`describe.skip(` — an
# *unconditional* skip, always a coverage loss — is caught regardless of
# which of the three it's called on, while `it.skipIf(condition)` is not:
# that's a *conditional* skip tied to a genuine runtime precondition (a
# missing native addon, an unavailable external tool), and it is already an
# established pattern in this repo (tests/e2e/dogfooding-pipeline.test.ts and
# seven other files predate this guard). The three now-removed bare
# alternatives (`it\.skip`, `test\.skip`, `describe\.skip`, no required
# trailing paren) were redundant with this one anyway — anything they matched
# with a paren, this pattern already catches — and without the paren they
# matched `it.skipIf(` too, as a false positive: "it.skip" is a literal
# substring of "it.skipIf". Confirmed against #316, the PR this comment
# shipped with: three legitimate skipIf additions, zero real skips.
SKIP_HITS="$(git diff "${MERGE_BASE}" HEAD -- 'tests/**' '*.test.ts' '*.test.tsx' '*.spec.ts' '*.spec.tsx' '*.e2e.ts' 2>/dev/null \
  | grep -E '^\+.*\.(skip|todo|only)\(' || true)"
if [ -n "${SKIP_HITS}" ]; then
  echo "::error::Regression Guard: new test skip/todo/only detected — weakens regression protection:"
  echo "${SKIP_HITS}" | head -20
  FAIL=1
fi

# Rust equivalent of the skip check. Only unconditional `#[ignore]` counts: a
# feature-gated `#[cfg_attr(not(feature = "..."), ignore = "...")]` keeps the
# test runnable on demand and is an established pattern here, so it is spelled
# across lines and never matches this anchored pattern.
RUST_IGNORE_HITS="$(git diff "${MERGE_BASE}" HEAD -- '*.rs' 2>/dev/null \
  | grep -E '^\+[[:space:]]*#\[ignore' || true)"
if [ -n "${RUST_IGNORE_HITS}" ]; then
  echo "::error::Regression Guard: new unconditional #[ignore] on a Rust test — weakens regression protection:"
  echo "${RUST_IGNORE_HITS}" | head -20
  echo "::notice::If the test genuinely cannot run yet, gate it on a feature instead: #[cfg_attr(not(feature = \"...\"), ignore = \"...\")]"
  FAIL=1
fi

if [ "${src_touched}" -eq 1 ] && [ "${tests_touched}" -eq 0 ]; then
  echo "::warning::Regression Guard: source changed but no test change in this diff — confirm old behavior is still covered, or add a regression test."
fi

if [ "${FAIL}" -ne 0 ]; then
  exit 1
fi

echo "✅ Regression Guard passed (test files +${added_tests}/-${deleted_tests}, Rust #[test] added: ${RUST_TESTS_ADDED})"
