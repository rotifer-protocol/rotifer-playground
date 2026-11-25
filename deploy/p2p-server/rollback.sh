#!/usr/bin/env bash
# Put a Rotifer public P2P node back on an earlier release, with that
# release's own units, firewall rules and Node.js (T-231 B2 design §5.5;
# RUNBOOK.md "Roll back").
#
#   sudo /opt/rotifer/current/deploy/rollback.sh
#       the most recent verified release before the current one
#   sudo /opt/rotifer/current/deploy/rollback.sh 0.41.0
#       that release
#   sudo /opt/rotifer/current/deploy/rollback.sh 0.41.0 --allow-unverified
#       that release even if it was a test install
#
# Nothing is downloaded: the target must still be in /opt/rotifer/releases.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

target=""
allow_unverified=no
while (($#)); do
	case "$1" in
	--allow-unverified) allow_unverified=yes ;;
	-*) die "usage: sudo rollback.sh [<version>] [--allow-unverified]" ;;
	*) target="$1" ;;
	esac
	shift
done

require_root
[[ -L "$CURRENT" ]] || die "nothing is installed yet; use install.sh"
from="$(current_release)"
if [[ -z "$target" ]]; then
	target="$(last_verified_release "$from")"
	[[ -n "$target" ]] || die "no verified release to go back to (releases: $(cd "$RELEASES" && ls -d -- */ 2>/dev/null | tr -d / | tr '\n' ' '))"
fi
[[ -f "$RELEASES/$target/INSTALL" ]] || die "release $target is not in $RELEASES"
if [[ "$target" == "$from" ]]; then
	log "Already on $target; nothing to do."
	exit 0
fi
if [[ "$(install_field "$target" verified)" != yes && "$allow_unverified" != yes ]]; then
	die "release $target is an UNVERIFIED test install; a rollback never picks one unless you pass --allow-unverified"
fi
load_env
check_firewall "$RELEASES/$target/deploy"
"$CURRENT/deploy/rotifer-quota" save

log "Rolling back $from -> $target"
activate "$target" || die "the node did not come up on $target; see journalctl -u rotifer-p2p -n 100"
log "Rolled back to $target."
"$CURRENT/deploy/rotifer-node-status"
