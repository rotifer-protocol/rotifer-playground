#!/bin/bash
# Concurrency checks for node_attestation_issue (deferred migration
# 20261102200000). Single-session pgTAP cannot exercise these: each needs two
# or more sessions redeeming at the same time.
#
#   1. limit: a redemption of a 4th PeerId while another session holds the
#      3rd uncommitted must wait for it, then be refused.
#   2. nonce: the same challenge redeemed by two sessions at once is
#      accepted once.
#   3. rebinding: two accounts claiming one new PeerId at once: one wins.
#   4. burst: 5 sessions, one account, 5 different PeerIds, released
#      together: exactly 3 are accepted.
#
# Every challenge is taken before the race starts, so a session waits in
# node_attestation_issue (on its locks), not in node_attestation_challenge.
# Challenges and redemptions go through a login as por_issuer, as the edge
# function's do; the password is made here, never written down, and the role
# goes back to NOLOGIN at the end.
# Exits 1 on the first wrong result. Local stack only; the database must have
# the deferred migration applied (see supabase/tests/node_attestation.sql).
set -u
DB="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
# A shell profile can export DB_URL for a hosted project: refuse any host
# but this machine (host only in the message, the URL can carry a password).
H="${DB#*://}"; H="${H##*@}"; H="${H%%/*}"; case "$H" in \[*) H="${H%%]*}]" ;; *) H="${H%%:*}" ;; esac
case "$H" in 127.0.0.1|localhost|"[::1]") ;; *) echo "DB_URL points at $H; local stack only (127.0.0.1)" >&2; exit 2 ;; esac

U1=e7e11111-1111-4111-8111-111111111111
U2=e7e22222-2222-4222-8222-222222222222
U3=e7e33333-3333-4333-8333-333333333333
AUD=http://127.0.0.1/functions/v1/node-attestation
SUB=rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr
# A PeerId-shaped base58 string ending in the $1-th base58 digit (no 0, O, I, l).
peer() { printf '12D3KooWRaceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%s' "$(echo 123456789ABCDEFGHJKLMNPQRSTUVWXYZ | cut -c"$1")"; }
q() { psql "$DB" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"; }
case "$DB" in *://*@*) ;; *) echo "DB_URL must name a user (postgres)" >&2; exit 2 ;; esac
ISSUER="${DB%%://*}://por_issuer@${DB##*@}"
PW=$(openssl rand -hex 24)
# As por_issuer; the password travels in the environment, not on a command line.
iq() { PGPASSWORD="$PW" psql "$ISSUER" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"; }
isession() { PGPASSWORD="$PW" psql "$ISSUER" -X -q -t -A -v ON_ERROR_STOP=1 >/dev/null; }
fail() { echo "FAIL: $*" >&2; cleanup; exit 1; }
cleanup() {
  # The issuance log is append-only; the trigger is bypassed only here, for
  # this script's own throwaway rows on the local stack.
  q "SET session_replication_role = replica;
     DELETE FROM node_attestation_issuances WHERE user_id IN ('$U1','$U2','$U3');
     SET session_replication_role = origin;
     DELETE FROM auth.users WHERE id IN ('$U1','$U2','$U3');
     ALTER ROLE por_issuer NOLOGIN PASSWORD NULL;" >/dev/null
}

# A fresh challenge for $1, as "nonce_hex|challenge_exp".
challenge() {
  iq "SELECT j->>'nonce' || '|' || (j->>'challenge_exp') FROM node_attestation_challenge('$1', '$AUD') j;" | tail -1
}
# SQL that redeems challenge $2 for user $1 and PeerId $3; prints OK or the refusal code.
issue_sql() {
  local nonce="${2%%|*}" exp="${2##*|}"
  echo "SELECT coalesce(r->>'error', 'OK') FROM (SELECT node_attestation_issue('$1', '$AUD', decode('$nonce', 'hex'), $exp, '$3', '$SUB',
          floor(extract(epoch FROM now()))::bigint, floor(extract(epoch FROM now()))::bigint + 604800, 'k1') r) x;"
}
issue() { iq "$(issue_sql "$1" "$2" "$3")" | tail -1; }
live() {
  q "SELECT count(DISTINCT peer_id) FROM node_attestation_issuances i WHERE user_id = '$1'
       AND exp + 60 >= floor(extract(epoch FROM now()))
       AND NOT EXISTS (SELECT 1 FROM node_attestation_revocations r WHERE r.peer_id = i.peer_id AND i.iat <= r.not_after);"
}

