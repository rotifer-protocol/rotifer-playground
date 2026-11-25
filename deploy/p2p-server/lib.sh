# shellcheck shell=bash
# Shared by install.sh, upgrade.sh, rollback.sh, rotifer-quota and
# rotifer-node-status (T-231 B2 design §5.5). Sourced, not run.
#
# DEPLOY_ROOT prefixes every path, for the script tests in test/ only; it is
# empty on a real host (systemd units and sudo start with a clean
# environment).

set -euo pipefail
umask 022

ROOT="${DEPLOY_ROOT:-}"
OPT="$ROOT/opt/rotifer"
RELEASES="$OPT/releases"
CURRENT="$OPT/current"
NODE_DIR="$OPT/node"
HISTORY="$RELEASES/HISTORY"
ETC="$ROOT/etc/rotifer"
ENV_FILE="$ETC/p2p.env"
STATE="$ROOT/var/lib/rotifer"
QUOTA_STATE="$ROOT/var/lib/rotifer-quota"
UNIT_DIR="$ROOT/etc/systemd/system"
BIN_LINK="$ROOT/usr/local/bin/rotifer-node-status"
SERVICE_USER=rotifer
PACKAGE=@rotifer/playground
NATIVE_PACKAGE=@rotifer/playground-linux-x64-gnu
UNITS=(rotifer-p2p.service rotifer-firewall.service rotifer-quota.service rotifer-quota.timer)

# Every rotifer command these scripts run: no update check, no telemetry,
# and a throwaway HOME so a check never writes into root's home.
export ROTIFER_NO_UPDATE_CHECK=1 DO_NOT_TRACK=1

log() { printf '%s\n' "$*" >&2; }
die() {
	printf '✖ %s\n' "$*" >&2
	exit 1
}

require_root() {
	[[ -n "${DEPLOY_ROOT:-}" || "$(id -u)" -eq 0 ]] || die "run this as root (sudo)"
}

# The @rotifer/playground version a deploy directory pins (package.json).
pinned_version() {
	local dir="$1" v
	v="$(sed -n 's/^[[:space:]]*"@rotifer\/playground":[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/package.json")"
	[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$dir/package.json must pin an exact $PACKAGE version, found '${v:-nothing}'"
	printf '%s\n' "$v"
}

# The Node version and the SHA-256 of its official linux-x64 tarball.
node_version() { sed -n 1p "$1/node-version"; }
node_sha256() { sed -n 2p "$1/node-version"; }

# The release the current link points at, or nothing.
current_release() {
	[[ -L "$CURRENT" ]] || return 0
	basename "$(readlink "$CURRENT")"
}

# A key of a release's INSTALL record (verified, node, installed_at, ...).
install_field() {
	local release="$1" key="$2"
	sed -n "s/^$key=//p" "$RELEASES/$release/INSTALL" 2>/dev/null | head -n 1
}

# Point a link at a target atomically (rename over the old link).
swap_link() {
	local target="$1" link="$2"
	ln -sfn "$target" "$link.new"
	mv -T "$link.new" "$link"
}

