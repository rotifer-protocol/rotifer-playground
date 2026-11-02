#!/bin/bash
# Applies the deferred PoR migration (20261102200000) to a throwaway database
# and runs supabase/tests/node_attestation.sql against it, refusing to pass
# on a skip. That pgTAP file skips when the nodes table is missing, which
# keeps the regular `supabase test db` green while the migration is deferred;
# here the migration has just been applied, so a skip means the assertions
# never ran, and that fails.
#
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#     bash supabase/functions/node-attestation/pgtap-deferred.sh [--no-apply]
#
# --no-apply leaves the migration out, to check that the guard below fails
# without it. Used by CI (supabase-migrations job). Local stack only.
set -euo pipefail
DB="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
# A shell profile can export DB_URL for a hosted project: refuse any host
# but this machine (host only in the message, the URL can carry a password).
H="${DB#*://}"; H="${H##*@}"; H="${H%%/*}"; case "$H" in \[*) H="${H%%]*}]" ;; *) H="${H%%:*}" ;; esac
case "$H" in 127.0.0.1|localhost|"[::1]") ;; *) echo "DB_URL points at $H; local stack only (127.0.0.1)" >&2; exit 2 ;; esac

MIGRATION=supabase/migrations-deferred-v095-por/20261102200000_node_attestation.sql
TESTS=supabase/tests/node_attestation.sql

if [ "${1:-}" != --no-apply ]; then
  psql "$DB" -X -q -v ON_ERROR_STOP=1 -f "$MIGRATION" >/dev/null
fi

# The pgTAP file decides between its assertions and a single skip by looking
# for the nodes table; the role is what the assertions run as. Both must be
# there, or the run below would be a skip that looks like a pass.
present=$(psql "$DB" -X -t -A -v ON_ERROR_STOP=1 \
  -c "SELECT to_regclass('public.nodes') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'por_issuer')")
if [ "$present" != t ]; then
  echo "::error::the deferred migration is not in this database (no nodes table or no por_issuer role); node_attestation.sql would only skip" >&2
  exit 1
fi

out=$(psql "$DB" -X -q -t -A -v ON_ERROR_STOP=1 -f "$TESTS")
echo "$out"
declared=$(grep -oE 'SELECT plan\([0-9]+\);' "$TESTS" | grep -oE '[0-9]+' | sort -n | tail -1)
plan=$(grep -oE '^1\.\.[0-9]+$' <<<"$out" | head -1 | cut -c4- || true)
passed=$(grep -cE '^ok [0-9]+' <<<"$out" || true)
failed=$(grep -cE '^not ok ' <<<"$out" || true)
skipped=$(grep -ciE '^ok [0-9]+.*# skip' <<<"$out" || true)
echo "declared $declared, planned ${plan:-none}, passed $passed, failed $failed, skipped $skipped"
if [ "${plan:-}" != "$declared" ] || [ "$passed" != "$declared" ] || [ "$failed" != 0 ] || [ "$skipped" != 0 ]; then
  echo "::error::node_attestation.sql must run all $declared assertions and pass them, with no skip" >&2
  exit 1
fi
echo "node_attestation.sql: all $declared assertions ran and passed"
