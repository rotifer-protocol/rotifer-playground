#!/usr/bin/env bash
# Script tests for deploy/p2p-server: install, upgrade, rollback, the quota
# and the status command, run against a scratch DEPLOY_ROOT with stand-ins
# for nft, systemctl, runuser, useradd, npm and the rotifer packages.
#
#   bash deploy/p2p-server/test/run.sh
#
# What these cannot show (the kernel's nftables, systemd, the real npm
# registry and signatures, the real node) is checked on a Linux VM, as
# RUNBOOK.md "Pre-launch checks" lists.

set -uo pipefail
DEPLOY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="$(sed -n 's/^[[:space:]]*"@rotifer\/playground":[[:space:]]*"\([^"]*\)".*/\1/p' "$DEPLOY/package.json")"
NODE_REAL="$(command -v node)" || {
	echo "needs node on PATH"
	exit 1
}
PASS=0
FAIL=0
FAILED=()

ok() { PASS=$((PASS + 1)); }
bad() {
	FAIL=$((FAIL + 1))
	FAILED+=("$CASE: $*")
	echo "  ✖ $*"
}
expect() { # expect <description> <command...>
	local what="$1"
	shift
	if "$@" >/dev/null 2>&1; then ok; else bad "$what"; fi
}
expect_not() {
	local what="$1"
	shift
	if "$@" >/dev/null 2>&1; then bad "$what"; else ok; fi
}

# ---------------------------------------------------------------- stand-ins

make_stubs() {
	local b="$T/bin"
	mkdir -p "$b"
	# GNU tools the scripts use, on macOS from Homebrew coreutils.
	local tool g
	for tool in mv sha256sum tac; do
		if g="$(command -v "g$tool")"; then ln -s "$g" "$b/$tool"; fi
	done
	cat >"$b/sleep" <<-'EOF'
		#!/usr/bin/env bash
		exit 0
	EOF
	cat >"$b/date" <<-EOF
		#!/usr/bin/env bash
		if [[ -n "\${FAKE_DATE:-}" && "\${2:-}" == '+%Y %m %d' ]]; then echo "\$FAKE_DATE"; exit 0; fi
		exec $(command -v date) "\$@"
	EOF
	cat >"$b/runuser" <<-'EOF'
		#!/usr/bin/env bash
		while [[ "$1" != -- ]]; do shift; done; shift
		echo "runuser $*" >>"$T/calls.log"
		exec "$@"
	EOF
	cat >"$b/useradd" <<-'EOF'
		#!/usr/bin/env bash
		echo "useradd $*" >>"$T/calls.log"
	EOF
	cat >"$b/curl" <<-'EOF'
		#!/usr/bin/env bash
		echo "curl $*" >>"$T/calls.log"; exit 1
	EOF
	cat >"$b/systemctl" <<-'EOF'
		#!/usr/bin/env bash
		echo "systemctl $*" >>"$T/calls.log"
		# What the units would run: rotifer-firewall.service loads the rules.
		case "$*" in
		"restart rotifer-firewall.service" | "reload rotifer-firewall.service")
			exec "$DEPLOY_ROOT/opt/rotifer/current/deploy/rotifer-quota" load ;;
		"show "*) printf 'ActiveState=active\nSubState=running\nNRestarts=0\n' ;;
		esac
		exit 0
	EOF
	# nft: keeps the loaded ruleset in $T/nft.rules; the quota's use is the
	# loaded "used" plus $T/nft.extra (bytes "sent" since the load).
	cat >"$b/nft" <<-'EOF'
		#!/usr/bin/env bash
		echo "nft $*" >>"$T/calls.log"
		case "$*" in
		"-c -f -") r="$(cat)"; grep -q '@[A-Z_]*@' <<<"$r" && exit 1; grep -q 'table inet rotifer' <<<"$r" ;;
		"-f -") cat >"$T/nft.rules"; rm -f "$T/nft.extra" ;;
		"-j list quota inet rotifer egress")
			[[ -f "$T/nft.rules" ]] || exit 1
			u="$(sed -n 's/.*used \([0-9]*\) bytes.*/\1/p' "$T/nft.rules" | head -n 1)"
			u=$((u + $(cat "$T/nft.extra" 2>/dev/null || echo 0)))
			echo "{\"nftables\": [{\"metainfo\": {}}, {\"quota\": {\"family\": \"inet\", \"name\": \"egress\", \"table\": \"rotifer\", \"bytes\": 1, \"used\": $u, \"inv\": true}}]}" ;;
		"-j list set inet rotifer p2p_dropped")
			[[ -f "$T/nft.rules" ]] || exit 1
			echo '{"nftables": [{"metainfo": {}}, {"set": {"name": "p2p_dropped", "elem": [{"elem": {"val": "x"}}, {"elem": {"val": "y"}}]}}]}' ;;
		*) exit 2 ;;
		esac
	EOF
	chmod +x "$b"/*
}

# A fake @rotifer/playground <version> and its native package. Variants:
# old (native without networkStats), broken (the daemon never answers),
# noconsent (predates `network consent`, T-237 B5).
make_package() {
	local version="$1" variant="${2:-}"
	local dir="$T/pkgs/$version${2:+-$2}"
	mkdir -p "$dir/playground/bin" "$dir/native"
	cat >"$dir/playground/package.json" <<-EOF
		{ "name": "@rotifer/playground", "version": "$version", "bin": { "rotifer": "bin/rotifer.js" } }
	EOF
	cat >"$dir/playground/bin/rotifer.js" <<-EOF
		#!/usr/bin/env node
		const a = process.argv.slice(2).join(" ");
		const variant = "$variant", version = "$version";
		const fs = require("fs");
		if (a === "--version") { console.log(version); process.exit(0); }
		if (a === "network start --help") { console.log("  --foreground  run in this process"); process.exit(0); }
		if (a.startsWith("network status --json")) {
		  if (variant === "broken") { console.log('{"running":false}'); process.exit(1); }
		  console.log(JSON.stringify({ running: true, version, roles: ["bootstrap", "relay"], connections: { inbound: 3 }, peerSecret: "must-not-print" }, null, 2));
		  process.exit(0);
		}
		if (a.startsWith("network status --state-file")) { console.log("\x1b[1m  PeerId\x1b[0m           12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo"); process.exit(0); }
		// Without the subcommand, the CLI prints the parent's help and exits 0.
		if (a === "network consent --help") { if (variant !== "noconsent") console.log("  --accept     record consent"); process.exit(0); }
		if (a === "network consent --accept" && variant !== "noconsent") { fs.writeFileSync(process.env.HOME + "/consent-accepted", "y"); process.exit(0); }
		if (a.startsWith("network start --foreground")) { console.log("ARGS " + a); process.exit(0); }
		process.exit(9);
	EOF
	cat >"$dir/native/package.json" <<-'EOF'
		{ "name": "@rotifer/playground-linux-x64-gnu", "version": "0.0.0", "main": "index.js" }
	EOF
	if [[ "$variant" == old ]]; then
		echo 'class P2PNode { start() {} } module.exports = { P2PNode };' >"$dir/native/index.js"
	else
		echo 'class P2PNode { start() {} networkStats() {} } module.exports = { P2PNode };' >"$dir/native/index.js"
	fi
}

# The pinned Node in place (so nothing is downloaded), with a fake npm that
# installs the fake packages: `ci` by the pin in package.json (variant from
# $T/variant-<version>), `install` from the file: tarballs.
make_node() {
	local version bin
	version="$(sed -n 1p "$DEPLOY/node-version")"
	bin="$ROOT/opt/rotifer/node/$version/bin"
	mkdir -p "$bin"
	ln -s "$NODE_REAL" "$bin/node"
	cat >"$bin/npm" <<-'EOF'
		#!/usr/bin/env bash
		echo "npm $*" >>"$T/calls.log"
		place() { # place <playground dir> <native dir>
			mkdir -p node_modules/@rotifer node_modules/.bin
			cp -R "$1" node_modules/@rotifer/playground
			cp -R "$2" node_modules/@rotifer/playground-linux-x64-gnu
			ln -s ../@rotifer/playground/bin/rotifer.js node_modules/.bin/rotifer
		}
		case "$1" in
		ci)
			v="$(sed -n 's/.*"@rotifer\/playground": *"\([^"]*\)".*/\1/p' package.json)"
			variant="$(cat "$T/variant-$v" 2>/dev/null || true)"
			d="$T/pkgs/$v${variant:+-$variant}"
			[[ -d "$d" ]] || exit 1
			place "$d/playground" "$d/native" ;;
		audit) [[ -e "$T/audit-fails" ]] && { echo "1 package has an invalid registry signature" >&2; exit 1; }; exit 0 ;;
		install)
			mkdir -p x/main x/native
			tar -xzf "$(sed -n 's/.*"@rotifer\/playground": *"file:\([^"]*\)".*/\1/p' package.json)" -C x/main
			tar -xzf "$(sed -n 's/.*"@rotifer\/playground-linux-x64-gnu": *"file:\([^"]*\)".*/\1/p' package.json)" -C x/native
			place x/main/package x/native/package; rm -rf x ;;
		*) exit 2 ;;
		esac
	EOF
	chmod +x "$bin/npm"
}

# `npm pack`-shaped tarballs of a fake package, for --from-tarballs.
make_tarballs() {
	local version="$1"
	local out="$T/tgz-$version" d="$T/pkgs/$version"
	mkdir -p "$out" "$T/pack/a/package" "$T/pack/b/package"
	cp -R "$d/playground/." "$T/pack/a/package/"
	cp -R "$d/native/." "$T/pack/b/package/"
	tar -czf "$out/rotifer-playground-$version.tgz" -C "$T/pack/a" package
	tar -czf "$out/rotifer-playground-linux-x64-gnu-$version.tgz" -C "$T/pack/b" package
	rm -rf "$T/pack"
	echo "$out"
}

# A deploy directory like this one but pinning another version.
deploy_pinning() {
	local version="$1"
	local dir="$T/deploy-$1"
	mkdir -p "$dir"
	cp -R "$DEPLOY/." "$dir/"
	sed -i.bak "s/\"@rotifer\/playground\": \"$PIN\"/\"@rotifer\/playground\": \"$version\"/" "$dir/package.json"
	rm -f "$dir/package.json.bak"
	echo "$dir"
}

fill_env() {
	mkdir -p "$ROOT/etc/rotifer"
	sed -e 's/^ROTIFER_P2P_PUBLIC_IP=.*/ROTIFER_P2P_PUBLIC_IP=203.0.113.7/' \
		-e "s/^ROTIFER_QUOTA_BYTES=.*/ROTIFER_QUOTA_BYTES=${1:-1000}/" \
		"$DEPLOY/rotifer-p2p.env.example" >"$ROOT/etc/rotifer/p2p.env"
}

setup() {
	CASE="$1"
	echo "• $CASE"
	T="$(mktemp -d)"
	ROOT="$T/root"
	mkdir -p "$ROOT"
	export T DEPLOY_ROOT="$ROOT"
	export PATH="$T/bin:$ORIG_PATH"
	unset FAKE_DATE
	make_stubs
	make_node
	for v in "$PIN" 0.90.0 0.91.0; do make_package "$v"; done
	make_package 0.91.0 broken
	make_package 0.92.0 old
	make_package 0.93.0 noconsent
}
teardown() { rm -rf "$T"; }

OPT() { echo "$ROOT/opt/rotifer"; }
current() { basename "$(readlink "$(OPT)/current")"; }
field() { sed -n "s/^$2=//p" "$(OPT)/releases/$1/INSTALL"; }
calls() { grep -c -- "$1" "$T/calls.log" 2>/dev/null || true; }
# The line number of the first call matching an extended regex, or 0.
first_call() { grep -n -E -m1 -- "$1" "$T/calls.log" 2>/dev/null | cut -d: -f1 | grep . || echo 0; }
env_set() { sed -i.bak "s|^$1=.*|$1=$2|" "$ROOT/etc/rotifer/p2p.env" && rm -f "$ROOT/etc/rotifer/p2p.env.bak"; }
ORIG_PATH="$PATH"

# ------------------------------------------------------------------- cases

setup "install: first run puts p2p.env in place and stops until it is filled in"
expect_not "install fails with an empty PUBLIC_IP" bash "$DEPLOY/install.sh"
expect "p2p.env copied" test -f "$ROOT/etc/rotifer/p2p.env"
expect_not "nothing switched" test -e "$(OPT)/current"
teardown

setup "install: the pinned release, verified, units, firewall, node up"
fill_env
expect "install succeeds" bash "$DEPLOY/install.sh"
expect "current is the pin" test "$(current)" = "$PIN"
expect "INSTALL verified=yes" test "$(field "$PIN" verified)" = yes
expect "signatures were checked" test "$(calls 'npm audit signatures')" = 1
expect "units copied" test -f "$ROOT/etc/systemd/system/rotifer-p2p.service" -a -f "$ROOT/etc/systemd/system/rotifer-quota.timer"
expect "no test dir in the release" test ! -e "$(OPT)/releases/$PIN/deploy/test"
expect "firewall loaded with port and quota" grep -q 'tcp dport 9878' "$T/nft.rules"
expect "firewall restarted, node restarted" test "$(calls 'systemctl restart rotifer-firewall.service')" = 1 -a "$(calls 'systemctl restart rotifer-p2p.service')" = 1
expect "HISTORY records it" grep -q "from=none to=$PIN verified=yes" "$(OPT)/releases/HISTORY"
expect "status command linked" test -L "$ROOT/usr/local/bin/rotifer-node-status"
out="$(bash "$DEPLOY/rotifer-node-status" 2>&1)"
expect "status shows verified" grep -q 'Install:        verified' <<<"$out"
expect "status shows the node version" grep -q "Node:           version=$PIN" <<<"$out"
expect "status shows dropped sources" grep -q '2 source addresses' <<<"$out"
expect_not "status prints only named fields" grep -q 'must-not-print' <<<"$out"
expect "status shows the address to hand out" grep -q 'Address:        /ip4/203.0.113.7/tcp/9878/p2p/12D3KooWQYhTNQdmr3ArTeUHRYzFg94BKyTkoWBDWez9kSCVe2Xo' <<<"$out"
expect_not "a second install is refused" bash "$DEPLOY/install.sh"
teardown

setup "install: a failed signature check switches nothing"
fill_env
touch "$T/audit-fails"
expect_not "install fails" bash "$DEPLOY/install.sh"
expect_not "no current link" test -e "$(OPT)/current"
expect_not "no release dir" test -e "$(OPT)/releases/$PIN"
expect "node never started" test "$(calls 'rotifer-p2p.service')" = 0
teardown

setup "install: a release older than PR-② (no networkStats) is refused before the switch"
fill_env
d="$(deploy_pinning 0.92.0)"
echo old >"$T/variant-0.92.0"
expect_not "install fails" bash "$d/install.sh"
expect_not "no current link" test -e "$(OPT)/current"
teardown

setup "install: a pin that is not an exact version stops at once, with nothing prepared"
fill_env
d="$(deploy_pinning 0.93.0-rc.1)"
out="$(bash "$d/install.sh" 2>&1)"
rc=$?
expect "install fails" test "$rc" -ne 0
expect "it says why" grep -q "must pin an exact @rotifer/playground version, found '0.93.0-rc.1'" <<<"$out"
expect_not "and nothing after that runs" grep -q "native module" <<<"$out"
expect "no release directory is started" test ! -e "$(OPT)/releases/..tmp"
expect_not "no current link" test -e "$(OPT)/current"
teardown

setup "install: a Cloud login in the service home is refused"
fill_env
mkdir -p "$ROOT/var/lib/rotifer/.rotifer"
touch "$ROOT/var/lib/rotifer/.rotifer/credentials.json"
expect_not "install fails" bash "$DEPLOY/install.sh"
expect_not "no current link" test -e "$(OPT)/current"
teardown

setup "install: P2P consent is recorded for the service user before the node first starts"
fill_env
expect "install succeeds" bash "$DEPLOY/install.sh"
expect "consent --accept ran once, with the service home" test "$(calls "HOME=$ROOT/var/lib/rotifer .*network consent --accept")" = 1
expect "the record is in the service home" test -f "$ROOT/var/lib/rotifer/consent-accepted"
consent_at="$(first_call 'network consent --accept')"
start_at="$(first_call 'systemctl (re)?start rotifer-p2p\.service')"
expect "the node was started" test "$start_at" -gt 0
expect "consent comes before the node's first start" test "$consent_at" -gt 0 -a "$consent_at" -lt "$start_at"
teardown

setup "install: a release without 'network consent' (before B5) is refused before the switch"
fill_env
d="$(deploy_pinning 0.93.0)"
echo noconsent >"$T/variant-0.93.0"
expect_not "install fails" bash "$d/install.sh"
expect_not "no current link" test -e "$(OPT)/current"
expect "node never started" test "$(calls 'rotifer-p2p.service')" = 0
teardown

setup "install --from-tarballs: marked unverified everywhere, no signature check"
fill_env
tgz="$(make_tarballs "$PIN")"
expect "install succeeds" bash "$DEPLOY/install.sh" --from-tarballs "$tgz"
expect "INSTALL verified=no" test "$(field "$PIN" verified)" = no
expect "INSTALL says test only" grep -q 'test only, never in production' "$(OPT)/releases/$PIN/INSTALL"
expect "no signature check ran" test "$(calls 'npm audit')" = 0
expect "status shows UNVERIFIED" grep -q 'UNVERIFIED INSTALL' <<<"$(bash "$DEPLOY/rotifer-node-status" 2>&1)"
teardown

setup "upgrade: to a new pin, then a no-op on the same pin"
fill_env
bash "$DEPLOY/install.sh" >/dev/null 2>&1
d="$(deploy_pinning 0.90.0)"
expect "upgrade succeeds" bash "$d/upgrade.sh"
expect "current is 0.90.0" test "$(current)" = 0.90.0
expect "old release kept" test -f "$(OPT)/releases/$PIN/INSTALL"
expect "HISTORY" grep -q "from=$PIN to=0.90.0 verified=yes" "$(OPT)/releases/HISTORY"
expect "same pin is a no-op" bash "$d/upgrade.sh"
teardown

setup "upgrade: a node that does not come up goes back to the last verified release"
fill_env
bash "$DEPLOY/install.sh" >/dev/null 2>&1
d="$(deploy_pinning 0.91.0)"
echo broken >"$T/variant-0.91.0"
expect_not "upgrade fails" bash "$d/upgrade.sh"
expect "current is back on the pin" test "$(current)" = "$PIN"
expect "unit files are the pin's again" cmp -s "$ROOT/etc/systemd/system/rotifer-p2p.service" "$(OPT)/releases/$PIN/deploy/rotifer-p2p.service"
teardown

setup "upgrade: never falls back to an unverified install"
fill_env
bash "$DEPLOY/install.sh" --from-tarballs "$(make_tarballs "$PIN")" >/dev/null 2>&1
d="$(deploy_pinning 0.91.0)"
echo broken >"$T/variant-0.91.0"
expect_not "upgrade fails" bash "$d/upgrade.sh"
expect "stays on the new (failed) release, not the unverified one" test "$(current)" = 0.91.0
expect "node stopped" test "$(calls 'systemctl stop rotifer-p2p.service')" -ge 1
teardown

setup "rollback: picks the last verified release; an unverified one only with --allow-unverified"
fill_env
bash "$DEPLOY/install.sh" >/dev/null 2>&1
bash "$(deploy_pinning 0.90.0)/upgrade.sh" >/dev/null 2>&1
bash "$(deploy_pinning 0.91.0)/upgrade.sh" --from-tarballs "$(make_tarballs 0.91.0)" >/dev/null 2>&1
expect "on the unverified 0.91.0" test "$(current)" = 0.91.0 -a "$(field 0.91.0 verified)" = no
expect "rollback succeeds" bash "$(OPT)/current/deploy/rollback.sh"
expect "back on 0.90.0, the last verified" test "$(current)" = 0.90.0
expect_not "rollback to the unverified 0.91.0 is refused" bash "$(OPT)/current/deploy/rollback.sh" 0.91.0
expect "still on 0.90.0" test "$(current)" = 0.90.0
expect "with --allow-unverified it goes" bash "$(OPT)/current/deploy/rollback.sh" 0.91.0 --allow-unverified
expect "on 0.91.0" test "$(current)" = 0.91.0
expect "rollback to the pin" bash "$(OPT)/current/deploy/rollback.sh" "$PIN"
expect "unit files are the pin's" cmp -s "$ROOT/etc/systemd/system/rotifer-p2p.service" "$(OPT)/releases/$PIN/deploy/rotifer-p2p.service"
expect "Node link is the pin's" test "$(readlink "$(OPT)/node/current")" = "$(OPT)/node/$(field "$PIN" node)"
expect_not "an unknown release is refused" bash "$(OPT)/current/deploy/rollback.sh" 9.9.9
teardown

setup "quota: the use survives a rule reload and a reboot"
fill_env 1000
bash "$DEPLOY/install.sh" >/dev/null 2>&1
echo 300 >"$T/nft.extra"
expect "reload" bash "$DEPLOY/rotifer-quota" reload
expect "rules loaded with used 300" grep -q 'used 300 bytes' "$T/nft.rules"
rm -f "$T/nft.rules" # reboot: the kernel forgets the table
expect "load at boot" bash "$DEPLOY/rotifer-quota" load
expect "rules loaded with used 300 again" grep -q 'used 300 bytes' "$T/nft.rules"
teardown

setup "quota: used up stops the node and keeps it down; the reset day restarts it"
fill_env 1000
env_set ROTIFER_QUOTA_RESET_DAY 5
bash "$DEPLOY/install.sh" >/dev/null 2>&1
export FAKE_DATE="2026 11 20"
bash "$DEPLOY/rotifer-quota" tick 2>/dev/null
expect "period from the 5th" test "$(cat "$ROOT/var/lib/rotifer-quota/period")" = 2026-11-05
echo 600 >"$T/nft.extra"
out="$(bash "$DEPLOY/rotifer-quota" tick 2>&1)"
expect "warns at 50%" grep -q 'at 60%' <<<"$out"
out="$(bash "$DEPLOY/rotifer-quota" tick 2>&1)"
expect_not "warns once per level" grep -q '%' <<<"$out"
echo 1200 >"$T/nft.extra"
bash "$DEPLOY/rotifer-quota" tick 2>/dev/null
expect "capped" test -e "$ROOT/var/lib/rotifer-quota/capped"
expect "node stopped" test "$(calls 'systemctl stop rotifer-p2p.service')" -ge 1
expect_not "ExecCondition keeps it down" bash "$DEPLOY/rotifer-quota" not-capped
rm -f "$T/nft.rules"
bash "$DEPLOY/rotifer-quota" load 2>/dev/null
expect "after a reboot the rules start over the quota" grep -q 'used 1000 bytes' "$T/nft.rules"
export FAKE_DATE="2026 12 05"
bash "$DEPLOY/rotifer-quota" tick 2>/dev/null
expect "new period" test "$(cat "$ROOT/var/lib/rotifer-quota/period")" = 2026-12-05
expect "use back to 0" test "$(cat "$ROOT/var/lib/rotifer-quota/used")" = 0
expect "rules reloaded with used 0" grep -q 'used 0 bytes' "$T/nft.rules"
expect "not capped" bash "$DEPLOY/rotifer-quota" not-capped
expect "node started again" test "$(calls 'systemctl start rotifer-p2p.service')" = 1
teardown

setup "quota: period start before the reset day falls in the previous month, across a year"
fill_env
env_set ROTIFER_QUOTA_RESET_DAY 10
export FAKE_DATE="2027 01 03"
bash "$DEPLOY/rotifer-quota" load 2>/dev/null
expect "period from 2026-12-10" test "$(cat "$ROOT/var/lib/rotifer-quota/period")" = 2026-12-10
teardown

setup "quota: render fills every placeholder and nft -c passes; bad settings are refused"
fill_env 5000
out="$(bash "$DEPLOY/rotifer-quota" render)"
expect_not "no placeholder left" grep -q '@[A-Z_]*@' <<<"$out"
expect "quota bytes" grep -q 'over 5000 bytes used 0 bytes' <<<"$out"
expect "check" bash "$DEPLOY/rotifer-quota" check
env_set ROTIFER_QUOTA_BYTES abc
expect_not "a non-number quota is refused" bash "$DEPLOY/rotifer-quota" render
teardown

setup "start.sh: the node's command line from p2p.env"
fill_env
bash "$DEPLOY/install.sh" >/dev/null 2>&1
env_set ROTIFER_P2P_BOOTSTRAP '"/ip4/198.51.100.1/tcp/9878/p2p/12D3KooWA /ip4/198.51.100.2/tcp/9878/p2p/12D3KooWB"'
run_start() { (set -a && . "$ROOT/etc/rotifer/p2p.env" && set +a && bash "$(OPT)/current/deploy/start.sh"); }
out="$(run_start)"
expect "foreground on 0.0.0.0, no mDNS" grep -q 'network start --foreground --host 0.0.0.0 --port 9878 --no-mdns --max-inbound 500 --max-pending 128' <<<"$out"
expect "relay announces the public IPv4" grep -q -- '--relay-server --announce /ip4/203.0.113.7/tcp/9878' <<<"$out"
expect "both bootstrap addresses" grep -q -- '--bootstrap /ip4/198.51.100.1/tcp/9878/p2p/12D3KooWA /ip4/198.51.100.2/tcp/9878/p2p/12D3KooWB' <<<"$out"
env_set ROTIFER_P2P_RELAY_SERVER no
env_set ROTIFER_P2P_BOOTSTRAP ''
out="$(run_start)"
expect_not "no relay flags" grep -q -- '--relay-server' <<<"$out"
expect_not "no bootstrap flag" grep -q -- '--bootstrap' <<<"$out"
teardown

echo
echo "$PASS passed, $FAIL failed"
for f in "${FAILED[@]+"${FAILED[@]}"}"; do echo "  ✖ $f"; done
((FAIL == 0))