# Download, check and unpack the pinned Node, unless that version is already
# in place. Nothing is unpacked before its SHA-256 matches.
ensure_node() {
	local deploy="$1" version sha tmp
	version="$(node_version "$deploy")"
	sha="$(node_sha256 "$deploy")"
	[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$sha" =~ ^[0-9a-f]{64}$ ]] || die "$deploy/node-version must hold a Node version and a SHA-256"
	if [[ -x "$NODE_DIR/$version/bin/node" ]]; then
		return 0
	fi
	tmp="$(mktemp -d)"
	local tarball="node-v$version-linux-x64.tar.xz"
	log "Downloading Node $version"
	curl -fsSL --proto '=https' --tlsv1.2 -o "$tmp/$tarball" "https://nodejs.org/dist/v$version/$tarball" ||
		die "could not download Node $version"
	echo "$sha  $tmp/$tarball" | sha256sum -c --quiet - || die "Node $version tarball does not match the pinned SHA-256; nothing installed"
	mkdir -p "$NODE_DIR/$version.tmp"
	tar -xJf "$tmp/$tarball" -C "$NODE_DIR/$version.tmp" --strip-components=1
	mv -T "$NODE_DIR/$version.tmp" "$NODE_DIR/$version"
	rm -rf "$tmp"
}

# Build /opt/rotifer/releases/<version> from a deploy directory and run every
# check before anything switches (design §5.5): the pinned Node, `npm ci`
# against the lock file's integrity hashes without install scripts, registry
# signatures and provenance, a real load of the native module, and
# `rotifer --version`. Any failure exits before the release is usable.
#
# With a tarball directory (test installs only, RUNBOOK), the packages come
# from local `npm pack` files: there is nothing to check signatures against,
# so the release is recorded as unverified.
# Prints only the version on stdout (callers capture it); all else to stderr.
prepare_release() {
	# Callers run this as `version="$(prepare_release …)"`, and a command
	# substitution does not inherit errexit (bash < 4.4, or no inherit_errexit):
	# without this, a `die` in a nested `$(...)` below would only end that
	# subshell, and the release would be built with an empty version.
	set -e
	local deploy="$1" tarballs="${2:-}" version node_version_ release work node npm verified
	version="$(pinned_version "$deploy")"
	node_version_="$(node_version "$deploy")"
	release="$RELEASES/$version"
	if [[ -f "$release/INSTALL" ]]; then
		log "Release $version is already prepared"
		printf '%s\n' "$version"
		return 0
	fi
	ensure_node "$deploy"
	node="$NODE_DIR/$node_version_/bin/node"
	npm="$NODE_DIR/$node_version_/bin/npm"
	work="$RELEASES/.$version.tmp"
	rm -rf "$work"
	mkdir -p "$work"
	export PATH="$NODE_DIR/$node_version_/bin:$PATH"
	if [[ -z "$tarballs" ]]; then
		cp "$deploy/package.json" "$deploy/package-lock.json" "$work/"
		log "Installing $PACKAGE $version from the lock file"
		(cd "$work" && "$npm" ci --omit=dev --ignore-scripts --no-audit --no-fund >&2) || die "npm ci failed; nothing switched"
		log "Checking registry signatures and provenance"
		(cd "$work" && "$npm" audit signatures >&2) || die "npm audit signatures failed; nothing switched"
		verified=yes
	else
		local main native
		main="$(find_tarball "$tarballs" rotifer-playground "$version")"
		native="$(find_tarball "$tarballs" rotifer-playground-linux-x64-gnu "$version")"
		log "TEST INSTALL from $tarballs: registry signatures are NOT checked"
		cat >"$work/package.json" <<-EOF
			{ "name": "rotifer-p2p-server", "private": true,
			  "dependencies": { "$PACKAGE": "file:$main", "$NATIVE_PACKAGE": "file:$native" } }
		EOF
		(cd "$work" && "$npm" install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock >&2) ||
			die "npm install from $tarballs failed; nothing switched"
		verified=no
	fi
	local native_rc=0
	check_native "$node" "$work" || native_rc=$?
	case "$native_rc" in
	0) ;;
	3) die "$PACKAGE $version predates public nodes (its native module has no networkStats, added with T-231 PR-②); pin a later release. Nothing switched" ;;
	*) die "the native module $NATIVE_PACKAGE does not load (exit $native_rc); nothing switched" ;;
	esac
	local reported scratch_home
	scratch_home="$(mktemp -d)"
	reported="$(HOME="$scratch_home" "$node" "$work/node_modules/.bin/rotifer" --version 2>/dev/null | tail -n 1 | tr -d '[:space:]')"
	[[ "$reported" == "$version" ]] || die "rotifer --version says '$reported', the deploy directory pins $version; nothing switched"
	HOME="$scratch_home" "$node" "$work/node_modules/.bin/rotifer" network start --help 2>/dev/null | grep -q -- '--foreground' ||
		die "$PACKAGE $version has no 'network start --foreground': it predates public nodes; nothing switched"
	# install.sh records P2P consent with it before the first start (T-237 B5,
	# design Q4); a release without it cannot, so it is refused here.
	HOME="$scratch_home" "$node" "$work/node_modules/.bin/rotifer" network consent --help 2>/dev/null | grep -qE -- '^ +--accept +' ||
		die "$PACKAGE $version has no 'network consent --accept' (first-run P2P consent, T-237 B5); pin a later release; nothing switched"
	rm -rf "$scratch_home"
	mkdir -p "$work/deploy"
	cp -a "$deploy/." "$work/deploy/"
	rm -rf "$work/deploy/test"
	{
		echo "version=$version"
		echo "verified=$verified"
		echo "node=$node_version_"
		echo "installed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
		[[ "$verified" == yes ]] || echo "note=unverified install from local tarballs: test only, never in production"
	} >"$work/INSTALL"
	[[ -n "${DEPLOY_ROOT:-}" ]] || chown -R root:root "$work"
	chmod -R go-w "$work"
	mv -T "$work" "$release"
	printf '%s\n' "$version"
}

find_tarball() {
	local dir="$1" name="$2" version="$3" f
	f="$dir/$name-$version.tgz"
	[[ -f "$f" ]] || f="$dir/rotifer-$name-$version.tgz"
	[[ -f "$f" ]] || die "no $name-$version.tgz in $dir"
	realpath "$f"
}

