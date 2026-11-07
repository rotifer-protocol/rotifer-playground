//! Connection policy (A6, ADR-304 D2 revision): peers this node chooses to
//! dial itself, and the bootstrap keeper.
//!
//! Without this a node only ever dials its bootstrap peers and whoever its
//! Kademlia queries happen to reach; everything else is whoever dialled in
//! first. An attacker that dials in first, or runs most of the bootstrap
//! nodes, then chooses the victim's neighbours (A1-2 Eclipse). So:
//!
//! - **Top-up** keeps [`OUT_MIN`] *top-up peers*: peers whose first
//!   connection this policy dialled and that are still connected. Bootstrap
//!   connections, Kademlia's incidental dials and mDNS dials are not counted:
//!   bootstrap nodes are fixed by configuration (and may be the attacker's),
//!   and whom Kademlia dials is decided by answers an attacker can give.
//!   Candidates come only from addresses this node has itself dialled
//!   successfully ("dialled-OK", [`DialedBook`]), from the routing table
//!   sampled bucket-uniformly, and from a periodic random walk.
//! - The **keeper** redials a bootstrap node as soon as none is connected
//!   (P2P RFC §8.5 item 1), one at a time, backing off to [`KEEPER_BACKOFF_MAX`].
//! - [`Colocation`] keeps the cumulative same-IP counters that tell when the
//!   P6 trade-off needs reopening.
//!
//! Everything here is plain state driven by the event loop in `node.rs`, with
//! time passed in, so it is unit-tested without a network.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::time::{Duration, Instant};

use libp2p::multiaddr::Protocol;
use libp2p::swarm::ConnectionId;
use libp2p::{Multiaddr, PeerId};
use serde::{Deserialize, Serialize};

/// Top-up peers each node keeps.
pub(crate) const OUT_MIN: usize = 8;
/// How often top-up checks whether it is short.
pub(crate) const TOPUP_INTERVAL: Duration = Duration::from_secs(10);
/// Top-up dials per round, and of those at most this many from the peer store.
pub(crate) const DIALS_PER_ROUND: usize = 8;
pub(crate) const PEERSTORE_DIALS_PER_ROUND: usize = 2;
/// A random walk (`get_closest_peers` of a random key) on its own timer.
pub(crate) const RANDOM_WALK_INTERVAL: Duration = Duration::from_secs(60);
/// A top-up round that cannot fill its budget asks for a random walk at
/// once, at most this often (CEO 〔T-156〕 C4: "walk results join the
/// candidate pool" assumes the walk goes out in time; the 60 s timer alone
/// left ① short of candidates until t+60 s). One top-up period.
pub(crate) const SHORTFALL_WALK_EVERY: Duration = Duration::from_secs(10);
/// Per-peer cooldown after a failed top-up dial: doubles from the first value
/// up to the cap, ±[`JITTER`]; a success clears it.
pub(crate) const COOLDOWN_FIRST: Duration = Duration::from_secs(30);
pub(crate) const COOLDOWN_MAX: Duration = Duration::from_secs(30 * 60);
pub(crate) const JITTER: f64 = 0.2;
/// Keeper backoff between failed bootstrap dials: 1, 2, 4, 8, 16 s ±[`JITTER`].
pub(crate) const KEEPER_BACKOFF_FIRST: Duration = Duration::from_secs(1);
pub(crate) const KEEPER_BACKOFF_MAX: Duration = Duration::from_secs(16);
/// Fallback check of the keeper, besides reacting to a closed connection.
pub(crate) const KEEPER_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// A bootstrap connection counts as a success only if it stayed up this long.
/// A full bootstrap node completes the handshake and then denies the
/// connection within milliseconds; if that counted as a success, the keeper
/// would clear its backoff and redial in a loop (about 250 dials a second,
/// T-156 acceptance round 2). A shorter connection is a failure and backs
/// off; a longer one resets the backoff and is redialled at once. So a node
/// that accepts and then drops us gets at most one dial per 10 s.
pub(crate) const KEEPER_STABLE: Duration = Duration::from_secs(10);
/// A dialled-OK entry not dialled successfully for this long is no longer
/// used to dial (it stays in the peer store as heard-of).
pub(crate) const DIALED_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
/// Upper bound on dialled-OK entries; when full, the one dialled longest ago
/// makes room.
pub(crate) const DIALED_MAX: usize = super::peerstore::MAX_PERSISTED_PEERS;
/// Upper bound on random-walk results kept as candidates.
const WALK_POOL_MAX: usize = 64;
/// Cooldown entries kept; expired ones are dropped beyond this.
const COOLDOWN_ENTRIES_MAX: usize = 4096;

/// The time an event happened, both as a monotonic instant (backoffs,
/// connection lifetimes) and as wall-clock milliseconds (the peer store).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Now {
    pub(crate) at: Instant,
    pub(crate) wall_ms: u64,
}

/// Small PRNG (splitmix64). Candidate sampling and jitter need randomness,
/// not cryptographic strength, and a seed makes the unit tests repeatable.
pub(crate) struct Rng(u64);

