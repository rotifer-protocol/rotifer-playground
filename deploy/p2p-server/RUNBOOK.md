# Rotifer public P2P node: runbook

How to run a public bootstrap and relay node for the Rotifer P2P network on
one Linux machine: install, look at it, upgrade, roll back, what happens when
the traffic quota is used up, what to do when the node key leaks, and how to
retire the machine.

The node is the `rotifer network start --foreground` daemon from
`@rotifer/playground`, pinned to one exact version by `package.json` and
`package-lock.json` in this directory, run by systemd as the unprivileged
`rotifer` user behind an nftables firewall with a monthly outbound quota.

> Nothing in this directory is a secret, and nothing secret is ever written
> into it: the node key is generated on the machine at first start, and the
> node holds no Rotifer Cloud login.

## Contents

1. [What you need](#what-you-need)
2. [Where things are](#where-things-are)
3. [Install](#install)
4. [Back up the node key](#back-up-the-node-key)
5. [Look at the node](#look-at-the-node)
6. [Upgrade](#upgrade)
7. [Roll back](#roll-back)
8. [The outbound quota](#the-outbound-quota)
9. [The node key leaked](#the-node-key-leaked)
10. [Retire the machine](#retire-the-machine)
11. [Test installs from local tarballs](#test-installs-from-local-tarballs)
12. [Pre-launch checks](#pre-launch-checks)

## What you need

- A dedicated **x86-64 Linux** machine with glibc. There is no arm64 Linux
  build of the native module, so ARM machines cannot run the node.
- **Ubuntu 24.04 LTS** (systemd 255). The restart back-off in
  `rotifer-p2p.service` needs systemd 254 or later; the quota's
  `ExecCondition` needs 243 or later.
- `nftables`, `curl`, `git`, `tar`, `xz-utils` (all in Ubuntu's base image
  or one `apt install` away).
- A public IPv4 address that reaches the machine directly or through 1:1
  NAT. IPv6 is not opened.
- A plan with at least **1 TB** of outbound traffic a month. The quota is set
  to 40% of what the plan includes (see [The outbound quota](#the-outbound-quota)).
- 2 vCPU and 2 GB of memory to start with.
- SSH with **keys only**. Turn password logins off before anything else:
  `PasswordAuthentication no` in `/etc/ssh/sshd_config`, then
  `sudo systemctl reload ssh`. Log in with your own account; the `rotifer`
  account has no login shell.
- For the **official** public nodes, two machines: at **two different cloud
  providers** (two companies, not two regions of one), under **two different
  provider accounts**, each with two-step verification, the two not sharing
  one login email, password or second factor. Each node generates its own
  key on its own machine at first start; never copy a key to the other one.

## Where things are

| Path | What |
|---|---|
| `/opt/rotifer/releases/<version>/` | One installed release: its `node_modules`, a copy of this `deploy/` directory, and `INSTALL` (how it was installed: `verified=yes` or `no`) |
| `/opt/rotifer/current` | Link to the running release |
| `/opt/rotifer/node/<version>/`, `/opt/rotifer/node/current` | The pinned Node.js, checked against `node-version` |
| `/opt/rotifer/releases/HISTORY` | One line per switch: time, from, to, verified |
| `/etc/rotifer/p2p.env` | Your settings (from `rotifer-p2p.env.example`) |
| `/var/lib/rotifer/.rotifer/` | The node's state: `identity.pem` (the node key), `peers.json`, `daemon.json`. Owned by `rotifer`, mode 0700 |
| `/var/lib/rotifer-quota/` | The quota's saved use, period, and the `capped` marker. Owned by root |
| `/usr/local/bin/rotifer-node-status` | The status command |
| `journalctl -u rotifer-p2p` | The node's log (`-u rotifer-quota` for the quota) |

## Install

1. Get this directory at the release you are going to run, on the machine:

   ```bash
   git clone --depth 1 --branch v<version> https://github.com/rotifer-protocol/rotifer-playground.git
   cd rotifer-playground/deploy/p2p-server
   ```

2. Run the installer once. It puts `/etc/rotifer/p2p.env` in place and stops
   because the public IP is still empty:

   ```bash
   sudo ./install.sh
   ```

3. Fill in `/etc/rotifer/p2p.env`: `ROTIFER_P2P_PUBLIC_IP`, and
   `ROTIFER_QUOTA_BYTES` and `ROTIFER_QUOTA_RESET_DAY` from your plan. The
   file explains each key.

4. Run the installer again:

   ```bash
   sudo ./install.sh
   ```

   Before anything is switched on it downloads the pinned Node.js and checks
   its SHA-256; installs the pinned package with `npm ci` (lock-file
   integrity hashes, no install scripts); checks npm registry signatures and
   provenance (`npm audit signatures`); loads the native module; and checks
   that `rotifer --version` is the pinned version. Any failure stops the
   install with nothing switched.

   Then it creates the `rotifer` user, installs the systemd units and the
   firewall, and starts the node. It refuses to go on if
   `/var/lib/rotifer/.rotifer/credentials.json` exists: a public node must
   not hold a Cloud login, so never run `rotifer login` on it.

5. **P2P consent.** Just before the node first starts, the installer runs

   ```bash
   rotifer network consent --accept
   ```

   as `rotifer` and prints the text being agreed to: what the node connects
   to and what peers can see. Read it; running the installer is you agreeing
   to it for this node. The record is
   `/var/lib/rotifer/.rotifer/p2p/consent.json`. Without it the node refuses
   to start, and under systemd there is no terminal to ask on. A release
   without `network consent` is refused before anything is switched.
   Upgrades and rollbacks keep the record; `rotifer network consent --revoke`
   (as `rotifer`) stops the node and withdraws it.

6. Check it:

   ```bash
   sudo rotifer-node-status
   ```

   `Service: ActiveState=active`, `Install: verified`, and an `Address:` line.

## Back up the node key

The node key is `/var/lib/rotifer/.rotifer/identity.pem`, generated at first
start. Its PeerId is part of the node's address, so losing it means every
user has to change their configuration.

Right after the first start, copy it off the machine once, to an encrypted
USB stick or as an attachment in a password manager:

```bash
sudo install -m 0600 -o "$(id -un)" /var/lib/rotifer/.rotifer/identity.pem ~/identity.pem
# copy ~/identity.pem off the machine (scp from your own computer), then:
rm ~/identity.pem
```

Never into a synced cloud folder, never into a chat or an issue. The key is
not rotated on a schedule: only when it may have leaked, or when the machine
is retired.

To move the node to a new machine, install there, stop the node, put the
backed-up `identity.pem` in `/var/lib/rotifer/.rotifer/` (owner `rotifer`,
mode 0600), start it, and tell the maintainers the new IP. The PeerId stays.

## Look at the node

```bash
sudo rotifer-node-status
```

It only reads. It shows:

- `Release`, `Install` (`verified`, or `UNVERIFIED INSTALL` for a test
  install), `Node.js`.
- `Service`: `ActiveState`, `SubState`, and `NRestarts`, how often systemd
  has restarted the node since boot. A growing `NRestarts` means it keeps
  crashing: read `journalctl -u rotifer-p2p -n 200`.
- `Outbound quota`: bytes used this period, of how many, since when.
- `Firewall`: whether the table is loaded, and how many source addresses hit
  the per-IP limits in the last 7 days.
- `Address`: `/ip4/<public IP>/tcp/<port>/p2p/<PeerId>`, the address to give
  the maintainers.
- `Node`: the node's own counters (`rotifer network status --json`), which
  hold no peer address, no PeerId of other nodes and no score.

A third-party operator sends this output to the maintainers when asked, for
example after a security release.

## Upgrade

Releases are pinned in this directory: upgrading means a newer tag of this
repository, whose `package.json` and `package-lock.json` pin the newer
version. Run the new tag's `upgrade.sh`, so the checks, units and firewall
rules are the new release's:

```bash
git clone --depth 1 --branch v<new version> https://github.com/rotifer-protocol/rotifer-playground.git
cd rotifer-playground/deploy/p2p-server
sudo ./upgrade.sh
```

It runs the same checks as the install before switching anything, checks the
new firewall rules with `nft -c`, saves the quota's use, switches, restarts,
and waits up to 60 s for the node to report the new version. If it does not,
the node goes back to the most recent **verified** release and `upgrade.sh`
exits non-zero; if there is no verified release to go back to, the node is
stopped.

After a security release, aim to upgrade within 7 days. Upgrades are done by
hand; nothing upgrades the node by itself.

## Roll back

```bash
sudo /opt/rotifer/current/deploy/rollback.sh            # the most recent verified release before this one
sudo /opt/rotifer/current/deploy/rollback.sh <version>  # that release
```

The target must still be in `/opt/rotifer/releases/`; nothing is downloaded.
The node goes back with that release's own units, firewall rules and
Node.js, and must report that version within 60 s.

- An **unverified** (test) install is never picked by itself and never used
  as the fallback of a failed upgrade. To go to one anyway, pass
  `--allow-unverified`.
- The oldest release a node can go back to is the first one that has both
  the public-node flags (`network start --foreground`, `--relay-server`) and
  `network consent`. An older release is refused at install.
  To take the node off the network instead, `sudo systemctl stop rotifer-p2p`
  and ask the maintainers to remove its address.

## The outbound quota

Every outbound byte except loopback counts against one quota per billing
period, `ROTIFER_QUOTA_BYTES`, set to **40% of the outbound traffic your plan
includes** (1 TB included: `400000000000`). 40% keeps the bill inside the
plan even when a quota period and the provider's billing month do not line
up: two quota periods in one billing month add up to 80%. Outbound traffic is
also limited to 1 MB/s, so using up 0.4 TB takes at least about 4.4 days.

- The kernel counts the bytes. `rotifer-quota.timer` saves the count every
  5 minutes to `/var/lib/rotifer-quota/used`, and the firewall is loaded with
  it at boot, so a reboot or a rule reload does not zero the month.
- At 50% and 80% it writes a warning to `journalctl -u rotifer-quota`.
  Nobody reads that by default: set the provider's own traffic or billing
  alerts at 30% and 40% of the included traffic.
- **When the quota is used up**, the firewall drops all outbound traffic
  except SSH at once, and within 5 minutes the node is stopped and stays
  stopped, across reboots, **until the reset day**
  (`ROTIFER_QUOTA_RESET_DAY`, UTC), when the count goes back to 0 and the
  node starts again by itself. For the rest of that period this public node
  is down: that is the price of a bill with a ceiling.
- To give it more room this period (it costs money if it goes past the
  plan): raise `ROTIFER_QUOTA_BYTES` in `/etc/rotifer/p2p.env`, then

  ```bash
  sudo systemctl reload rotifer-firewall
  sudo rm /var/lib/rotifer-quota/capped
  sudo systemctl start rotifer-p2p
  ```

## The node key leaked

Clients recognise a bootstrap node by its PeerId alone, not by its IP. Whoever
has the old key can run a node with the old PeerId on **any** IP, and a
client that reaches it believes its bootstrap node is online. Stopping the
old machine does not revoke the key, and clients have no revocation list. So
the goal is to get every user off the old PeerId as fast as possible. Do these
in order:

| Step | What | When |
|---|---|---|
| 1 | Stop the old node and keep the key for investigation, out of the node's reach: `sudo systemctl disable --now rotifer-p2p`, then `sudo mkdir -m 0700 /var/lib/rotifer/quarantine` and `sudo mv /var/lib/rotifer/.rotifer/identity.pem /var/lib/rotifer/quarantine/` | At once |
| 2 | **Have the old address removed from the published node list.** Third-party operators: tell the maintainers within 24 hours, through the contact channel agreed when your node was listed | Within 1 hour |
| 3 | Start the node with a new key (same or new machine): with `identity.pem` moved away, the next start generates a new key and PeerId. `sudo systemctl enable --now rotifer-p2p`, then back up the new key | After step 1 |
| 4 | Tell the operators of the other public nodes to drop the old address from their `ROTIFER_P2P_BOOTSTRAP` and use the new one: the template below. When both nodes are official, change the other node's `ROTIFER_P2P_BOOTSTRAP` yourself instead (then `sudo systemctl restart rotifer-p2p` there); no notice is needed | Within 24 hours of step 2 |
| 5 | Publish the new address, once `rotifer-node-status` on the new node looks right | After step 3 |

Notice to other operators (fill in the brackets, send it through the agreed
channel, nothing else in it):

```text
Subject: Rotifer public node key replaced: remove the old address

The node key of the Rotifer public node below may have leaked, so it has been
replaced. Please remove the old address from ROTIFER_P2P_BOOTSTRAP in
/etc/rotifer/p2p.env, add the new one, and restart your node:

  sudo systemctl restart rotifer-p2p

Old address (remove):  /ip4/<old IP>/tcp/<port>/p2p/<old PeerId>
New address (add):     /ip4/<new IP>/tcp/<port>/p2p/<new PeerId>

Until you do, your node may treat a node run by whoever holds the old key as
a trusted bootstrap peer. Reply to confirm when it is done.

<name>, <date and time, UTC>
```

## Retire the machine

1. Third-party operators: tell the maintainers at least **14 days** ahead,
   so the address comes off the node list first.
2. Once the address is off the list: `sudo systemctl disable --now
   rotifer-p2p rotifer-quota.timer rotifer-firewall`, then
   `sudo nft delete table inet rotifer`.
3. Delete the node key from the machine and destroy its backups; a retired
   PeerId must never come back. Then delete the machine at the provider.

## Test installs from local tarballs

```bash
sudo ./install.sh --from-tarballs <dir>
sudo ./upgrade.sh --from-tarballs <dir>
```

`<dir>` holds `npm pack` files of `@rotifer/playground` and
`@rotifer/playground-linux-x64-gnu` at the pinned version. **For testing
only, never in production.** There is nothing to check registry signatures
against, so the release is recorded as `verified=no`: `rotifer-node-status`
shows `UNVERIFIED INSTALL`, `HISTORY` says `verified=no`, and neither
`upgrade.sh` nor `rollback.sh` ever goes back to such a release by itself.

## Pre-launch checks

Before the first public node takes traffic, on a Linux x86-64 machine or VM
with systemd and nftables, check each of these and keep the output:

1. **Re-run every check in this list once a release that includes the
   public-node server role (`network start --foreground`, `--relay-server`,
   `--announce`) and first-run consent (`network consent`) is published, with
   this directory pinned to that release.**
   Checks run before that release, against local tarballs, do not count for
   launch.
2. `sudo ./install.sh` from the registry: installs, `Install: verified`.
   Then, with one integrity hash in `package-lock.json` changed by one
   character, and with an unsigned local tarball, the install must stop
   with `/opt/rotifer/current` unchanged.
3. `systemd-analyze security rotifer-p2p.service`: note the score.
4. `HOME` under systemd is `/var/lib/rotifer`, and the node key appears at
   `/var/lib/rotifer/.rotifer/identity.pem`, mode 0600, owner `rotifer`.
   `/var/lib/rotifer/.rotifer/p2p/consent.json` exists, owner `rotifer`,
   from before the first start (`source` is `command`).
5. The node starts with `RestrictAddressFamilies` as shipped (no address
   family missing for reading interface addresses).
6. Restarts: `sudo kill -9` the node; systemd restarts it within 5 s. After
   15 kills in a row it is still restarted, with growing delays, and
   `NRestarts` keeps counting (`RestartSteps`, `RestartMaxDelaySec`).
7. Firewall: `rotifer-quota check` passes; the per-IP limits (20 concurrent,
   30 new a minute) really drop packets; with a tiny quota (say 10 MB),
   pushing outbound past it drops everything but SSH and the timer stops the
   node; after `systemctl reload rotifer-firewall` and after a reboot the
   used amount is still there; normal traffic is not slowed by the 1 MB/s
   limit.
8. `upgrade.sh` to a newer release and `rollback.sh` back, each once: the unit
   files in `/etc/systemd/system` and the state in `/var/lib/rotifer` work in
   both directions (the older release starts on state the newer one wrote).
9. The native module loads after `npm ci --ignore-scripts`, and
   `npm audit signatures` passes for both packages.
10. A CLI node on another machine reserves a slot on this relay and reaches a
    third node through it.
11. No secret in this directory or in the installed release: run `gitleaks`
    over both.