# Loads the native module the way the daemon does, and checks it has the
# node-statistics the public node relies on.
check_native() {
	local node="$1" dir="$2"
	(cd "$dir" && "$node" -e '
		const m = require("@rotifer/playground-linux-x64-gnu");
		const C = m.P2PNode ?? m.P2pNode;
		if (typeof C !== "function") process.exit(2);
		if (typeof C.prototype.networkStats !== "function") process.exit(3);
	')
}

# Copy a release's units into systemd and the status command into place.
install_units() {
	local release="$1" unit
	mkdir -p "$UNIT_DIR"
	for unit in "${UNITS[@]}"; do
		install -m 0644 "$RELEASES/$release/deploy/$unit" "$UNIT_DIR/$unit"
	done
	mkdir -p "$(dirname "$BIN_LINK")"
	swap_link "$CURRENT/deploy/rotifer-node-status" "$BIN_LINK"
}

# Point current (and the Node link) at a release and note it in HISTORY.
switch_to() {
	local release="$1" from
	from="$(current_release)"
	swap_link "$NODE_DIR/$(install_field "$release" node)" "$NODE_DIR/current"
	swap_link "$RELEASES/$release" "$CURRENT"
	printf '%s from=%s to=%s verified=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${from:-none}" "$release" \
		"$(install_field "$release" verified)" >>"$HISTORY"
}

# Wait up to 60 s for the running node to report the expected version.
wait_for_version() {
	local want="$1" got="" i
	for i in $(seq 1 30); do
		got="$("$CURRENT/deploy/rotifer-node-status" --version-only 2>/dev/null || true)"
		[[ "$got" == "$want" ]] && return 0
		sleep 2
	done
	log "the node reports '${got:-nothing}' after 60 s, expected $want"
	return 1
}

# The most recent release in HISTORY, other than the one given, whose
# INSTALL says verified=yes: the only kind upgrade.sh falls back to and
# rollback.sh picks by itself. An unverified (test) install is never a
# rollback floor.
last_verified_release() {
	local except="$1" line to
	[[ -f "$HISTORY" ]] || return 0
	while IFS= read -r line; do
		to="$(sed -n 's/.* to=\([^ ]*\).*/\1/p' <<<"$line")"
		[[ -n "$to" && "$to" != "$except" && -f "$RELEASES/$to/INSTALL" ]] || continue
		if [[ "$(install_field "$to" verified)" == yes ]]; then
			printf '%s\n' "$to"
			return 0
		fi
	done < <(tac "$HISTORY")
}

# Make a prepared release the running one: current link, Node link, units,
# firewall (with the saved quota use), then the node, unless the month's
# quota has stopped it. Fails if the node does not report the version.
activate() {
	local release="$1"
	switch_to "$release"
	install_units "$release"
	systemctl daemon-reload
	systemctl enable rotifer-firewall.service rotifer-p2p.service rotifer-quota.timer >/dev/null
	systemctl restart rotifer-firewall.service
	systemctl start rotifer-quota.timer
	if [[ -e "$QUOTA_STATE/capped" ]]; then
		log "The outbound quota for this period is used up: the node stays stopped until the period resets (RUNBOOK, quota)."
		return 0
	fi
	systemctl restart rotifer-p2p.service
	wait_for_version "$release"
}

# Check a deploy directory's firewall rules with `nft -c` before switching.
check_firewall() {
	local deploy="$1"
	"$deploy/rotifer-quota" check || die "the firewall rules in $deploy do not pass 'nft -c'; nothing switched"
}

# Read the operator's settings and refuse values the node would reject.
load_env() {
	[[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing"
	set -a
	# shellcheck disable=SC1090
	. "$ENV_FILE"
	set +a
	[[ "${ROTIFER_P2P_PORT:-}" =~ ^[0-9]+$ ]] && ((ROTIFER_P2P_PORT >= 1 && ROTIFER_P2P_PORT <= 65535)) ||
		die "ROTIFER_P2P_PORT in $ENV_FILE must be a port number"
	[[ "${ROTIFER_P2P_RELAY_SERVER:-}" =~ ^(yes|no)$ ]] || die "ROTIFER_P2P_RELAY_SERVER in $ENV_FILE must be yes or no"
	if [[ "$ROTIFER_P2P_RELAY_SERVER" == yes && -z "${ROTIFER_P2P_PUBLIC_IP:-}" ]]; then
		die "fill in ROTIFER_P2P_PUBLIC_IP in $ENV_FILE (a relay must announce its public IPv4), then run this again"
	fi
	[[ -z "${ROTIFER_P2P_PUBLIC_IP:-}" || "$ROTIFER_P2P_PUBLIC_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] ||
		die "ROTIFER_P2P_PUBLIC_IP in $ENV_FILE must be an IPv4 address"
	local n
	for n in ROTIFER_P2P_MAX_INBOUND ROTIFER_P2P_MAX_PENDING ROTIFER_QUOTA_BYTES; do
		[[ "${!n:-}" =~ ^[1-9][0-9]*$ ]] || die "$n in $ENV_FILE must be a positive whole number"
	done
	[[ "${ROTIFER_QUOTA_RESET_DAY:-}" =~ ^[0-9]+$ ]] && ((ROTIFER_QUOTA_RESET_DAY >= 1 && ROTIFER_QUOTA_RESET_DAY <= 28)) ||
		die "ROTIFER_QUOTA_RESET_DAY in $ENV_FILE must be a day from 1 to 28"
}

# Run the current release's rotifer CLI as the service user.
rotifer_as_service() {
	runuser -u "$SERVICE_USER" -- env -i HOME="$STATE" PATH="$NODE_DIR/current/bin:/usr/bin:/bin" \
		ROTIFER_NO_UPDATE_CHECK=1 DO_NOT_TRACK=1 NO_COLOR=1 \
		"$NODE_DIR/current/bin/node" "$CURRENT/node_modules/.bin/rotifer" "$@"
}
