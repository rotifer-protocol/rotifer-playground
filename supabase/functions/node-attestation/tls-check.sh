#!/bin/bash
# Connects the function's driver (postgres@3.4.7 under Deno) to a real TLS
# Postgres with the options databaseTls() builds, and checks that it gets in
# only with the right root CA and the right host name.
#
# Needs Postgres server binaries (initdb, pg_ctl) and openssl on PATH, plus
# deno. Starts a throwaway server on 127.0.0.1 and [::1], port $PORT (default
# 56442), and deletes it at the end. Nothing here touches a real database.
#
#   bash supabase/functions/node-attestation/tls-check.sh
set -euo pipefail
export LC_ALL=C

ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
PORT=${PORT:-56442}
WORK=$(mktemp -d)
DATA="$WORK/data"
trap 'pg_ctl -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

# Two unrelated CAs, and server certificates from the first one for the right
# host name and for a wrong one.
cert() { # name subject-alt-name ca-name
  openssl req -new -newkey rsa:2048 -nodes -keyout "$WORK/$1.key" -subj "/CN=$1" -out "$WORK/$1.csr" 2>/dev/null
  printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\n' "$2" >"$WORK/$1.ext"
  openssl x509 -req -in "$WORK/$1.csr" -CA "$WORK/$3.crt" -CAkey "$WORK/$3.key" -CAcreateserial -days 2 -extfile "$WORK/$1.ext" -out "$WORK/$1.crt" 2>/dev/null
  chmod 600 "$WORK/$1.key"
}
for ca in right-ca wrong-ca; do
  openssl req -x509 -new -newkey rsa:2048 -nodes -keyout "$WORK/$ca.key" -subj "/CN=$ca" -days 2 -out "$WORK/$ca.crt" 2>/dev/null
done
cert server-localhost "DNS:localhost" right-ca
cert server-elsewhere "DNS:db.elsewhere.example" right-ca

initdb -D "$DATA" -U postgres -A trust --no-locale -E UTF8 >/dev/null
printf 'hostssl all all 127.0.0.1/32 trust\nhostssl all all ::1/128 trust\n' >"$DATA/pg_hba.conf"

start() { # server certificate name
  pg_ctl -D "$DATA" -l "$WORK/log" -w start -o "-p $PORT -c listen_addresses='127.0.0.1,::1' -c unix_socket_directories='' -c ssl=on -c ssl_cert_file=$WORK/$1.crt -c ssl_key_file=$WORK/$1.key" >/dev/null
}
stop() { pg_ctl -D "$DATA" -m fast -w stop >/dev/null; }

# Each case: the CA file to trust, and whether the connection must succeed.
run() { # label ca-file|"" expect(ok|refused) [ssl-override]
  ROOT="$ROOT" PORT="$PORT" CA_FILE="$2" EXPECT="$3" SSL_OVERRIDE="${4:-}" LABEL="$1" \
    deno run --allow-all --no-lock --node-modules-dir=none - <<'TS'
import postgres from "npm:postgres@3.4.7";
const root = Deno.env.get("ROOT")!;
const { databaseTls } = await import(`file://${root}/supabase/functions/node-attestation/store.ts`);
const caFile = Deno.env.get("CA_FILE")!;
const override = Deno.env.get("SSL_OVERRIDE");
// The options for a production URL, then pointed at the throwaway server:
// databaseTls skips TLS for a local URL, so it is asked about a remote one.
const remote = "postgres://por_issuer.ref:pw@aws-1-us-west-1.pooler.supabase.com:6543/postgres?sslmode=verify-full";
const ssl = override
  ? override
  : caFile === ""
  ? { rejectUnauthorized: true }
  : databaseTls(remote, [await Deno.readTextFile(caFile)]).ssl;
const sql = postgres(`postgres://postgres@localhost:${Deno.env.get("PORT")}/postgres`, { max: 1, connect_timeout: 5, ssl });
let outcome: string;
try {
  const [r] = await sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`;
  outcome = r.ssl === true ? "ok" : "connected without TLS";
} catch (e) {
  outcome = `refused (${(e as Error).message.slice(0, 80)})`;
} finally {
  await sql.end({ timeout: 1 }).catch(() => {});
}
const expect = Deno.env.get("EXPECT")!;
const pass = outcome === expect || (expect === "refused" && outcome.startsWith("refused"));
console.log(`${pass ? "PASS" : "FAIL"} ${Deno.env.get("LABEL")}: ${outcome}`);
if (!pass) Deno.exit(1);
TS
}

failed=0
start server-localhost
run "right CA, right host name" "$WORK/right-ca.crt" ok || failed=1
run "another CA" "$WORK/wrong-ca.crt" refused || failed=1
run "no CA (the runtime's own trust store)" "" refused || failed=1
run "sslmode=verify-full with no CA, as the function did before" "" refused verify-full || failed=1
run "sslmode=require: gets in with any certificate, which is why it is refused" "" ok require || failed=1
stop
start server-elsewhere
run "right CA, certificate for another host name" "$WORK/right-ca.crt" refused || failed=1
stop

if [ "$failed" -ne 0 ]; then
  echo "tls-check: FAILED" >&2
  exit 1
fi
echo "tls-check: all 6 cases as expected"
