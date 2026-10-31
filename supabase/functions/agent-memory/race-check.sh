#!/bin/bash
# Two-session race checks for agent_memory_write / agent_memory_delete
# a second session writing or deleting
# a key while a first holds it must wait, then be checked against what the
# first committed. Single-session pgTAP cannot exercise this.
# Local stack only: DB_URL defaults to the local Supabase Postgres.
# Both checks pass; with the per-key lock
# removed from agent_memory_write, check 1 silently overwrote (value 02).
# A refusal is returned as {error: {code, message},
# expired} rather than raised; the script reads the code from that.
set -u
DB="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
# A shell profile can export DB_URL for a hosted project: refuse any host
# but this machine (host only in the message, the URL can carry a password).
H="${DB#*://}"; H="${H##*@}"; H="${H%%/*}"; case "$H" in \[*) H="${H%%]*}]" ;; *) H="${H%%:*}" ;; esac
case "$H" in 127.0.0.1|localhost|"[::1]") ;; *) echo "DB_URL points at $H; local stack only (127.0.0.1)" >&2; exit 2 ;; esac
U=c9e11111-1111-4111-8111-111111111111
AS="SET ROLE authenticated; SELECT set_config('request.jwt.claims', '{\"sub\":\"$U\",\"role\":\"authenticated\"}', false);"
q() { psql "$DB" -X -q -t -A -v ON_ERROR_STOP=0 -c "$1" 2>&1; }

q "DELETE FROM auth.users WHERE id = '$U'; INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES ('$U', 'race@example.com', '{\"user_name\":\"race_user\"}');" >/dev/null

echo "## 1. first write of a key: gene-1 (CREATOR_GENE_ONLY write) vs gene-2, same moment"
psql "$DB" -X -q -t -A >/dev/null 2>&1 <<SQL &
$AS
BEGIN;
SELECT agent_memory_write('race', 'k1', '\x01', 'CONTEXT', 'v2:1111111111111111111111111111111111111111111111111111111111111111', 'd1', NULL, 'CREATOR_GENE_ONLY');
SELECT pg_sleep(3);
COMMIT;
SQL
sleep 1
start=$(date +%s)
out2=$(psql "$DB" -X -q -t -A 2>&1 <<SQL
$AS
SELECT agent_memory_write('race', 'k1', '\x02', 'CONTEXT', 'v2:2222222222222222222222222222222222222222222222222222222222222222', 'd2');
SQL
)
waited=$(( $(date +%s) - start ))
wait
echo "session 2 waited ${waited}s; said: $(echo "$out2" | sed -n 's/.*"code": "\(MEMORY_[A-Z_]*\)", "message": "\([^"]*\)".*/\1: \2/p' | head -1)"
echo "stored value: $(q "SELECT encode(value,'hex'), created_by FROM agent_memory_entries WHERE owner_id='$U' AND key='k1'")"
echo "expect: waited >=1s, MEMORY_ACCESS_DENIED: write denied, value 01 by gene-1"

echo "## 2. delete vs a concurrent policy change: gene-2 deletes while gene-1 narrows writeScope"
q "$AS SELECT agent_memory_write('race', 'k2', '\x01', 'CONTEXT', 'v2:1111111111111111111111111111111111111111111111111111111111111111', 'd1', NULL, 'ALL_GENES');" >/dev/null
psql "$DB" -X -q -t -A >/dev/null 2>&1 <<SQL &
$AS
BEGIN;
SELECT agent_memory_write('race', 'k2', '\x01', 'CONTEXT', 'v2:1111111111111111111111111111111111111111111111111111111111111111', 'd1', NULL, 'CREATOR_GENE_ONLY');
SELECT pg_sleep(3);
COMMIT;
SQL
sleep 1
start=$(date +%s)
out3=$(psql "$DB" -X -q -t -A 2>&1 <<SQL
$AS
SELECT agent_memory_delete('race', 'k2', 'v2:2222222222222222222222222222222222222222222222222222222222222222', 'd2');
SQL
)
waited=$(( $(date +%s) - start ))
wait
echo "session 2 waited ${waited}s; said: $(echo "$out3" | sed -n 's/.*"code": "\(MEMORY_[A-Z_]*\)", "message": "\([^"]*\)".*/\1: \2/p' | head -1)"
echo "k2 still there: $(q "SELECT count(*) FROM agent_memory_entries WHERE owner_id='$U' AND key='k2'")"
echo "expect: waited >=1s, MEMORY_ACCESS_DENIED: delete denied, count 1"

q "DELETE FROM agent_memory_containers WHERE owner_id='$U'; DELETE FROM auth.users WHERE id = '$U';" >/dev/null
