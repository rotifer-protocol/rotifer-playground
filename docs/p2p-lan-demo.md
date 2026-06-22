# P2P LAN demo — gossip a gene across three machines

This guide runs the Rotifer P2P node on **multiple real machines on the same
local network** and watches a gene announced on one machine appear on the
others. It is the first runnable milestone of the P2P stack: cross-machine
discovery (manual bootstrap) + announcement propagation.

You need at least two machines; three makes the gossip fan-out obvious. The
walkthrough assumes macOS, but the only OS-specific note is the firewall prompt.

There are two ways to run this:

- **Path A — published npm package (recommended).** What a normal
  `npm install -g` user gets; no Rust toolchain or source checkout.
- **Path B — from-source build.** Only if you're rebuilding the native addon.

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
- **Node.js >= 20** on each machine.

Path B additionally needs a **Rust** toolchain (`cargo`) and a clone of this
repository on each machine (same branch/commit).

## Path A — published npm package (v0.9.0+)

The path a normal user follows: install the CLI from npm — no Rust toolchain,
no source checkout. Do this on **each** machine.

### A1. Install the CLI (every machine)

```bash
npm install -g @rotifer/playground@latest   # v0.9.0 or newer
rotifer --version                            # should print 0.9.0+
```

If `rotifer` is "command not found" right after install, npm's global bin
directory isn't on your PATH — run `export PATH="$(npm prefix -g)/bin:$PATH"`
for that shell, then retry.

### A2. Start the seed (machine A)

Bind all interfaces so the others can reach it, then read its reachable address:

```bash
rotifer network start --host 0.0.0.0 --port 9878
rotifer network status
```

`status` lists every interface it bound. Copy the **LAN** line — the
`192.168.x.x` / `10.x.x.x` one, not `127.0.0.1`:

```
Listening: /ip4/127.0.0.1/tcp/9878
Listening: /ip4/192.168.0.103/tcp/9878   ← give this to the others
```

On the first `--host 0.0.0.0` start, macOS asks *"Do you want the application
'node' to accept incoming network connections?"* — click **Allow**.

### A3. Join from the others (machine B, C, …)

Paste A's LAN address into `--bootstrap` (a plain `/ip4/.../tcp/9878` — no
PeerId needed), then confirm the link:

```bash
rotifer network start --host 0.0.0.0 --port 9878 --bootstrap /ip4/192.168.0.103/tcp/9878
rotifer network peers     # lists A's PeerId within a second or two
```

### A4. Announce on A, receive on B

`announce` needs a directory holding `genes/<name>/phenotype.json`. `rotifer
init` scaffolds one (the example gene `hello-world`):

```bash
# on machine A
rotifer init demo-net && cd demo-net
rotifer network announce hello-world
```

```bash
# on machine B
rotifer network received
```

The received gene is tagged with A's PeerId as the source — and that PeerId
matches what A printed at start, which is the proof it crossed the network:

```
Received Gene Announcements
  hello-world@0.1.0: general · Wrapped · from 12D3KooW…
```

Stop any node with `rotifer network stop`.

## Path B — from-source build

You only need this if you're changing the Rust addon. The steps below (§1–§4)
build the addon locally so it shadows the published package.

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
- **`network start` says "unavailable".** The native addon isn't loading. On
  Path A, reinstall `@rotifer/playground` (your platform may lack a prebuilt
  addon). On Path B, re-run the §1 build steps, including the `cp` and `rm -rf`
  lines.
- **`rotifer: command not found` after `npm install -g` (Path A).** npm's global
  bin isn't on your PATH — run `export PATH="$(npm prefix -g)/bin:$PATH"` for
  that shell, then retry.
- **Stop a node.** `rotifer network stop` (Path A) or
  `node dist/index.js network stop` (Path B).

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

- **Path A vs Path B.** Since **v0.9.0** the published platform packages bundle
  the P2P addon, so `npm install -g` users get `--host` / `network received` out
  of the box (Path A). Path B (from-source) is only for developing the addon
  itself, where a fresh local build must shadow the published package.
- LAN reachability here relies on manual `--bootstrap`. Automatic discovery
  (mDNS) and reaching nodes across the public internet (NAT traversal, relays)
  are later milestones — see the productionization roadmap.
