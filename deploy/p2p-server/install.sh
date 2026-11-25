#!/usr/bin/env bash
# First install of a Rotifer public P2P node on a fresh Linux x86-64 host
# with systemd and nftables (T-231 B2 design §5.4; RUNBOOK.md "Install").
#
#   sudo ./install.sh                       the release package.json pins,
#                                           from the npm registry, signatures checked
#   sudo ./install.sh --from-tarballs DIR   TEST ONLY: from local `npm pack` files;
#                                           no signature check, marked unverified
#
# Run from a checkout of rotifer-playground at the release tag. The first run
# puts /etc/rotifer/p2p.env in place and stops if it still needs filling in.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

tarballs=""
while (($#)); do
	case "$1" in
	--from-tarballs)
		[[ -d "${2:-}" ]] || die "--from-tarballs needs a directory of .tgz files"
		tarballs="$(cd "$2" && pwd)"
		shift 2
		;;
	*) die "usage: sudo ./install.sh [--from-tarballs DIR]" ;;
	esac
done

require_root
for cmd in nft systemctl curl sha256sum tar runuser; do
	command -v "$cmd" >/dev/null || die "this host has no '$cmd'"
done
[[ -L "$CURRENT" ]] && die "a release is already installed ($(current_release)); use upgrade.sh or rollback.sh"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
	log "Creating the $SERVICE_USER system user"
	useradd --system --home-dir "$STATE" --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# The node holds no Cloud session (design §5.6): refuse a home with one.
[[ -e "$STATE/.rotifer/credentials.json" ]] &&
	die "$STATE/.rotifer/credentials.json exists: a public node must hold no Cloud login; remove it first"

mkdir -p "$ETC"
if [[ ! -f "$ENV_FILE" ]]; then
	install -m 0644 "$HERE/rotifer-p2p.env.example" "$ENV_FILE"
	log "Put the settings file in place: $ENV_FILE"
fi
load_env

[[ -n "$tarballs" ]] && log "!!! --from-tarballs: TEST INSTALL. Registry signatures are not checked and the release is marked unverified. Never use this in production."

version="$(prepare_release "$HERE" "$tarballs")"
check_firewall "$RELEASES/$version/deploy"
mkdir -p "$STATE"
[[ -n "${DEPLOY_ROOT:-}" ]] || chown "$SERVICE_USER:$SERVICE_USER" "$STATE"
chmod 0700 "$STATE"

switch_to "$version"
install_units "$version"
systemctl daemon-reload

# First-run P2P consent (T-237 B5, design Q4), before the node first starts:
# the service has no terminal to ask on, and without a record the node
# refuses to start. The command prints the text being agreed to; installing
# a public node from this RUNBOOK is the operator agreeing to it.
log "Recording P2P consent for the service user (rotifer network consent --accept)"
rotifer_as_service network consent --accept || die "recording P2P consent failed; the node was not started"

activate "$version" || die "the node did not come up on $version; see: journalctl -u rotifer-p2p -n 100"
log "Installed $version."
"$CURRENT/deploy/rotifer-node-status"
