#!/usr/bin/env bash
# `supabase start`, retried when an image pull is rate-limited.
#
# `supabase start` pulls about a dozen images at once, and a registry can
# answer `toomanyrequests` (ghcr.io did, all day on 2026-10-26, which is why
# CI now pulls from public.ecr.aws). The CLI retries a pull itself, but only
# for a few seconds, which is not long enough. It also skips an
# image that is already present, so another `supabase start` carries on from
# where the last one stopped.
#
# Only a pull failure is retried: a migration or startup error fails at once,
# so a real problem is not hidden behind three attempts.
#
# Usage: supabase-start-with-retry.sh [--workdir DIR]
# The arguments go to both `supabase start` and the `supabase stop` between
# attempts, so pass only ones both accept.
# RETRY_DELAY_SECONDS (default 30) sets the backoff unit: waits are 1x, 2x.
set -uo pipefail

attempts=3
delay=${RETRY_DELAY_SECONDS:-30}
log=$(mktemp)
trap 'rm -f "$log"' EXIT

for attempt in $(seq 1 "$attempts"); do
  if supabase start "$@" 2>&1 | tee "$log"; then
    exit 0
  fi
  if ! grep -qE 'toomanyrequests|failed to pull docker image' "$log"; then
    exit 1
  fi
  if [ "$attempt" -eq "$attempts" ]; then
    echo "::error::image pulls still rate-limited after $attempts attempts"
    exit 1
  fi
  wait=$((delay * attempt))
  echo "::warning::image pull rate-limited (attempt $attempt of $attempts); retrying in ${wait}s"
  supabase stop --no-backup "$@" >/dev/null 2>&1 || true
  sleep "$wait"
done
