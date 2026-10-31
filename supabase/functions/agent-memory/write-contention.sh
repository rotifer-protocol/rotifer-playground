#!/bin/bash
# Write-contention benchmark for the rate-limit design (README, "Rate limiting").
#
# Option A' puts one per-account counter row on every write's path, so all of
# an account's writes queue on that row. This measures what that costs, next
# to today's behaviour, with pgbench against a local Supabase database:
#
#   one-agent         N clients write to one agent          (today: they already
#                                                            queue on that agent's
#                                                            container row)
#   one-agent+bucket  ... and each also bumps one account row first (A')
#   n-agents          N clients, one agent each, same account (today: no shared row)
#   n-agents+bucket   ... and each also bumps the one account row first (A')
#
# The bucket is emulated: a plain table, updated first in the same transaction
# so its row lock is held until commit — the worst case for A'. Each write is
# agent_memory_write as a signed-in client (RLS, triggers, eviction all live),
# 256-byte values, distinct keys, CACHE.
#
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#     CLIENTS=8 SECONDS_EACH=15 ./write-contention.sh
#
# Local stack only. Creates one throwaway user and a bench_rate_bucket table,
# and removes both at the end. Prints p50/p99/max latency and TPS per scenario.
set -u
DB="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
# A shell profile can export DB_URL for a hosted project: refuse any host
# but this machine (host only in the message, the URL can carry a password).
H="${DB#*://}"; H="${H##*@}"; H="${H%%/*}"; case "$H" in \[*) H="${H%%]*}]" ;; *) H="${H%%:*}" ;; esac
case "$H" in 127.0.0.1|localhost|"[::1]") ;; *) echo "DB_URL points at $H; local stack only (127.0.0.1)" >&2; exit 2 ;; esac
CLIENTS="${CLIENTS:-8}"
SECS="${SECONDS_EACH:-15}"
U=c9e22222-2222-4222-8222-222222222222
GENE="v2:$(printf 'be%.0s' $(seq 32))"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

psql "$DB" -X -q -v ON_ERROR_STOP=1 >/dev/null <<SQL
DELETE FROM auth.users WHERE id = '$U';
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('$U', 'bench@example.com', '{"user_name":"bench_user"}');
INSERT INTO agent_memory_containers (owner_id, agent_id, quota_bytes)
  SELECT '$U', 'bench-' || g, 20971520 FROM generate_series(0, $CLIENTS) g;
DROP TABLE IF EXISTS bench_rate_bucket;
CREATE TABLE bench_rate_bucket (owner_id uuid PRIMARY KEY, calls bigint NOT NULL DEFAULT 0, bytes bigint NOT NULL DEFAULT 0);
INSERT INTO bench_rate_bucket (owner_id) VALUES ('$U');
GRANT SELECT, UPDATE ON bench_rate_bucket TO authenticated;
SQL

script() { # $1 = agent expression, $2 = 1 to bump the bucket first
  {
    echo '\set r random(1, 1000000000)'
    echo 'BEGIN;'
    echo 'SET LOCAL ROLE authenticated;'
    echo "SELECT set_config('request.jwt.claims', '{\"sub\":\"$U\",\"role\":\"authenticated\"}', true);"
    [ "$2" = 1 ] && echo "UPDATE bench_rate_bucket SET calls = calls + 1, bytes = bytes + 256 WHERE owner_id = '$U';"
    echo "SELECT agent_memory_write($1, 'k-' || :client_id || '-' || :r, decode(repeat('ab', 256), 'hex'), 'CACHE', '$GENE', 'bench');"
    echo 'END;'
  }
}

run() { # $1 name, $2 agent expression, $3 bucket
  script "$2" "$3" > "$WORK/$1.sql"
  (cd "$WORK" && pgbench "$DB" -n -c "$CLIENTS" -j "$CLIENTS" -T "$SECS" -f "$1.sql" -l --log-prefix="$1-log" > "$1.out" 2>&1)
  local tps
  tps=$(grep -o 'tps = [0-9.]*' "$WORK/$1.out" | head -1 | cut -d' ' -f3)
  cat "$WORK/$1-log".* 2>/dev/null | awk '{print $3}' | sort -n > "$WORK/$1.lat"
  python3 - "$1" "$WORK/$1.lat" "$tps" "$(grep -c . "$WORK/$1.lat")" "$(grep -o 'number of failed transactions: [0-9]*' "$WORK/$1.out" | grep -o '[0-9]*$')" <<'PY'
import sys
name, path, tps, n, failed = sys.argv[1:6]
lat = [int(x) for x in open(path) if x.strip()]
def pct(p): return lat[min(len(lat) - 1, int(p * len(lat)))] / 1000
print(f"{name:18s} tx={n:>6s} failed={failed or '?':>3s} tps={float(tps or 0):8.1f}  p50={pct(0.50):7.2f} ms  p99={pct(0.99):7.2f} ms  max={lat[-1]/1000:8.2f} ms")
PY
}

echo "clients=$CLIENTS, ${SECS}s each, 256-byte values"
run one-agent         "'bench-0'"                  0
run one-agent-bucket  "'bench-0'"                  1
run n-agents          "'bench-' || :client_id"     0
run n-agents-bucket   "'bench-' || :client_id"     1

psql "$DB" -X -q >/dev/null <<SQL
DROP TABLE IF EXISTS bench_rate_bucket;
DELETE FROM agent_memory_containers WHERE owner_id = '$U';
DELETE FROM auth.users WHERE id = '$U';
SQL
