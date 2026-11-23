#!/usr/bin/env bash
# What rotifer-p2p.service runs (as the rotifer user): the node in the
# foreground, with the settings from /etc/rotifer/p2p.env, which systemd has
# already put in the environment (T-231 B2 design §5.3).
#
# --no-mdns: a server on a provider's network announces nothing on it.
# The firewall only lets IPv4 reach the P2P port, so the node listens on
# 0.0.0.0 and announces only its public IPv4.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

[[ "${ROTIFER_P2P_PORT:-}" =~ ^[0-9]+$ ]] || die "ROTIFER_P2P_PORT is not set (is $ENV_FILE in place?)"

args=(network start --foreground --host 0.0.0.0 --port "$ROTIFER_P2P_PORT" --no-mdns
	--max-inbound "${ROTIFER_P2P_MAX_INBOUND:?}" --max-pending "${ROTIFER_P2P_MAX_PENDING:?}")

if [[ "${ROTIFER_P2P_RELAY_SERVER:-no}" == yes ]]; then
	[[ -n "${ROTIFER_P2P_PUBLIC_IP:-}" ]] || die "ROTIFER_P2P_RELAY_SERVER=yes needs ROTIFER_P2P_PUBLIC_IP"
	args+=(--relay-server --announce "/ip4/$ROTIFER_P2P_PUBLIC_IP/tcp/$ROTIFER_P2P_PORT")
fi

read -r -a bootstrap <<<"${ROTIFER_P2P_BOOTSTRAP:-}"
if ((${#bootstrap[@]} > 0)); then
	args+=(--bootstrap "${bootstrap[@]}")
fi

exec "$NODE_DIR/current/bin/node" "$CURRENT/node_modules/.bin/rotifer" "${args[@]}"