impl Rng {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// Seeded from the clock and this node's PeerId, so two nodes started in
    /// the same instant still sample differently.
    pub(crate) fn for_node(peer: &PeerId) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or_default();
        let id = peer.to_bytes().iter().fold(0u64, |h, b| h.rotate_left(8) ^ u64::from(*b));
        Self(nanos ^ id)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n` (`n > 0`).
    pub(crate) fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    /// Uniform in `[0, 1)`.
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// `d` scaled by a factor uniform in `[1 − JITTER, 1 + JITTER)`.
    pub(crate) fn jitter(&mut self, d: Duration) -> Duration {
        d.mul_f64(1.0 - JITTER + 2.0 * JITTER * self.unit())
    }

    pub(crate) fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i + 1);
            items.swap(i, j);
        }
    }
}

/// `first`, doubled per earlier failure, capped at `max`.
fn doubled(first: Duration, failures: u32, max: Duration) -> Duration {
    first.saturating_mul(1u32 << failures.min(16)).min(max)
}

/// Why this node dialled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DialPurpose {
    /// Top-up of self-chosen outbound peers.
    TopUp,
    /// A configured bootstrap address, by index (the startup dial or the
    /// keeper).
    Bootstrap(usize),
    /// A dialled-OK entry from the peer store, dialled at startup.
    Restart,
}

/// How a connected peer's first connection came about. GossipSub counts a
/// peer as outbound when its first connection was dialled by this node,
/// whoever dialled it; this keeps the same distinction and who dialled.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum FirstConnection {
    /// Dialled by top-up: counts towards [`OUT_MIN`].
    TopUp,
    /// Dialled to a configured bootstrap address.
    Bootstrap,
    /// Dialled at startup from the peer store.
    Restart,
    /// Dialled by something else: Kademlia queries, mDNS, an explicit dial.
    OtherDial,
    /// The peer dialled in.
    Inbound,
}

impl FirstConnection {
    /// Whether GossipSub counts this peer as outbound.
    pub fn is_outbound(self) -> bool {
        self != FirstConnection::Inbound
    }
}

/// How a top-up peer became one (design v5 §1.7).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum TopUpWay {
    /// Top-up dialled it while it had no connection.
    Dialled,
    /// It was already connected by this node's own dial and top-up's
    /// candidate rules drew it.
    Adopted,
}

/// One top-up round's readings (design v5 §5.1, F3), so that "top-up dialled
/// no one" can be told apart as "no candidate" or "dialling is broken".
#[derive(Clone, Debug, Default, Serialize)]
pub struct TopUpRound {
    /// Routing-table entries when the round started.
    pub routing_table: usize,
    /// Candidates top-up could take then: adoptable connected peers, plus
    /// unconnected ones not being dialled and not cooling down.
    pub eligible: usize,
    /// The same, per k-bucket index.
    #[serde(skip)]
    pub eligible_by_bucket: Vec<(u32, Vec<PeerId>)>,
    /// Top-up peers the round added by adopting.
    pub adopted: usize,
    /// Top-up dials sent since the round started.
    pub dials: usize,
    /// Top-up dials that failed (or could not start) since the round started.
    pub failures: usize,
    /// Top-up dials sent, and failed, since this node started.
    pub dials_total: usize,
    pub failures_total: usize,
    /// The round chose fewer than its budget, and it sent a random walk.
    pub short: bool,
    pub walk_sent: bool,
    /// Random walks sent for a short round since this node started.
    pub shortfall_walks_total: usize,
}

// ---------------------------------------------------------------------
// Cooldowns
// ---------------------------------------------------------------------

/// Per-PeerId cooldown after failed top-up dials. Keyed by PeerId, so it
/// does not bind an attacker that keeps minting new identities.
#[derive(Default)]
pub(crate) struct Cooldowns {
    by_peer: HashMap<PeerId, (u32, Instant)>,
}

impl Cooldowns {
    pub(crate) fn failed(&mut self, peer: PeerId, now: Instant, rng: &mut Rng) {
        if self.by_peer.len() >= COOLDOWN_ENTRIES_MAX {
            self.by_peer.retain(|_, (_, until)| *until > now);
        }
        let entry = self.by_peer.entry(peer).or_insert((0, now));
        let wait = rng.jitter(doubled(COOLDOWN_FIRST, entry.0, COOLDOWN_MAX));
        entry.0 = entry.0.saturating_add(1);
        entry.1 = now + wait;
    }

    pub(crate) fn succeeded(&mut self, peer: &PeerId) {
        self.by_peer.remove(peer);
    }

    /// Peers cooling down at `now` (tests read them).
    #[cfg(test)]
    pub(crate) fn cooling_peers(&self, now: Instant) -> Vec<PeerId> {
        self.by_peer.keys().filter(|p| self.cooling(p, now)).copied().collect()
    }

    pub(crate) fn cooling(&self, peer: &PeerId, now: Instant) -> bool {
        self.by_peer.get(peer).is_some_and(|(_, until)| *until > now)
    }
}

// ---------------------------------------------------------------------
// Dialled-OK peer store level
// ---------------------------------------------------------------------

/// One dialled-OK entry: a dialable address ending in `/p2p/<PeerId>` and
/// when this node last dialled it successfully (wall clock, ms).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DialedEntry {
    pub addr: String,
    pub last_ok_ms: u64,
}

/// The dialled-OK level of the peer store. Only top-up, the bootstrap
/// dials and the restart dials record here; a Kademlia query's incidental
/// dial does not (it dials addresses from answers an attacker can give), and
/// addresses peers report about themselves through Identify stay heard-of
/// (the plain peer store). Top-up and restart dial only this level.
#[derive(Default)]
pub(crate) struct DialedBook {
    entries: Vec<DialedEntry>,
}

impl DialedBook {
    /// From persisted entries: duplicates keep the newest, entries older than
    /// [`DIALED_MAX_AGE`] drop (to heard-of), and the newest [`DIALED_MAX`]
    /// stay.
    pub(crate) fn from_entries(entries: Vec<DialedEntry>, now_ms: u64) -> Self {
        let mut book = Self::default();
        for e in entries {
            book.record_at(e.addr, e.last_ok_ms, now_ms);
        }
        book
    }

    pub(crate) fn record(&mut self, addr: String, now_ms: u64) {
        self.record_at(addr, now_ms, now_ms);
    }

    fn record_at(&mut self, addr: String, at_ms: u64, now_ms: u64) {
        if addr.is_empty() || now_ms.saturating_sub(at_ms) > DIALED_MAX_AGE.as_millis() as u64 {
            return;
        }
        if let Some(e) = self.entries.iter_mut().find(|e| e.addr == addr) {
            e.last_ok_ms = e.last_ok_ms.max(at_ms);
            return;
        }
        if self.entries.len() >= DIALED_MAX {
            let Some((oldest, _)) = self.entries.iter().enumerate().min_by_key(|(_, e)| e.last_ok_ms) else {
                return;
            };
            if self.entries[oldest].last_ok_ms > at_ms {
                return;
            }
            self.entries.remove(oldest);
        }
        self.entries.push(DialedEntry { addr, last_ok_ms: at_ms });
    }

    /// Entries still young enough to dial.
    pub(crate) fn usable(&self, now_ms: u64) -> impl Iterator<Item = &DialedEntry> {
        let max = DIALED_MAX_AGE.as_millis() as u64;
        self.entries.iter().filter(move |e| now_ms.saturating_sub(e.last_ok_ms) <= max)
    }

    pub(crate) fn entries(&self) -> &[DialedEntry] {
        &self.entries
    }

    /// Drop every entry of `peer` (a non-Rotifer node).
    pub(crate) fn forget(&mut self, peer: &PeerId) {
        let suffix = format!("/p2p/{peer}");
        self.entries.retain(|e| !e.addr.ends_with(&suffix));
    }
}

/// `addr` in dialable form, ending in `/p2p/<peer>`.
pub(crate) fn dialable(addr: &Multiaddr, peer: &PeerId) -> String {
    if matches!(addr.iter().last(), Some(Protocol::P2p(_))) {
        addr.to_string()
    } else {
        format!("{addr}/p2p/{peer}")
    }
}

/// Split a dialable address into its PeerId and the address without it.
pub(crate) fn split_dialable(text: &str) -> Option<(PeerId, Multiaddr)> {
    let mut addr: Multiaddr = text.parse().ok()?;
    match addr.pop() {
        Some(Protocol::P2p(peer)) => Some((peer, addr)),
        _ => None,
    }
}

// ---------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------

/// One non-empty k-bucket as top-up sees it: its index from this node, and
/// each entry's peer and addresses.
pub(crate) type Bucket = (u32, Vec<(PeerId, Vec<Multiaddr>)>);

/// Where top-up may look for peers, in priority order.
#[derive(Default)]
pub(crate) struct Sources {
    /// Test-only control: put these first (models Identify-reported
    /// addresses reaching top-up, which the dialled-OK rule forbids).
    pub preferred: Vec<(PeerId, Vec<Multiaddr>)>,
    /// Dialled-OK peer store entries.
    pub peerstore: Vec<(PeerId, Vec<Multiaddr>)>,
    /// The routing table, one list per non-empty k-bucket.
    pub buckets: Vec<Vec<(PeerId, Vec<Multiaddr>)>>,
    /// Random-walk results.
    pub walk: Vec<(PeerId, Vec<Multiaddr>)>,
}

/// Pick up to `budget` distinct peers to dial: the preferred ones in order;
/// then at most [`PEERSTORE_DIALS_PER_ROUND`] dialled-OK entries at random;
/// then from the routing table, a uniformly drawn non-empty bucket and a
/// uniformly drawn peer in it, repeatedly; then random-walk results. Peers
/// failing `eligible` (connected, being dialled, cooling down, a bootstrap
/// node, ourselves) are skipped and do not use up the budget.
pub(crate) fn choose(
    budget: usize,
    sources: Sources,
    eligible: impl Fn(&PeerId) -> bool,
    rng: &mut Rng,
) -> Vec<(PeerId, Vec<Multiaddr>)> {
    let mut chosen: Vec<(PeerId, Vec<Multiaddr>)> = Vec::new();
    let mut taken: HashSet<PeerId> = HashSet::new();
    let ok = |p: &PeerId, taken: &HashSet<PeerId>| !taken.contains(p) && eligible(p);

    for (peer, addrs) in sources.preferred {
        if chosen.len() >= budget {
            return chosen;
        }
        if !addrs.is_empty() && ok(&peer, &taken) {
            taken.insert(peer);
            chosen.push((peer, addrs));
        }
    }

    let mut store = sources.peerstore;
    rng.shuffle(&mut store);
    let mut from_store = 0;
    for (peer, addrs) in store {
        if chosen.len() >= budget || from_store >= PEERSTORE_DIALS_PER_ROUND {
            break;
        }
        if !addrs.is_empty() && ok(&peer, &taken) {
            taken.insert(peer);
            chosen.push((peer, addrs));
            from_store += 1;
        }
    }

    let mut buckets: Vec<Vec<(PeerId, Vec<Multiaddr>)>> = sources
        .buckets
        .into_iter()
        .map(|b| b.into_iter().filter(|(p, a)| !a.is_empty() && ok(p, &taken)).collect::<Vec<_>>())
        .filter(|b| !b.is_empty())
        .collect();
    while chosen.len() < budget && !buckets.is_empty() {
        let b = rng.below(buckets.len());
        let i = rng.below(buckets[b].len());
        let (peer, addrs) = buckets[b].swap_remove(i);
        taken.insert(peer);
        chosen.push((peer, addrs));
        // Drop the drawn peer from any other bucket list (none in practice)
        // and buckets left empty.
        for bucket in &mut buckets {
            bucket.retain(|(p, _)| *p != peer);
        }
        buckets.retain(|b| !b.is_empty());
    }

    let mut walk = sources.walk;
    rng.shuffle(&mut walk);
    for (peer, addrs) in walk {
        if chosen.len() >= budget {
            break;
        }
        if !addrs.is_empty() && ok(&peer, &taken) {
            taken.insert(peer);
            chosen.push((peer, addrs));
        }
    }
    chosen
}

// ---------------------------------------------------------------------
// Bootstrap keeper
// ---------------------------------------------------------------------

/// Redials a bootstrap node when none is connected (RFC §8.5 item 1).
///
/// A configured address need not carry `/p2p/<PeerId>`; its PeerId is then
/// learned on the first successful dial. Until learned, it counts as not
/// connected. The keeper guarantees an *attempt* as soon as the count drops to
/// zero, not a success: with every bootstrap node down it keeps retrying.
pub(crate) struct Keeper {
    addrs: Vec<Multiaddr>,
    ids: Vec<Option<PeerId>>,
    next: usize,
    failures: u32,
    retry_at: Option<Instant>,
    in_flight: Option<ConnectionId>,
    dials: u64,
}

impl Keeper {
    /// `startup` is when the startup dials went out: the keeper waits one
    /// check interval for them before dialling on its own.
    pub(crate) fn new(addrs: Vec<Multiaddr>, startup: Instant) -> Self {
        let ids = addrs
            .iter()
            .map(|a| match a.iter().last() {
                Some(Protocol::P2p(p)) => Some(p),
                _ => None,
            })
            .collect();
        Self {
            addrs,
            ids,
            next: 0,
            failures: 0,
            retry_at: Some(startup + KEEPER_CHECK_INTERVAL),
            in_flight: None,
            dials: 0,
        }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.addrs.is_empty()
    }

    pub(crate) fn learn(&mut self, index: usize, peer: PeerId) {
        if let Some(slot) = self.ids.get_mut(index) {
            *slot = Some(peer);
        }
    }

    pub(crate) fn is_bootstrap(&self, peer: &PeerId) -> bool {
        self.ids.iter().any(|id| id.as_ref() == Some(peer))
    }

    /// Bootstrap nodes currently connected (known PeerIds only).
    pub(crate) fn connected(&self, is_connected: impl Fn(&PeerId) -> bool) -> usize {
        let mut seen = HashSet::new();
        self.ids.iter().flatten().filter(|p| seen.insert(**p) && is_connected(p)).count()
    }

    /// The bootstrap address to dial now, if one is due: none connected, no
    /// keeper dial in flight, backoff elapsed. Rotates through the list.
    pub(crate) fn due(&mut self, now: Instant, connected: usize) -> Option<(usize, Multiaddr, Option<PeerId>)> {
        if self.addrs.is_empty() || connected > 0 || self.in_flight.is_some() {
            return None;
        }
        if self.retry_at.is_some_and(|at| at > now) {
            return None;
        }
        let i = self.next;
        self.next = (self.next + 1) % self.addrs.len();
        Some((i, self.addrs[i].clone(), self.ids[i]))
    }

    /// The dial returned by [`Keeper::due`] went out as `id`.
    pub(crate) fn started(&mut self, id: ConnectionId) {
        self.in_flight = Some(id);
        self.dials += 1;
    }

    /// The dial returned by [`Keeper::due`] could not even start.
    pub(crate) fn not_started(&mut self, now: Instant, rng: &mut Rng) {
        self.dials += 1;
        self.back_off(now, rng);
    }

    pub(crate) fn is_in_flight(&self, id: ConnectionId) -> bool {
        self.in_flight == Some(id)
    }

    pub(crate) fn failed(&mut self, now: Instant, rng: &mut Rng) {
        self.in_flight = None;
        self.back_off(now, rng);
    }

    fn back_off(&mut self, now: Instant, rng: &mut Rng) {
        let wait = rng.jitter(doubled(KEEPER_BACKOFF_FIRST, self.failures, KEEPER_BACKOFF_MAX));
        self.failures = self.failures.saturating_add(1);
        self.retry_at = Some(now + wait);
    }

    /// The keeper's dial connected. Not yet a success: that waits for how
    /// long the connection lasts (see [`Keeper::lost`]).
    pub(crate) fn up(&mut self) {
        self.in_flight = None;
        self.retry_at = None;
    }

    /// The last bootstrap connection closed after `lived` (`None` if this
    /// node did not dial it). Shorter than [`KEEPER_STABLE`] counts as a
    /// failure and backs off; otherwise the backoff resets and the keeper
    /// may redial at once (RFC §8.5 item 1).
    pub(crate) fn lost(&mut self, now: Instant, lived: Option<Duration>, rng: &mut Rng) {
        if lived.is_some_and(|d| d < KEEPER_STABLE) {
            self.back_off(now, rng);
        } else {
            self.failures = 0;
            self.retry_at = None;
        }
    }

    /// When the backoff next allows a dial, if it is holding one back.
    pub(crate) fn retry_at(&self) -> Option<Instant> {
        self.retry_at
    }

    /// Dials the keeper has made (startup dials excluded).
    #[cfg(test)]
    pub(crate) fn dials(&self) -> u64 {
        self.dials
    }
}

// ---------------------------------------------------------------------
// Same-IP counters (the P6 trigger line)
// ---------------------------------------------------------------------

/// Same-IP peer count above which P6 starts to penalise. libp2p's default
/// `ip_colocation_factor_threshold`; since K10 (T-158) the node applies P6
/// itself, see [`Colocation::penalties`].
pub(crate) const P6_THRESHOLD: f64 = 10.0;
/// P6 weight: each peer on an IP over the threshold gets weight × surplus².
/// libp2p's default `ip_colocation_factor_weight`.
pub(crate) const P6_WEIGHT: f64 = -5.0;

/// Cumulative, never-decreasing counters of peers sharing an IP. They tell
/// when to reopen the P6 trade-off (design v3 §3.4): the third counts IPs
/// over the threshold that had a peer with a valid proof of registration,
/// i.e. where P6 hits a registered participant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ColocationStats {
    /// Distinct IPs that ever had more connected peers than the threshold.
    pub ips_over_threshold: u64,
    /// Most connected peers ever seen on one IP.
    pub max_peers_on_one_ip: u64,
    /// Distinct IPs over the threshold while one of their peers held a valid
    /// proof of registration.
    pub ips_over_threshold_with_registered_peer: u64,
}

/// Connected peers by IP, feeding [`ColocationStats`] and P6
/// ([`Colocation::penalties`]).
#[derive(Default)]
pub(crate) struct Colocation {
    conns: HashMap<ConnectionId, (PeerId, IpAddr)>,
    by_ip: HashMap<IpAddr, HashMap<PeerId, u32>>,
    over: HashSet<IpAddr>,
    over_registered: HashSet<IpAddr>,
    stats: ColocationStats,
    warned_over: bool,
    warned_registered: bool,
}

/// The IP of a connection's remote address, if it has one.
pub(crate) fn ip_of(addr: &Multiaddr) -> Option<IpAddr> {
    addr.iter().find_map(|p| match p {
        Protocol::Ip4(ip) => Some(IpAddr::V4(ip)),
        Protocol::Ip6(ip) => Some(IpAddr::V6(ip)),
        _ => None,
    })
}

impl Colocation {
    /// A connection opened; `registered` says whether a peer holds a valid
    /// proof of registration.
    pub(crate) fn opened(
        &mut self,
        id: ConnectionId,
        peer: PeerId,
        addr: &Multiaddr,
        registered: impl Fn(&PeerId) -> bool,
    ) {
        let Some(ip) = ip_of(addr) else { return };
        self.conns.insert(id, (peer, ip));
        *self.by_ip.entry(ip).or_default().entry(peer).or_default() += 1;
        self.update(ip, registered);
    }

    pub(crate) fn closed(&mut self, id: ConnectionId) {
        let Some((peer, ip)) = self.conns.remove(&id) else { return };
        if let Some(peers) = self.by_ip.get_mut(&ip) {
            if let Some(n) = peers.get_mut(&peer) {
                *n -= 1;
                if *n == 0 {
                    peers.remove(&peer);
                }
            }
            if peers.is_empty() {
                self.by_ip.remove(&ip);
            }
        }
    }

    /// Re-check every IP over the threshold (registration can arrive after
    /// the connection).
    pub(crate) fn rescan(&mut self, registered: impl Fn(&PeerId) -> bool) {
        let ips: Vec<IpAddr> = self.by_ip.keys().copied().collect();
        for ip in ips {
            self.update(ip, &registered);
        }
    }

    fn update(&mut self, ip: IpAddr, registered: impl Fn(&PeerId) -> bool) {
        let Some(peers) = self.by_ip.get(&ip) else { return };
        let n = peers.len() as u64;
        self.stats.max_peers_on_one_ip = self.stats.max_peers_on_one_ip.max(n);
        if (n as f64) <= P6_THRESHOLD {
            return;
        }
        if self.over.insert(ip) {
            self.stats.ips_over_threshold = self.over.len() as u64;
            if !self.warned_over {
                self.warned_over = true;
                tracing::warn!(%ip, peers = n, "more peers on one IP than the P6 threshold; GossipSub now scores them down");
            }
        }
        if !self.over_registered.contains(&ip) && peers.keys().any(&registered) {
            self.over_registered.insert(ip);
            self.stats.ips_over_threshold_with_registered_peer = self.over_registered.len() as u64;
            if !self.warned_registered {
                self.warned_registered = true;
                tracing::warn!(%ip, peers = n, "a registered peer shares an IP over the P6 threshold; P6 scores it down too");
            }
        }
    }

    pub(crate) fn stats(&self) -> ColocationStats {
        self.stats
    }

    /// P6 by this node's own count (K10, T-158): every peer on an IP with more
    /// than [`P6_THRESHOLD`] distinct connected peers gets
    /// [`P6_WEIGHT`] × (peers − threshold)², summed over its IPs; IPs in
    /// `whitelist` are skipped. This is libp2p-gossipsub 0.50.1's P6 formula
    /// (`peer_score.rs`), but counted from live connections: a peer stays on
    /// an IP while any of its connections from there is open. GossipSub's own
    /// count drops the IP when any one of them closes
    /// (`on_connection_closed` → `remove_ip`), which is K10.
    pub(crate) fn penalties(&self, whitelist: &HashSet<IpAddr>) -> HashMap<PeerId, f64> {
        let mut out: HashMap<PeerId, f64> = HashMap::new();
        for (ip, peers) in &self.by_ip {
            let n = peers.len() as f64;
            if n <= P6_THRESHOLD || whitelist.contains(ip) {
                continue;
            }
            let surplus = n - P6_THRESHOLD;
            for peer in peers.keys() {
                *out.entry(*peer).or_default() += surplus * surplus * P6_WEIGHT;
            }
        }
        out
    }
}

// ---------------------------------------------------------------------
// Event-loop state
// ---------------------------------------------------------------------

/// The policy's state in the event loop.
pub(crate) struct Outbound {
    /// How each connected peer's first connection came about.
    first: HashMap<PeerId, FirstConnection>,
    /// Our dials in flight and why.
    pending: HashMap<ConnectionId, (Option<PeerId>, DialPurpose)>,
    pub(crate) cooldowns: Cooldowns,
    walk_pool: Vec<(PeerId, Vec<Multiaddr>)>,
    /// Connected peers top-up adopted (design v5 §1.7): their first
    /// connection was this node's own dial, not by top-up and not to a
    /// bootstrap address, and top-up's candidate rules drew them.
    adopted: HashSet<PeerId>,
    /// The last top-up round's readings (design v5 §5.1, F3).
    pub(crate) last_round: TopUpRound,
    /// When a short round last sent a random walk.
    shortfall_walk_at: Option<Instant>,
    /// When each connection from a bootstrap dial was established.
    up_since: HashMap<ConnectionId, Instant>,
    pub(crate) keeper: Keeper,
    pub(crate) book: DialedBook,
    pub(crate) rng: Rng,
    /// Test switches: hold top-up / the keeper; dial these first; adopt but
    /// never dial (the ①-拨 control, design v5 §5.9.1).
    pub(crate) adopt_only: bool,
    /// Test switch: hold the random walk (①-拨's quiet mode, §5.9.1).
    pub(crate) walk_paused: bool,
    pub(crate) topup_paused: bool,
    pub(crate) keeper_paused: bool,
    pub(crate) preferred: Vec<(PeerId, Vec<Multiaddr>)>,
}

impl Outbound {
    pub(crate) fn new(keeper: Keeper, book: DialedBook, rng: Rng) -> Self {
        Self {
            first: HashMap::new(),
            pending: HashMap::new(),
            up_since: HashMap::new(),
            cooldowns: Cooldowns::default(),
            walk_pool: Vec::new(),
            adopted: HashSet::new(),
            last_round: TopUpRound::default(),
            shortfall_walk_at: None,
            adopt_only: false,
            walk_paused: false,
            keeper,
            book,
            rng,
            topup_paused: false,
            keeper_paused: false,
            preferred: Vec::new(),
        }
    }

    pub(crate) fn dialing(&mut self, id: ConnectionId, peer: Option<PeerId>, purpose: DialPurpose) {
        if purpose == DialPurpose::TopUp {
            self.last_round.dials += 1;
            self.last_round.dials_total += 1;
        }
        self.pending.insert(id, (peer, purpose));
    }

    /// A top-up dial to `peer` could not be started: it cools down like a
    /// failed one and counts as this round's failure.
    pub(crate) fn topup_not_started(&mut self, peer: PeerId, now: Instant) {
        self.last_round.failures += 1;
        self.last_round.failures_total += 1;
        self.cooldowns.failed(peer, now, &mut self.rng);
    }

    /// Top-up peers: connected, and either first dialled by top-up or
    /// adopted by it.
    pub(crate) fn topup_peers(&self) -> usize {
        self.first.values().filter(|f| **f == FirstConnection::TopUp).count() + self.adopted.len()
    }

    /// How each top-up peer became one.
    #[cfg(test)]
    pub(crate) fn topup_ways(&self) -> HashMap<PeerId, TopUpWay> {
        let dialled = self
            .first
            .iter()
            .filter(|(_, f)| **f == FirstConnection::TopUp)
            .map(|(p, _)| (*p, TopUpWay::Dialled));
        let adopted = self.adopted.iter().map(|p| (*p, TopUpWay::Adopted));
        dialled.chain(adopted).collect()
    }

    /// Whether top-up may adopt connected `peer`: its first connection was
    /// this node's own dial other than top-up or a bootstrap address
    /// (Kademlia, mDNS, a restart dial), it is not a bootstrap node, and it
    /// is not a top-up peer already. A peer that dialled in never can.
    pub(crate) fn adoptable(&self, peer: &PeerId) -> bool {
        matches!(self.first.get(peer), Some(FirstConnection::OtherDial | FirstConnection::Restart))
            && !self.keeper.is_bootstrap(peer)
            && !self.adopted.contains(peer)
    }

    fn topup_in_flight(&self) -> usize {
        self.pending.values().filter(|(_, p)| *p == DialPurpose::TopUp).count()
    }

    fn is_pending(&self, peer: &PeerId) -> bool {
        self.pending.values().any(|(p, _)| p.as_ref() == Some(peer))
    }

    /// How many top-up peers this round may add, adopted and dialled
    /// together; dials in flight use up budget.
    pub(crate) fn topup_budget(&self) -> usize {
        OUT_MIN.saturating_sub(self.topup_peers() + self.topup_in_flight()).min(DIALS_PER_ROUND)
    }

    /// Whether top-up may take `peer` now: dial it (no connection, not being
    /// dialled, not cooling down) or adopt it (connected and
    /// [`Outbound::adoptable`]). Never itself or a bootstrap node.
    pub(crate) fn eligible(&self, peer: &PeerId, me: &PeerId, connected: bool, now: Instant) -> bool {
        if peer == me || self.keeper.is_bootstrap(peer) {
            return false;
        }
        if connected {
            return self.adoptable(peer);
        }
        !self.is_pending(peer) && !self.cooldowns.cooling(peer, now)
    }

    /// One top-up round (design v5 §1.6–§1.7) over the routing table's
    /// non-empty k-buckets, each with its index as seen from this node.
    /// Records the round's readings; while fewer than [`OUT_MIN`] top-up
    /// peers are connected, draws up to [`DIALS_PER_ROUND`] candidates by
    /// the candidate rules, adopts the drawn ones that are connected, and
    /// returns the ones to dial (none with `adopt_only`). The caller dials
    /// them tagged [`DialPurpose::TopUp`].
    pub(crate) fn round(
        &mut self,
        me: &PeerId,
        buckets: Vec<Bucket>,
        is_connected: impl Fn(&PeerId) -> bool,
        now: Instant,
        now_ms: u64,
    ) -> Vec<(PeerId, Vec<Multiaddr>)> {
        let routing_table = buckets.iter().map(|(_, b)| b.len()).sum();
        let by_bucket: Vec<(u32, Vec<PeerId>)> = buckets
            .iter()
            .map(|(i, b)| {
                let ok = b.iter().map(|(p, _)| *p).filter(|p| self.eligible(p, me, is_connected(p), now));
                (*i, ok.collect())
            })
            .collect();
        self.last_round = TopUpRound {
            routing_table,
            eligible: by_bucket.iter().map(|(_, ps)| ps.len()).sum(),
            eligible_by_bucket: by_bucket,
            dials_total: self.last_round.dials_total,
            failures_total: self.last_round.failures_total,
            shortfall_walks_total: self.last_round.shortfall_walks_total,
            ..TopUpRound::default()
        };
        let budget = self.topup_budget();
        if budget == 0 {
            return Vec::new();
        }
        let sources = Sources {
            preferred: self.preferred.clone(),
            peerstore: self.peerstore_candidates(now_ms),
            buckets: buckets.into_iter().map(|(_, b)| b).collect(),
            walk: self.walk_candidates(),
        };
        let mut rng = std::mem::replace(&mut self.rng, Rng::new(0));
        let chosen = choose(budget, sources, |p| self.eligible(p, me, is_connected(p), now), &mut rng);
        self.rng = rng;
        self.last_round.short = chosen.len() < budget;
        let mut dial = Vec::new();
        for (peer, addrs) in chosen {
            if is_connected(&peer) {
                // `eligible` admitted it, so it is adoptable.
                self.adopted.insert(peer);
                self.last_round.adopted += 1;
            } else if !self.adopt_only {
                dial.push((peer, addrs));
            }
        }
        dial
    }

    /// Whether to send a random walk now: the last round was short, and no
    /// short round sent one in the last [`SHORTFALL_WALK_EVERY`]. Records
    /// the walk when it says yes.
    pub(crate) fn shortfall_walk(&mut self, now: Instant) -> bool {
        if self.walk_paused || !self.last_round.short || self.last_round.walk_sent {
            return false;
        }
        if self.shortfall_walk_at.is_some_and(|at| now.saturating_duration_since(at) < SHORTFALL_WALK_EVERY) {
            return false;
        }
        self.shortfall_walk_at = Some(now);
        self.last_round.walk_sent = true;
        self.last_round.shortfall_walks_total += 1;
        true
    }

    /// Dialled-OK entries as top-up candidates.
    pub(crate) fn peerstore_candidates(&self, now_ms: u64) -> Vec<(PeerId, Vec<Multiaddr>)> {
        let mut by_peer: HashMap<PeerId, Vec<Multiaddr>> = HashMap::new();
        for e in self.book.usable(now_ms) {
            if let Some((peer, addr)) = split_dialable(&e.addr) {
                by_peer.entry(peer).or_default().push(addr);
            }
        }
        by_peer.into_iter().collect()
    }

    pub(crate) fn walk_candidates(&self) -> Vec<(PeerId, Vec<Multiaddr>)> {
        self.walk_pool.clone()
    }

    /// Random-walk results join the candidate pool (newest kept).
    pub(crate) fn walked(&mut self, found: Vec<(PeerId, Vec<Multiaddr>)>) {
        for (peer, addrs) in found {
            if addrs.is_empty() {
                continue;
            }
            self.walk_pool.retain(|(p, _)| *p != peer);
            self.walk_pool.push((peer, addrs));
        }
        let excess = self.walk_pool.len().saturating_sub(WALK_POOL_MAX);
        self.walk_pool.drain(..excess);
    }

    /// A connection was established. `first` says it is the peer's only one.
    pub(crate) fn established(
        &mut self,
        id: ConnectionId,
        peer: PeerId,
        dialer: bool,
        first: bool,
        remote: &Multiaddr,
        now: Now,
    ) {
        let Now { at: now, wall_ms: now_ms } = now;
        let purpose = self.pending.remove(&id).map(|(_, p)| p);
        if let Some(purpose) = purpose {
            self.book.record(dialable(remote, &peer), now_ms);
            match purpose {
                DialPurpose::TopUp => self.cooldowns.succeeded(&peer),
                DialPurpose::Bootstrap(i) => {
                    self.keeper.learn(i, peer);
                    self.up_since.insert(id, now);
                    if self.keeper.is_in_flight(id) {
                        self.keeper.up();
                    }
                }
                DialPurpose::Restart => {}
            }
        }
        if first {
            let how = match (dialer, purpose) {
                (false, _) => FirstConnection::Inbound,
                (true, Some(DialPurpose::TopUp)) => FirstConnection::TopUp,
                (true, Some(DialPurpose::Bootstrap(_))) => FirstConnection::Bootstrap,
                (true, Some(DialPurpose::Restart)) => FirstConnection::Restart,
                (true, None) => FirstConnection::OtherDial,
            };
            self.first.insert(peer, how);
        }
    }

    /// One of our dials failed.
    pub(crate) fn dial_failed(&mut self, id: ConnectionId, peer: Option<PeerId>, now: Instant) {
        let Some((known, purpose)) = self.pending.remove(&id) else { return };
        match purpose {
            DialPurpose::TopUp => {
                self.last_round.failures += 1;
                self.last_round.failures_total += 1;
                if let Some(p) = peer.or(known) {
                    self.cooldowns.failed(p, now, &mut self.rng);
                }
            }
            DialPurpose::Bootstrap(_) => {
                if self.keeper.is_in_flight(id) {
                    self.keeper.failed(now, &mut self.rng);
                }
            }
            DialPurpose::Restart => {}
        }
    }

    /// Connection `id` to `peer` closed; `remaining` connections to `peer`
    /// are left. Returns whether it was a bootstrap node's last connection;
    /// if so, the keeper counts it as a failure or a success by how long it
    /// lasted.
    pub(crate) fn closed(&mut self, id: ConnectionId, peer: &PeerId, remaining: u32, now: Instant) -> bool {
        let since = self.up_since.remove(&id);
        if remaining > 0 {
            return false;
        }
        self.first.remove(peer);
        self.adopted.remove(peer);
        if !self.keeper.is_bootstrap(peer) {
            return false;
        }
        self.keeper.lost(now, since.map(|d| now.saturating_duration_since(d)), &mut self.rng);
        true
    }

    #[cfg(test)]
    pub(crate) fn first_connections(&self) -> &HashMap<PeerId, FirstConnection> {
        &self.first
    }

    /// Non-Rotifer peer: forget its dialled-OK entries.
    pub(crate) fn forget(&mut self, peer: &PeerId) {
        self.book.forget(peer);
        self.walk_pool.retain(|(p, _)| p != peer);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer() -> PeerId {
        PeerId::random()
    }

    fn addr(port: u16) -> Multiaddr {
        format!("/ip4/127.0.0.1/tcp/{port}").parse().unwrap()
    }

    fn cid() -> ConnectionId {
        ConnectionId::new_unchecked(rand_id())
    }

    fn rand_id() -> usize {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static NEXT: AtomicUsize = AtomicUsize::new(1_000_000);
        NEXT.fetch_add(1, Ordering::Relaxed)
    }

    fn outbound(boot: Vec<Multiaddr>, start: Instant) -> Outbound {
        Outbound::new(Keeper::new(boot, start), DialedBook::default(), Rng::new(7))
    }

    #[test]
    fn constants_are_the_designed_ones() {
        assert_eq!(OUT_MIN, 8);
        assert_eq!((DIALS_PER_ROUND, PEERSTORE_DIALS_PER_ROUND), (8, 2));
        assert_eq!(TOPUP_INTERVAL, Duration::from_secs(10));
        assert_eq!(RANDOM_WALK_INTERVAL, Duration::from_secs(60));
        assert_eq!((COOLDOWN_FIRST, COOLDOWN_MAX), (Duration::from_secs(30), Duration::from_secs(1800)));
        assert_eq!((KEEPER_BACKOFF_FIRST, KEEPER_BACKOFF_MAX), (Duration::from_secs(1), Duration::from_secs(16)));
        assert_eq!(KEEPER_CHECK_INTERVAL, Duration::from_secs(5));
        assert_eq!(KEEPER_STABLE, Duration::from_secs(10));
        assert_eq!(JITTER, 0.2);
        assert_eq!(DIALED_MAX_AGE, Duration::from_secs(7 * 24 * 3600));
        assert_eq!(DIALED_MAX, 64);
    }

    fn at(now: Instant) -> Now {
        Now { at: now, wall_ms: 0 }
    }

    #[test]
    fn bootstrap_peer_id_is_learned_and_its_last_close_reported() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let (boot, other) = (peer(), peer());
        let c = cid();
        o.dialing(c, None, DialPurpose::Bootstrap(0));
        o.established(c, boot, true, true, &addr(1), at(now));
        // A connection that is not a bootstrap dial teaches nothing.
        o.established(cid(), other, true, true, &addr(2), at(now));
        assert!(o.keeper.is_bootstrap(&boot), "the bootstrap PeerId is learned on the first dial");
        assert!(!o.keeper.is_bootstrap(&other));
        assert!(!o.closed(cid(), &boot, 1, now), "one connection left");
        assert!(o.closed(c, &boot, 0, now), "a bootstrap node's last connection");
        assert!(!o.closed(cid(), &other, 0, now), "not a bootstrap node");
    }

    #[test]
    fn a_failed_keeper_dial_backs_off_and_a_successful_one_resets() {
        let start = Instant::now();
        let mut o = outbound(vec![addr(1)], start);
        let now = start + KEEPER_CHECK_INTERVAL;
        let (i, _, _) = o.keeper.due(now, 0).expect("due");
        let c = cid();
        o.dialing(c, None, DialPurpose::Bootstrap(i));
        o.keeper.started(c);
        // A failure of some other dial leaves the keeper alone.
        o.dial_failed(cid(), None, now);
        assert!(o.keeper.is_in_flight(c));
        o.dial_failed(c, None, now);
        assert!(!o.keeper.is_in_flight(c));
        assert!(o.keeper.retry_at().is_some_and(|at| at > now), "backing off");
        let later = o.keeper.retry_at().unwrap();
        let (i, _, _) = o.keeper.due(later, 0).expect("due again after the backoff");
        let c = cid();
        o.dialing(c, None, DialPurpose::Bootstrap(i));
        o.keeper.started(c);
        o.established(c, peer(), true, true, &addr(1), at(later));
        assert!(o.keeper.retry_at().is_none(), "connected: nothing to wait for");
    }

    #[test]
    fn out_min_counts_only_topup_peers() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let (topup, boot, kad, inbound, restart) = (peer(), peer(), peer(), peer(), peer());
        let (c1, c2, c3) = (cid(), cid(), cid());
        o.dialing(c1, Some(topup), DialPurpose::TopUp);
        o.dialing(c2, None, DialPurpose::Bootstrap(0));
        o.dialing(c3, Some(restart), DialPurpose::Restart);
        o.established(c1, topup, true, true, &addr(2), Now { at: Instant::now(), wall_ms: 0 });
        o.established(c2, boot, true, true, &addr(1), Now { at: Instant::now(), wall_ms: 0 });
        o.established(c3, restart, true, true, &addr(5), Now { at: Instant::now(), wall_ms: 0 });
        // A Kademlia query's dial: not one of ours.
        o.established(cid(), kad, true, true, &addr(3), Now { at: Instant::now(), wall_ms: 0 });
        o.established(cid(), inbound, false, true, &addr(4), Now { at: Instant::now(), wall_ms: 0 });
        assert_eq!(o.topup_peers(), 1);
        let first = o.first_connections();
        assert_eq!(first[&topup], FirstConnection::TopUp);
        assert_eq!(first[&boot], FirstConnection::Bootstrap);
        assert_eq!(first[&kad], FirstConnection::OtherDial);
        assert_eq!(first[&inbound], FirstConnection::Inbound);
        assert_eq!(first[&restart], FirstConnection::Restart);
        assert_eq!(first.values().filter(|f| f.is_outbound()).count(), 4);
        assert!(o.keeper.is_bootstrap(&boot), "the bootstrap PeerId is learned on the first dial");
        // A second connection to a peer that dialled in does not make it a top-up peer.
        let c4 = cid();
        o.dialing(c4, Some(inbound), DialPurpose::TopUp);
        o.established(c4, inbound, true, false, &addr(4), Now { at: Instant::now(), wall_ms: 0 });
        assert_eq!(o.topup_peers(), 1);
        // The last connection closing forgets it.
        assert!(!o.closed(cid(), &topup, 1, Instant::now()));
        assert_eq!(o.topup_peers(), 1);
        assert!(!o.closed(cid(), &topup, 0, Instant::now()));
        assert_eq!(o.topup_peers(), 0);
        assert!(o.closed(cid(), &boot, 0, Instant::now()), "a bootstrap node's last connection");
    }

    #[test]
    fn dialled_ok_is_recorded_by_our_dials_only() {
        let now = Instant::now();
        let mut o = outbound(vec![], now);
        let (topup, kad, restart, inbound) = (peer(), peer(), peer(), peer());
        let (c1, c2) = (cid(), cid());
        o.dialing(c1, Some(topup), DialPurpose::TopUp);
        o.dialing(c2, Some(restart), DialPurpose::Restart);
        o.established(c1, topup, true, true, &addr(2), Now { at: Instant::now(), wall_ms: 5 });
        o.established(c2, restart, true, true, &addr(6), Now { at: Instant::now(), wall_ms: 5 });
        o.established(cid(), kad, true, true, &addr(3), Now { at: Instant::now(), wall_ms: 5 });
        o.established(cid(), inbound, false, true, &addr(4), Now { at: Instant::now(), wall_ms: 5 });
        let recorded: Vec<&str> = o.book.entries().iter().map(|e| e.addr.as_str()).collect();
        assert_eq!(
            recorded,
            vec![format!("{}/p2p/{topup}", addr(2)).as_str(), format!("{}/p2p/{restart}", addr(6)).as_str()]
        );
    }

    #[test]
    fn identify_reported_addresses_do_not_reach_topup() {
        // Top-up's peer-store source is the dialled-OK book; the heard-of
        // addresses (Identify) live in the plain peer store, which top-up
        // never reads. Only a recorded dial makes a candidate.
        let o = outbound(vec![], Instant::now());
        assert!(o.peerstore_candidates(0).is_empty());
    }

    #[test]
    fn dialled_book_evicts_the_longest_ago_and_ages_out() {
        let day = 24 * 3600 * 1000u64;
        let mut book = DialedBook::default();
        for i in 0..DIALED_MAX as u64 {
            book.record(format!("/ip4/10.0.0.1/tcp/{}/p2p/P{i}", 1000 + i), 10 * day + i);
        }
        book.record("/ip4/10.0.0.2/tcp/1/p2p/NEW".into(), 10 * day + 1000);
        assert_eq!(book.entries().len(), DIALED_MAX);
        assert!(!book.entries().iter().any(|e| e.addr.ends_with("/P0")), "the one dialled longest ago goes");
        assert!(book.entries().iter().any(|e| e.addr.ends_with("/NEW")));
        // Re-dialled: refreshed, not duplicated.
        book.record("/ip4/10.0.0.1/tcp/1001/p2p/P1".into(), 12 * day);
        assert_eq!(book.entries().iter().filter(|e| e.addr.ends_with("/P1")).count(), 1);
        // Eight days on, only the refreshed entry is still usable.
        let later = 10 * day + 1000 + 8 * day;
        let usable: Vec<&str> = book.usable(later).map(|e| e.addr.as_str()).collect();
        assert_eq!(usable, vec!["/ip4/10.0.0.1/tcp/1001/p2p/P1"]);
        // Loading drops the stale ones outright.
        let reloaded = DialedBook::from_entries(book.entries().to_vec(), later);
        assert_eq!(reloaded.entries().len(), 1);
    }

    #[test]
    fn choose_caps_the_peerstore_and_skips_ineligible() {
        let mut rng = Rng::new(1);
        let store: Vec<_> = (0..5).map(|i| (peer(), vec![addr(i)])).collect();
        let banned = store[0].0;
        let table: Vec<_> = (0..20).map(|i| (peer(), vec![addr(100 + i)])).collect();
        let chosen = choose(
            8,
            Sources { peerstore: store.clone(), buckets: vec![table.clone()], ..Default::default() },
            |p| *p != banned,
            &mut rng,
        );
        assert_eq!(chosen.len(), 8);
        let from_store = chosen.iter().filter(|(p, _)| store.iter().any(|(s, _)| s == p)).count();
        assert_eq!(from_store, PEERSTORE_DIALS_PER_ROUND);
        assert!(!chosen.iter().any(|(p, _)| *p == banned));
        let distinct: HashSet<_> = chosen.iter().map(|(p, _)| *p).collect();
        assert_eq!(distinct.len(), 8);
    }

    #[test]
    fn choose_puts_preferred_first() {
        let mut rng = Rng::new(2);
        let preferred: Vec<_> = (0..3).map(|i| (peer(), vec![addr(i)])).collect();
        let table: Vec<_> = (0..20).map(|i| (peer(), vec![addr(100 + i)])).collect();
        let chosen = choose(
            4,
            Sources { preferred: preferred.clone(), buckets: vec![table], ..Default::default() },
            |_| true,
            &mut rng,
        );
        let ids: Vec<_> = chosen.iter().map(|(p, _)| *p).collect();
        assert_eq!(&ids[..3], &preferred.iter().map(|(p, _)| *p).collect::<Vec<_>>()[..]);
        assert_eq!(ids.len(), 4);
    }

    #[test]
    fn buckets_are_drawn_uniformly_not_by_size() {
        // One far bucket with 1 peer, three buckets with 20 each: drawing one
        // peer per round, the far bucket comes up about 1/4 of the time
        // (a draw over all peers would give 1/61).
        let mut rng = Rng::new(3);
        let far = peer();
        let mut buckets = vec![vec![(far, vec![addr(1)])]];
        for b in 0..3u16 {
            buckets.push((0..20).map(|i| (peer(), vec![addr(1000 * (b + 1) + i)])).collect());
        }
        let rounds = 4000;
        let mut hits = 0;
        for _ in 0..rounds {
            let chosen = choose(1, Sources { buckets: buckets.clone(), ..Default::default() }, |_| true, &mut rng);
            if chosen[0].0 == far {
                hits += 1;
            }
        }
        let share = hits as f64 / rounds as f64;
        assert!((0.22..0.28).contains(&share), "far bucket drawn {share:.3} of the time, expected ≈ 0.25");
    }

    #[test]
    fn failed_candidates_cool_down_and_free_the_budget() {
        let start = Instant::now();
        let mut o = outbound(vec![], start);
        let me = peer();
        let unreachable: Vec<_> = (0..8).map(|i| (peer(), vec![addr(i)])).collect();
        let others: Vec<_> = (0..8).map(|i| (peer(), vec![addr(100 + i)])).collect();
        o.preferred = unreachable.clone();
        let round = |o: &mut Outbound, now: Instant| {
            let budget = o.topup_budget();
            let sources =
                Sources { preferred: o.preferred.clone(), walk: others.clone(), ..Default::default() };
            let chosen = {
                let mut rng = Rng::new(9);
                choose(budget, sources, |p| o.eligible(p, &me, false, now), &mut rng)
            };
            let ids: Vec<_> = chosen
                .iter()
                .map(|(p, _)| {
                    let c = cid();
                    o.dialing(c, Some(*p), DialPurpose::TopUp);
                    (c, *p)
                })
                .collect();
            ids
        };
        // Round 1: the eight unreachable ones take the whole budget and fail.
        let first = round(&mut o, start);
        assert_eq!(first.iter().map(|(_, p)| *p).collect::<Vec<_>>(), unreachable.iter().map(|(p, _)| *p).collect::<Vec<_>>());
        for (c, p) in &first {
            o.dial_failed(*c, Some(*p), start);
        }
        // Round 2 (10 s later): they are cooling down, the budget goes to the others.
        let second = round(&mut o, start + TOPUP_INTERVAL);
        assert_eq!(second.len(), 8);
        assert!(second.iter().all(|(_, p)| others.iter().any(|(q, _)| q == p)));
        // The cooldown is 30 s ± 20 %, then doubles.
        for (c, p) in &second {
            o.dial_failed(*c, Some(*p), start + TOPUP_INTERVAL);
        }
        let p = unreachable[0].0;
        assert!(o.cooldowns.cooling(&p, start + Duration::from_secs(23)));
        assert!(!o.cooldowns.cooling(&p, start + Duration::from_secs(37)));
        o.cooldowns.failed(p, start + Duration::from_secs(40), &mut Rng::new(4));
        assert!(o.cooldowns.cooling(&p, start + Duration::from_secs(40 + 47)));
        assert!(!o.cooldowns.cooling(&p, start + Duration::from_secs(40 + 73)));
    }

    /// Connected through each way of a first connection: top-up dialled,
    /// a Kademlia dial (adoptable), a bootstrap dial, inbound.
    fn connect(o: &mut Outbound, peer: PeerId, purpose: Option<DialPurpose>) -> ConnectionId {
        let c = cid();
        if let Some(purpose) = purpose {
            o.dialing(c, Some(peer), purpose);
        }
        o.established(c, peer, purpose.is_some(), true, &addr(9), at(Instant::now()));
        c
    }

    fn one_bucket(peers: &[PeerId]) -> Vec<Bucket> {
        vec![(3, peers.iter().map(|p| (*p, vec![addr(1)])).collect())]
    }

    #[test]
    fn inbound_first_and_bootstrap_peers_are_never_adopted() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let me = peer();
        let (inbound, boot) = (peer(), peer());
        connect(&mut o, inbound, None);
        connect(&mut o, boot, Some(DialPurpose::Bootstrap(0)));
        assert!(!o.adoptable(&inbound) && !o.adoptable(&boot));
        let connected: HashSet<PeerId> = [inbound, boot].into();
        let dial = o.round(&me, one_bucket(&[inbound, boot]), |p| connected.contains(p), now, 0);
        assert!(dial.is_empty(), "both are connected: nothing to dial");
        assert_eq!((o.topup_peers(), o.last_round.adopted, o.last_round.eligible), (0, 0, 0));
    }

    #[test]
    fn a_kademlia_dialled_peer_drawn_is_adopted_without_a_dial() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let me = peer();
        let kad = peer();
        // A Kademlia dial is an untagged dial of ours.
        let c = cid();
        o.established(c, kad, true, true, &addr(3), at(now));
        assert!(o.adoptable(&kad));
        let dial = o.round(&me, one_bucket(&[kad]), |p| *p == kad, now, 0);
        assert!(dial.is_empty(), "adopted, not dialled");
        assert_eq!((o.topup_peers(), o.last_round.adopted, o.last_round.dials), (1, 1, 0));
        assert_eq!(o.topup_ways().get(&kad), Some(&TopUpWay::Adopted));
        assert!(!o.adoptable(&kad), "adopted once");
    }

    #[test]
    fn an_adopted_peer_loses_the_tag_on_close_and_cannot_come_back_inbound() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let me = peer();
        let kad = peer();
        let c = cid();
        o.established(c, kad, true, true, &addr(3), at(now));
        o.round(&me, one_bucket(&[kad]), |p| *p == kad, now, 0);
        assert_eq!(o.topup_peers(), 1);
        o.closed(c, &kad, 0, now);
        assert_eq!(o.topup_peers(), 0, "the tag goes with the connection");
        // Back, but it dialled in this time.
        o.established(cid(), kad, false, true, &addr(3), at(now));
        assert!(!o.adoptable(&kad));
        let dial = o.round(&me, one_bucket(&[kad]), |p| *p == kad, now, 0);
        assert!(dial.is_empty());
        assert_eq!(o.topup_peers(), 0);
    }

    #[test]
    fn a_round_takes_at_most_eight_and_two_from_the_peerstore() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let me = peer();
        // 6 adoptable connected, 6 unconnected, 5 dialled-OK store entries.
        let adoptable: Vec<PeerId> = (0..6).map(|_| peer()).collect();
        for p in &adoptable {
            o.established(cid(), *p, true, true, &addr(3), at(now));
        }
        let unconnected: Vec<PeerId> = (0..6).map(|_| peer()).collect();
        let stored: Vec<PeerId> = (0..5).map(|_| peer()).collect();
        for (i, p) in stored.iter().enumerate() {
            o.book.record(dialable(&addr(100 + i as u16), p), 0);
        }
        let mut all = adoptable.clone();
        all.extend(&unconnected);
        let connected: HashSet<PeerId> = adoptable.iter().copied().collect();
        let dial = o.round(&me, one_bucket(&all), |p| connected.contains(p), now, 0);
        let from_store = dial.iter().filter(|(p, _)| stored.contains(p)).count();
        assert!(from_store <= 2, "peerstore at most 2 a round, got {from_store}");
        assert_eq!(o.last_round.adopted + dial.len(), 8, "adopted and dialled together: 8");
    }

    #[test]
    fn adoptable_and_unconnected_peers_are_drawn_alike() {
        // Fixed seed, many rounds: in one bucket of 4 adoptable connected and
        // 4 unconnected peers, a budget of 1 draws each kind about half the
        // time.
        let me = peer();
        let adoptable: Vec<PeerId> = (0..4).map(|_| peer()).collect();
        let unconnected: Vec<PeerId> = (0..4).map(|_| peer()).collect();
        let mut all = adoptable.clone();
        all.extend(&unconnected);
        let mut adopted = 0;
        let n = 2000;
        for seed in 0..n {
            let now = Instant::now();
            let mut o = Outbound::new(Keeper::new(vec![], now), DialedBook::default(), Rng::new(seed));
            let mut connected: HashSet<PeerId> = adoptable.iter().copied().collect();
            for p in &adoptable {
                o.established(cid(), *p, true, true, &addr(3), at(now));
            }
            // Seven top-up peers already (connected), so the budget is 1.
            for _ in 0..7 {
                let p = peer();
                connect(&mut o, p, Some(DialPurpose::TopUp));
                connected.insert(p);
            }
            let dial = o.round(&me, one_bucket(&all), |p| connected.contains(p), now, 0);
            assert_eq!(o.last_round.adopted + dial.len(), 1);
            adopted += o.last_round.adopted;
        }
        let share = adopted as f64 / n as f64;
        assert!((0.45..0.55).contains(&share), "adopted share {share}");
    }

    /// C4 (CEO 〔T-156〕): a short round asks for a walk at once, at most
    /// once per 10 s; a round that fills its budget does not.
    #[test]
    fn a_short_round_sends_one_walk_per_ten_seconds() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let me = peer();
        let few: Vec<PeerId> = (0..3).map(|_| peer()).collect();
        let none: HashSet<PeerId> = HashSet::new();
        // 3 candidates for a budget of 8: short.
        let _ = o.round(&me, one_bucket(&few), |p| none.contains(p), now, 0);
        assert!(o.last_round.short, "3 candidates for 8: short");
        assert!(o.shortfall_walk(now), "a short round sends a walk");
        assert!(!o.shortfall_walk(now), "once per round");
        // Short again 5 s later: within 10 s of the last walk, no walk.
        let t5 = now + Duration::from_secs(5);
        let _ = o.round(&me, one_bucket(&few), |p| none.contains(p), t5, 0);
        assert!(o.last_round.short);
        assert!(!o.shortfall_walk(t5), "within 10 s of the last one");
        // Short again at +10 s: a walk again.
        let t10 = now + SHORTFALL_WALK_EVERY;
        let _ = o.round(&me, one_bucket(&few), |p| none.contains(p), t10, 0);
        assert!(o.shortfall_walk(t10), "10 s on, a short round walks again");
        assert_eq!(o.last_round.shortfall_walks_total, 2);
    }

    /// ①-拨's quiet mode: a held walk holds the shortfall walk too.
    #[test]
    fn a_held_walk_holds_the_shortfall_walk() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let me = peer();
        let few: Vec<PeerId> = (0..3).map(|_| peer()).collect();
        let none: HashSet<PeerId> = HashSet::new();
        o.walk_paused = true;
        let _ = o.round(&me, one_bucket(&few), |p| none.contains(p), now, 0);
        assert!(o.last_round.short);
        assert!(!o.shortfall_walk(now), "walk held: no shortfall walk");
        o.walk_paused = false;
        assert!(o.shortfall_walk(now), "released: the short round walks");
    }

    #[test]
    fn a_round_that_fills_its_budget_sends_no_walk() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let me = peer();
        let many: Vec<PeerId> = (0..20).map(|_| peer()).collect();
        let none: HashSet<PeerId> = HashSet::new();
        let dial = o.round(&me, one_bucket(&many), |p| none.contains(p), now, 0);
        assert_eq!(dial.len(), 8, "20 candidates fill the budget of 8");
        assert!(!o.last_round.short);
        assert!(!o.shortfall_walk(now), "enough candidates: no walk");
        // A round with no budget left (8 dials in flight) is not short either.
        for (p, _) in &dial {
            o.dialing(cid(), Some(*p), DialPurpose::TopUp);
        }
        let later = now + SHORTFALL_WALK_EVERY;
        let _ = o.round(&me, one_bucket(&many), |p| none.contains(p), later, 0);
        assert!(!o.last_round.short, "no budget left is not a shortfall");
        assert!(!o.shortfall_walk(later));
    }

    #[test]
    fn with_too_few_to_adopt_the_round_dials_the_disconnected() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let me = peer();
        // 2 top-up peers already (budget 6), 3 adoptable and 10 disconnected
        // in the table: the round takes 6, and dials = min(8 - 2 - adopted,
        // 10, 6) = 6 - adopted, all of them disconnected ones.
        let mut connected: HashSet<PeerId> = HashSet::new();
        for _ in 0..2 {
            let p = peer();
            connect(&mut o, p, Some(DialPurpose::TopUp));
            connected.insert(p);
        }
        let adoptable: Vec<PeerId> = (0..3).map(|_| peer()).collect();
        for p in &adoptable {
            o.established(cid(), *p, true, true, &addr(3), at(now));
            connected.insert(*p);
        }
        let gone: Vec<PeerId> = (0..10).map(|_| peer()).collect();
        let mut all = adoptable.clone();
        all.extend(&gone);
        let dial = o.round(&me, one_bucket(&all), |p| connected.contains(p), now, 0);
        assert_eq!(o.last_round.adopted + dial.len(), 6);
        assert!(!dial.is_empty(), "at most 3 adoptable: the round must dial");
        assert!(dial.iter().all(|(p, _)| gone.contains(p)));
        assert_eq!(o.last_round.dials, 0, "dials are counted when sent, not when chosen");
        assert_eq!((o.last_round.routing_table, o.last_round.eligible), (13, 13));
        // Once the dials go out the budget is used up: the next round takes none.
        for (p, _) in &dial {
            o.dialing(cid(), Some(*p), DialPurpose::TopUp);
        }
        let next = o.round(&me, one_bucket(&all), |p| connected.contains(p), now, 0);
        assert_eq!(o.topup_budget(), 0, "2 top-up + adopted + dials in flight = 8");
        assert!(next.is_empty());
        assert_eq!(o.last_round.adopted, 0);
    }

    #[test]
    fn a_topup_dial_counts_only_once_connected_and_a_failure_cools_down() {
        let start = Instant::now();
        let mut o = outbound(vec![addr(1)], start);
        let me = peer();
        let (good, bad) = (peer(), peer());
        let dial = o.round(&me, one_bucket(&[good, bad]), |_| false, start, 0);
        assert_eq!(dial.len(), 2);
        let (cg, cb) = (cid(), cid());
        o.dialing(cg, Some(good), DialPurpose::TopUp);
        o.dialing(cb, Some(bad), DialPurpose::TopUp);
        assert_eq!(o.last_round.dials, 2);
        assert_eq!(o.topup_peers(), 0, "dialled, not yet connected: not a top-up peer");
        // A round while both are in flight dials neither again.
        let again = o.round(&me, one_bucket(&[good, bad]), |_| false, start, 0);
        assert!(again.is_empty(), "pending candidates are not redialled");
        assert_eq!(o.last_round.eligible, 0);
        o.established(cg, good, true, true, &addr(2), at(start));
        o.dial_failed(cb, Some(bad), start);
        assert_eq!(o.topup_peers(), 1, "counted once the tagged connection is up");
        assert_eq!(o.topup_ways().get(&good), Some(&TopUpWay::Dialled));
        assert_eq!(o.last_round.failures, 1);
        let later = start + TOPUP_INTERVAL;
        let next = o.round(&me, one_bucket(&[good, bad]), |p| *p == good, later, 0);
        assert!(next.is_empty(), "the failed one is cooling down, the other is a top-up peer");
        assert_eq!(o.last_round.eligible, 0);
    }

    #[test]
    fn the_four_readings_follow_events() {
        let start = Instant::now();
        let mut o = outbound(vec![addr(1)], start);
        let me = peer();
        let peers: Vec<PeerId> = (0..5).map(|_| peer()).collect();
        let buckets = vec![(2, peers[..2].iter().map(|p| (*p, vec![addr(1)])).collect()), (5, peers[2..].iter().map(|p| (*p, vec![addr(1)])).collect())];
        let dial = o.round(&me, buckets.clone(), |_| false, start, 0);
        let r = &o.last_round;
        assert_eq!((r.routing_table, r.eligible, r.dials, r.failures), (5, 5, 0, 0));
        assert_eq!(r.eligible_by_bucket.iter().map(|(i, ps)| (*i, ps.len())).collect::<Vec<_>>(), vec![(2, 2), (5, 3)]);
        let ids: Vec<ConnectionId> = dial.iter().map(|_| cid()).collect();
        for ((p, _), c) in dial.iter().zip(&ids) {
            o.dialing(*c, Some(*p), DialPurpose::TopUp);
        }
        assert_eq!(o.last_round.dials, 5);
        o.dial_failed(ids[0], Some(dial[0].0), start);
        o.topup_not_started(peer(), start);
        assert_eq!((o.last_round.failures, o.last_round.failures_total), (2, 2));
        // The next round starts its own counts; the totals carry on.
        let later = start + TOPUP_INTERVAL;
        o.round(&me, buckets, |_| false, later, 0);
        let r = &o.last_round;
        assert_eq!((r.dials, r.failures, r.dials_total, r.failures_total), (0, 0, 5, 2));
        assert_eq!(r.eligible, 0, "4 in flight, 1 cooling down");
    }

    #[test]
    fn adopt_only_adopts_and_never_dials() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        o.adopt_only = true;
        let me = peer();
        let kad = peer();
        o.established(cid(), kad, true, true, &addr(3), at(now));
        let gone: Vec<PeerId> = (0..5).map(|_| peer()).collect();
        let mut all = vec![kad];
        all.extend(&gone);
        let dial = o.round(&me, one_bucket(&all), |p| *p == kad, now, 0);
        assert!(dial.is_empty());
        assert_eq!(o.topup_peers(), 1);
    }

    #[test]
    fn cooldown_caps_at_thirty_minutes() {
        let now = Instant::now();
        let mut c = Cooldowns::default();
        let p = peer();
        let mut rng = Rng::new(5);
        for _ in 0..20 {
            c.failed(p, now, &mut rng);
        }
        assert!(c.cooling(&p, now + Duration::from_secs(1440 - 1)));
        assert!(!c.cooling(&p, now + Duration::from_secs(2160 + 1)));
        c.succeeded(&p);
        assert!(!c.cooling(&p, now));
    }

    #[test]
    fn walk_pool_is_bounded_and_keeps_the_newest() {
        let mut o = outbound(vec![], Instant::now());
        let first = peer();
        o.walked(vec![(first, vec![addr(1)])]);
        o.walked((0..WALK_POOL_MAX).map(|i| (peer(), vec![addr(i as u16 + 10)])).collect());
        let pool = o.walk_candidates();
        assert_eq!(pool.len(), WALK_POOL_MAX);
        assert!(!pool.iter().any(|(p, _)| *p == first));
    }

    #[test]
    fn keeper_dials_at_once_on_zero_then_backs_off_to_sixteen_seconds() {
        let start = Instant::now();
        let boots = vec![addr(1), addr(2), addr(3)];
        let mut k = Keeper::new(boots.clone(), start);
        let mut rng = Rng::new(6);
        // Startup dials are out: nothing until one check interval has passed.
        assert!(k.due(start, 0).is_none());
        let mut now = start + KEEPER_CHECK_INTERVAL;
        let mut order = Vec::new();
        let mut waits = Vec::new();
        for _ in 0..7 {
            let (i, a, _) = k.due(now, 0).expect("due");
            assert_eq!(a, boots[i]);
            order.push(i);
            let c = cid();
            k.started(c);
            assert!(k.due(now, 0).is_none(), "one dial at a time");
            k.failed(now, &mut rng);
            // Find when it is due again.
            let mut t = now;
            while k.due(t, 0).is_none() {
                t += Duration::from_millis(100);
            }
            // `due` above already consumed the next slot; undo by rewinding the rotation.
            k.next = (k.next + boots.len() - 1) % boots.len();
            waits.push((t - now).as_secs_f64());
            now = t;
        }
        assert_eq!(order, vec![0, 1, 2, 0, 1, 2, 0], "rotates through the list");
        let nominal = [1.0, 2.0, 4.0, 8.0, 16.0, 16.0, 16.0];
        for (w, n) in waits.iter().zip(nominal) {
            assert!(*w >= n * 0.8 - 0.1 && *w <= n * 1.2 + 0.1, "waited {w:.1}s, expected {n}s ± 20 %: {waits:?}");
        }
        // Connected again: stop and reset.
        let c = cid();
        let (_, _, _) = k.due(now, 0).unwrap();
        k.started(c);
        k.up();
        k.lost(now, Some(KEEPER_STABLE), &mut rng);
        assert!(k.due(now, 1).is_none(), "one connected bootstrap is enough");
        assert!(k.due(now, 0).is_some(), "dropping to zero dials at once");
        assert_eq!(k.dials(), 8);
    }

    /// T-156 acceptance round 2: a full bootstrap node accepts the handshake
    /// and closes at once. That must back off like a failed dial, growing
    /// 1, 2, 4 s; only a connection that lasted [`KEEPER_STABLE`] resets.
    #[test]
    fn a_connection_closed_at_once_backs_off_and_a_lasting_one_resets() {
        let start = Instant::now();
        let mut o = outbound(vec![addr(1)], start);
        let boot = peer();
        let mut now = start + KEEPER_CHECK_INTERVAL;
        let mut waits = Vec::new();
        for _ in 0..3 {
            let (i, _, _) = o.keeper.due(now, 0).expect("due");
            let c = cid();
            o.dialing(c, None, DialPurpose::Bootstrap(i));
            o.keeper.started(c);
            o.established(c, boot, true, true, &addr(1), Now { at: now, wall_ms: 0 });
            let closed_at = now + Duration::from_millis(5);
            assert!(o.closed(c, &boot, 0, closed_at), "the bootstrap node's last connection");
            let at = o.keeper.retry_at().expect("a connection closed at once backs off");
            waits.push((at - closed_at).as_secs_f64());
            assert!(o.keeper.due(closed_at, 0).is_none(), "no redial before the backoff");
            now = at;
        }
        for (w, n) in waits.iter().zip([1.0, 2.0, 4.0]) {
            assert!(*w >= n * 0.8 && *w <= n * 1.2, "waited {w:.2}s, expected {n}s ± 20 %: {waits:?}");
        }
        // A connection that lasted KEEPER_STABLE resets: redial at once.
        let (i, _, _) = o.keeper.due(now, 0).expect("due");
        let c = cid();
        o.dialing(c, None, DialPurpose::Bootstrap(i));
        o.keeper.started(c);
        o.established(c, boot, true, true, &addr(1), Now { at: now, wall_ms: 0 });
        let closed_at = now + KEEPER_STABLE;
        assert!(o.closed(c, &boot, 0, closed_at));
        assert!(o.keeper.retry_at().is_none(), "a lasting connection clears the backoff");
        assert!(o.keeper.due(closed_at, 0).is_some(), "and the keeper redials at once");
    }

    #[test]
    fn keeper_with_no_bootstrap_does_nothing() {
        let start = Instant::now();
        let mut k = Keeper::new(vec![], start);
        assert!(k.is_empty());
        assert!(k.due(start + Duration::from_secs(60), 0).is_none());
    }

    #[test]
    fn keeper_takes_the_peer_id_from_the_address_when_given() {
        let p = peer();
        let with_id: Multiaddr = format!("/ip4/127.0.0.1/tcp/1/p2p/{p}").parse().unwrap();
        let k = Keeper::new(vec![with_id, addr(2)], Instant::now());
        assert!(k.is_bootstrap(&p));
        assert_eq!(k.connected(|q| *q == p), 1);
    }

    #[test]
    fn colocation_counters_only_grow() {
        let ip: Multiaddr = "/ip4/10.1.1.1/tcp/1".parse().unwrap();
        let other: Multiaddr = "/ip4/10.1.1.2/tcp/1".parse().unwrap();
        let mut c = Colocation::default();
        let registered = peer();
        let mut conns = Vec::new();
        for i in 0..12 {
            let p = if i == 0 { registered } else { peer() };
            let id = cid();
            c.opened(id, p, &ip, |_| false);
            conns.push(id);
        }
        c.opened(cid(), peer(), &other, |_| false);
        let s = c.stats();
        assert_eq!((s.ips_over_threshold, s.max_peers_on_one_ip, s.ips_over_threshold_with_registered_peer), (1, 12, 0));
        // Registration arrives later.
        c.rescan(|p| *p == registered);
        assert_eq!(c.stats().ips_over_threshold_with_registered_peer, 1);
        // Everyone leaves: nothing goes down.
        for id in conns {
            c.closed(id);
        }
        c.rescan(|_| true);
        assert_eq!(c.stats(), s_with(1, 12, 1));
        // A second connection of the same peer does not count as a second peer.
        let p = peer();
        c.opened(cid(), p, &other, |_| false);
        c.opened(cid(), p, &other, |_| false);
        assert_eq!(c.stats().max_peers_on_one_ip, 12);
    }

    /// `n` peers on `ip`, one connection each.
    fn crowd(c: &mut Colocation, ip: &Multiaddr, n: usize) -> Vec<(PeerId, ConnectionId)> {
        (0..n)
            .map(|_| {
                let (p, id) = (peer(), cid());
                c.opened(id, p, ip, |_| false);
                (p, id)
            })
            .collect()
    }

    #[test]
    fn p6_counts_peers_not_connections_and_starts_above_ten() {
        let ip: Multiaddr = "/ip4/10.2.0.1/tcp/1".parse().unwrap();
        let mut c = Colocation::default();
        let ten = crowd(&mut c, &ip, 10);
        // A second connection of the same peer is not an eleventh peer.
        c.opened(cid(), ten[0].0, &ip, |_| false);
        assert!(c.penalties(&HashSet::new()).is_empty(), "ten peers: no P6");
        let eleventh = crowd(&mut c, &ip, 1);
        let p = c.penalties(&HashSet::new());
        assert_eq!(p.len(), 11);
        assert!(p.values().all(|v| *v == -5.0), "eleven peers: −5 × 1² each: {p:?}");
        assert_eq!(p[&eleventh[0].0], -5.0);
        crowd(&mut c, &ip, 3);
        let p = c.penalties(&HashSet::new());
        assert!(p.values().all(|v| *v == -80.0), "fourteen peers: −5 × 4² each: {p:?}");
    }

    #[test]
    fn p6_holds_while_one_of_two_connections_stays_open() {
        // K10: one of a peer's two connections from the IP closes.
        let ip: Multiaddr = "/ip4/10.2.0.2/tcp/1".parse().unwrap();
        let mut c = Colocation::default();
        let peers = crowd(&mut c, &ip, 11);
        let (twice, first) = peers[0];
        let second = cid();
        c.opened(second, twice, &ip, |_| false);
        c.closed(first);
        let p = c.penalties(&HashSet::new());
        assert_eq!(p.len(), 11, "all eleven still counted: {p:?}");
        assert!(p.values().all(|v| *v == -5.0), "unchanged: {p:?}");
        // Its last connection closes: ten left, no P6 for anyone.
        c.closed(second);
        assert!(c.penalties(&HashSet::new()).is_empty());
    }

    #[test]
    fn p6_clears_when_every_connection_closes() {
        let ip: Multiaddr = "/ip4/10.2.0.3/tcp/1".parse().unwrap();
        let mut c = Colocation::default();
        let peers = crowd(&mut c, &ip, 12);
        assert_eq!(c.penalties(&HashSet::new()).len(), 12);
        for (_, id) in peers {
            c.closed(id);
        }
        assert!(c.penalties(&HashSet::new()).is_empty());
    }

    #[test]
    fn p6_follows_a_peer_to_its_new_ip() {
        // No transport we use reports an address change, so a peer moves by
        // connecting from the new IP and closing the old connection.
        let (old, new): (Multiaddr, Multiaddr) =
            ("/ip4/10.2.0.4/tcp/1".parse().unwrap(), "/ip6/fd00::4/tcp/1".parse().unwrap());
        let mut c = Colocation::default();
        let at_old = crowd(&mut c, &old, 11);
        let at_new = crowd(&mut c, &new, 11);
        let (mover, old_conn) = at_old[0];
        let new_conn = cid();
        c.opened(new_conn, mover, &new, |_| false);
        // On both IPs for now: 11 on the old one, 12 on the new one.
        assert_eq!(c.penalties(&HashSet::new())[&mover], -5.0 + -20.0);
        c.closed(old_conn);
        let p = c.penalties(&HashSet::new());
        assert_eq!(p[&mover], -20.0, "only the new IP's twelve now: {p:?}");
        assert!(at_old[1..].iter().all(|(q, _)| !p.contains_key(q)), "ten left on the old IP: no P6");
        assert!(at_new.iter().all(|(q, _)| p[q] == -20.0));
        // And back again.
        let back = cid();
        c.opened(back, mover, &old, |_| false);
        c.closed(new_conn);
        let p = c.penalties(&HashSet::new());
        assert_eq!(p[&mover], -5.0, "eleven on the old IP again, and not on the new one: {p:?}");
        assert!(at_old[1..].iter().all(|(q, _)| p[q] == -5.0));
        assert!(at_new.iter().all(|(q, _)| p[q] == -5.0), "eleven left on the new IP");
    }

    #[test]
    fn p6_skips_whitelisted_ips() {
        let (listed, other): (Multiaddr, Multiaddr) =
            ("/ip4/127.0.0.1/tcp/1".parse().unwrap(), "/ip4/10.2.0.5/tcp/1".parse().unwrap());
        let mut c = Colocation::default();
        crowd(&mut c, &listed, 12);
        let counted = crowd(&mut c, &other, 11);
        let whitelist: HashSet<IpAddr> = [IpAddr::from([127, 0, 0, 1])].into();
        let p = c.penalties(&whitelist);
        assert_eq!(p.len(), 11);
        assert!(counted.iter().all(|(q, _)| p[q] == -5.0));
    }

    fn s_with(a: u64, b: u64, c: u64) -> ColocationStats {
        ColocationStats { ips_over_threshold: a, max_peers_on_one_ip: b, ips_over_threshold_with_registered_peer: c }
    }

    #[test]
    fn dialable_round_trips() {
        let p = peer();
        let text = dialable(&addr(9), &p);
        assert_eq!(text, format!("/ip4/127.0.0.1/tcp/9/p2p/{p}"));
        assert_eq!(dialable(&text.parse().unwrap(), &p), text, "no doubled suffix");
        assert_eq!(split_dialable(&text), Some((p, addr(9))));
        assert_eq!(split_dialable("/ip4/127.0.0.1/tcp/9"), None);
    }
}
