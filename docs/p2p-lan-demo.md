# P2P LAN demo — gossip a gene across three machines

This guide runs the Rotifer P2P node on **multiple real machines on the same
local network** and watches a gene announced on one machine appear on the
others. It is the first runnable milestone of the P2P stack: cross-machine
discovery (manual bootstrap) + announcement propagation.

You need at least two machines; three makes the gossip fan-out obvious. The
walkthrough assumes macOS, but the only OS-specific note is the firewall prompt.

## What you'll see

```
Mac A  ──announce──▶  GossipSub  ──▶  Mac B  ·  Mac C
 (seed)                                (network received shows the gene)
```

- **Mac A** binds all interfaces and acts as the bootstrap "seed".
- **Mac B** and **Mac C** dial A to join the swarm.
- Announcing a gene on A propagates it to B and C, where `network received`
  lists it.

## Prerequisites

- All machines on the **same Wi-Fi / LAN**.
- A working **Rust** toolchain (`cargo`) and **Node.js >= 20** on each machine.
- A clone of this repository on each machine, on the same branch/commit.

## 1. Build on each machine

The P2P features live in a locally-compiled native addon. The platform package
published to npm is **not** what you want here — you want the fresh build from
this checkout. So after building, you stage the local addon and remove the
published one so it cannot shadow your build:

```bash
cd rotifer-playground
npm ci
npm run build          # TypeScript -> dist/
npm run build:napi     # Rust libp2p addon -> crates/rotifer-napi/index.node

# stage the freshly-built addon where the loader looks for it
cp crates/rotifer-napi/index.node "index.$(node -p process.platform)-$(node -p process.arch).node"

# remove the published platform package so it can't shadow the local build
rm -rf node_modules/@rotifer/playground-darwin-*
```

> **Why the last two lines?** The addon loader tries the published platform
> package (`@rotifer/playground-<platform>`) *before* the local
> `index.<platform>.node`. The published package lags this checkout, so without
> removing it you would run the old addon — without `--host` or `network
> received`. Deleting it lets the fresh local build win.

Sanity check (should print `not running`, **not** an "unknown command" error):

```bash
node dist/index.js network received
```

## 2. Start the seed (Mac A)

Bind all interfaces so other machines can reach this node:

```bash
node dist/index.js network start --host 0.0.0.0 --port 9878
node dist/index.js network status
```

`status` prints a reachable multiaddr — the one with the machine's LAN IP, e.g.:

```
Listening   /ip4/192.168.0.103/tcp/9878/p2p/12D3KooW…A
```

Copy that **full** multiaddr (the `192.168.x.x` one, not `127.0.0.1`). It is
what B and C bootstrap from.

## 3. Join from the others (Mac B and Mac C)

On each joiner, paste A's multiaddr into `--bootstrap`:

```bash
node dist/index.js network start --host 0.0.0.0 --port 9878 \
  --bootstrap /ip4/192.168.0.103/tcp/9878/p2p/12D3KooW…A
node dist/index.js network peers     # should list A within a second or two
```

## 4. Announce on A, receive on B and C

On **Mac A**, in a directory that contains `genes/<name>/phenotype.json`,
announce the gene:

```bash
node dist/index.js network announce <gene-name>
```

On **Mac B** and **Mac C**:

```bash
node dist/index.js network received
```

You should see the announcement, tagged with A's PeerId as the source:

```
Received Gene Announcements
  my-gene@1.2.3: my.domain · Native · from 12D3KooW…A
```

## Troubleshooting

- **`peers` stays empty / nothing received.** Confirm all machines are on the
  same LAN and that you used A's `192.168.x.x` multiaddr (not `127.0.0.1`). On
  first `--host 0.0.0.0` start, macOS may pop *"Do you want the application
  'node' to accept incoming network connections?"* — click **Allow** (or allow
  `node` in System Settings → Network → Firewall).
- **`network start` says "unavailable".** The native addon isn't loading. Re-run
  the build steps in §1, including the `cp` and `rm -rf` lines.
- **Stop a node.** `node dist/index.js network stop`.

## Single-machine variant

You can rehearse the whole flow on one machine with two daemons by giving each
its own `HOME` (so their daemon state files don't collide) and different ports:

```bash
HOME=/tmp/node-a node dist/index.js network start --port 9901
# read /tmp/node-a/.rotifer/daemon.json for A's PeerId, build its bootstrap addr
HOME=/tmp/node-b node dist/index.js network start --port 9902 \
  --bootstrap /ip4/127.0.0.1/tcp/9901/p2p/<A-PeerId>
HOME=/tmp/node-a node dist/index.js network announce <gene-name>   # from a dir with genes/<name>/
HOME=/tmp/node-b node dist/index.js network received
```

## Notes

- This is a **from-source developer build**, not an `npm install -g` release.
  Public-release users will get `--host` / `network received` only after a
  versioned release republishes the platform packages.
- LAN reachability here relies on manual `--bootstrap`. Automatic discovery
  (mDNS) and reaching nodes across the public internet (NAT traversal, relays)
  are later milestones — see the productionization roadmap.