[ "$(q "SELECT to_regclass('public.nodes') IS NOT NULL")" = t ] || { echo "the deferred migration is not applied" >&2; exit 2; }
cleanup
printf "ALTER ROLE por_issuer LOGIN PASSWORD '%s';\n" "$PW" | psql "$DB" -X -q -v ON_ERROR_STOP=1 >/dev/null
[ "$(iq "SELECT current_user")" = por_issuer ] || fail "cannot log in as por_issuer"
q "INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
     ('$U1', 'race-1@example.com', '{\"user_name\":\"por_race_1\"}'),
     ('$U2', 'race-2@example.com', '{\"user_name\":\"por_race_2\"}'),
     ('$U3', 'race-3@example.com', '{\"user_name\":\"por_race_3\"}');" >/dev/null

echo "## 1. limit: U1 holds 2; session A takes the 3rd and holds; session B asks for a 4th"
[ "$(issue $U1 "$(challenge $U1)" "$(peer 1)")" = OK ] || fail "setup: P1"
[ "$(issue $U1 "$(challenge $U1)" "$(peer 2)")" = OK ] || fail "setup: P2"
ca=$(challenge $U1); cb=$(challenge $U1)
isession <<SQL &
BEGIN;
$(issue_sql $U1 "$ca" "$(peer 3)")
SELECT pg_sleep(3);
COMMIT;
SQL
sleep 1
start=$(date +%s)
outb=$(issue $U1 "$cb" "$(peer 4)")
waited=$(( $(date +%s) - start ))
wait
echo "session B waited ${waited}s and got $outb; U1 live PeerIds: $(live $U1)"
[ "$waited" -ge 1 ] || fail "1: session B did not wait for session A"
[ "$outb" = POR_QUOTA_EXCEEDED ] || fail "1: expected POR_QUOTA_EXCEEDED, got $outb"
[ "$(live $U1)" = 3 ] || fail "1: U1 has $(live $U1) live PeerIds, expected 3"

echo "## 2. nonce: one challenge of U2 redeemed by two sessions at once"
c=$(challenge $U2)
isession <<SQL &
BEGIN;
$(issue_sql $U2 "$c" "$(peer 5)")
SELECT pg_sleep(3);
COMMIT;
SQL
sleep 1
outb=$(issue $U2 "$c" "$(peer 6)")
wait
n=$(q "SELECT count(*) FROM node_attestation_issuances WHERE user_id = '$U2'")
echo "second redemption got $outb; U2 certificates: $n"
[ "$outb" = POR_CHALLENGE_INVALID ] || fail "2: expected POR_CHALLENGE_INVALID, got $outb"
[ "$n" = 1 ] || fail "2: U2 has $n certificates, expected 1"

echo "## 3. rebinding: U2 and U3 claim a new PeerId at once"
ca=$(challenge $U2); cb=$(challenge $U3)
isession <<SQL &
BEGIN;
$(issue_sql $U2 "$ca" "$(peer 7)")
SELECT pg_sleep(3);
COMMIT;
SQL
sleep 1
outb=$(issue $U3 "$cb" "$(peer 7)")
wait
owner=$(q "SELECT user_id FROM nodes WHERE peer_id = '$(peer 7)'")
echo "U3 got $outb; P7 belongs to $owner"
[ "$outb" = POR_PEER_BOUND_ELSEWHERE ] || fail "3: expected POR_PEER_BOUND_ELSEWHERE, got $outb"
[ "$owner" = "$U2" ] || fail "3: P7 belongs to $owner, expected U2"
[ "$(q "SELECT count(*) FROM node_attestation_issuances WHERE peer_id = '$(peer 7)'")" = 1 ] || fail "3: P7 has more than one certificate"

echo "## 4. burst: U3, 5 sessions, 5 PeerIds, released together (5 = the open-challenge limit)"
chs=()
for i in 1 2 3 4 5; do chs+=("$(challenge $U3)"); done
dir=$(mktemp -d)
for i in 0 1 2 3 4; do
  ( while [ ! -e "$dir/go" ]; do :; done; issue $U3 "${chs[$i]}" "$(peer $((10 + i)))" > "$dir/out$i" ) &
done
touch "$dir/go"; wait
ok=$(cat "$dir"/out* | grep -c '^OK$')
refused=$(cat "$dir"/out* | grep -c '^POR_QUOTA_EXCEEDED$')
rm -rf "$dir"
echo "accepted $ok, refused $refused; U3 live PeerIds: $(live $U3)"
[ "$ok" = 3 ] || fail "4: $ok accepted, expected 3"
[ "$refused" = 2 ] || fail "4: $refused refused with POR_QUOTA_EXCEEDED, expected 2"
[ "$(live $U3)" = 3 ] || fail "4: U3 has $(live $U3) live PeerIds, expected 3"

cleanup
echo "all 4 checks passed"
