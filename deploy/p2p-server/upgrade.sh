#!/usr/bin/env bash
# Upgrade a Rotifer public P2P node to the release this checkout pins
# (T-231 B2 design §5.5; RUNBOOK.md "Upgrade").
#
#   sudo ./upgrade.sh                       from the npm registry, signatures checked
#   sudo ./upgrade.sh --from-tarballs DIR   TEST ONLY, as in install.sh
#
# Run from a checkout of rotifer-playground at the main commit that pins the
# NEW release here (not its tag; RUNBOOK.md Upgrade), so the checks, units and
# firewall rules are the new release's. Everything is
# checked before the switch; if the node does not report the new version
# within 60 s, the node goes back to the most recent verified release.
# An unverified (test) install is never gone back to.

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
	*) die "usage: sudo ./upgrade.sh [--from-tarballs DIR]" ;;
	esac
done

require_root
[[ -L "$CURRENT" ]] || die "nothing is installed yet; use install.sh"
old="$(current_release)"
load_env
[[ -n "$tarballs" ]] && log "!!! --from-tarballs: TEST INSTALL, marked unverified. Never use this in production."

new="$(prepare_release "$HERE" "$tarballs")"
if [[ "$new" == "$old" ]]; then
	log "Already on $new; nothing to do."
	exit 0
fi
check_firewall "$RELEASES/$new/deploy"
"$CURRENT/deploy/rotifer-quota" save

log "Switching $old -> $new"
if activate "$new"; then
	log "Upgraded to $new."
	"$CURRENT/deploy/rotifer-node-status"
	exit 0
fi

fallback="$(last_verified_release "$new")"
if [[ -z "$fallback" ]]; then
	systemctl stop rotifer-p2p.service || true
	die "$new did not come up and there is no verified release to go back to: the node is stopped. See journalctl -u rotifer-p2p -n 100"
fi
log "$new did not come up; going back to $fallback"
"$CURRENT/deploy/rotifer-quota" save
activate "$fallback" || die "going back to $fallback did not bring the node up either; see journalctl -u rotifer-p2p -n 100"
die "upgrade to $new failed; the node runs $fallback again. See journalctl -u rotifer-p2p -n 100"
