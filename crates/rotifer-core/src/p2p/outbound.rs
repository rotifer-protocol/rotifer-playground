//! Connection policy, part 1 (A6, ADR-304 D2 revision): the bootstrap
//! keeper and the same-IP counters.
//!
//! - The **keeper** redials a bootstrap node as soon as none is connected
//!   (P2P RFC §8.5 item 1), one at a time, backing off to [`KEEPER_BACKOFF_MAX`].
//! - [`Colocation`] keeps the cumulative same-IP counters that tell when the
//!   P6 trade-off needs reopening.
//!
//! Top-up of self-chosen outbound peers and the dialled-OK level of the peer
//! store are A6 part 2.
//!
//! Everything here is plain state driven by the event loop in `node.rs`, with
//! time passed in, so it is unit-tested without a network.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::time::{Duration, Instant};

use libp2p::multiaddr::Protocol;
use libp2p::swarm::ConnectionId;
use libp2p::{Multiaddr, PeerId};
use serde::Serialize;

/// Jitter on backoffs: ±20 %.
pub(crate) const JITTER: f64 = 0.2;
/// Keeper backoff between failed bootstrap dials: 1, 2, 4, 8, 16 s ±[`JITTER`].
pub(crate) const KEEPER_BACKOFF_FIRST: Duration = Duration::from_secs(1);
pub(crate) const KEEPER_BACKOFF_MAX: Duration = Duration::from_secs(16);
/// Fallback check of the keeper, besides reacting to a closed connection.
pub(crate) const KEEPER_CHECK_INTERVAL: Duration = Duration::from_secs(5);
/// Small PRNG (splitmix64). Jitter needs randomness, not cryptographic
/// strength, and a seed makes the unit tests repeatable.
pub(crate) struct Rng(u64);

impl Rng {
    /// A fixed seed, for repeatable unit tests.
    #[cfg(test)]
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

    /// Uniform in `[0, 1)`.
    fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// `d` scaled by a factor uniform in `[1 − JITTER, 1 + JITTER)`.
    pub(crate) fn jitter(&mut self, d: Duration) -> Duration {
        d.mul_f64(1.0 - JITTER + 2.0 * JITTER * self.unit())
    }
}

/// `first`, doubled per earlier failure, capped at `max`.
fn doubled(first: Duration, failures: u32, max: Duration) -> Duration {
    first.saturating_mul(1u32 << failures.min(16)).min(max)
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

    pub(crate) fn succeeded(&mut self) {
        self.in_flight = None;
        self.failures = 0;
        self.retry_at = None;
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

/// Same-IP peer count above which GossipSub's P6 starts to penalise
/// (`ip_colocation_factor_threshold`).
pub(crate) const P6_THRESHOLD: f64 = 10.0;
/// P6 weight: each peer on an IP over the threshold gets weight × surplus².
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

/// Connected peers by IP, feeding [`ColocationStats`].
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
}

// ---------------------------------------------------------------------
// Event-loop state
// ---------------------------------------------------------------------

/// The policy's state in the event loop.
pub(crate) struct Outbound {
    /// Bootstrap dials in flight, by configured index.
    pending: HashMap<ConnectionId, usize>,
    pub(crate) keeper: Keeper,
    pub(crate) rng: Rng,
}

impl Outbound {
    pub(crate) fn new(keeper: Keeper, rng: Rng) -> Self {
        Self { pending: HashMap::new(), keeper, rng }
    }

    /// A dial to bootstrap address `index` went out as `id`.
    pub(crate) fn dialing(&mut self, id: ConnectionId, index: usize) {
        self.pending.insert(id, index);
    }

    /// A connection was established.
    pub(crate) fn established(&mut self, id: ConnectionId, peer: PeerId) {
        let Some(index) = self.pending.remove(&id) else { return };
        self.keeper.learn(index, peer);
        if self.keeper.is_in_flight(id) {
            self.keeper.succeeded();
        }
    }

    /// A dial failed.
    pub(crate) fn dial_failed(&mut self, id: ConnectionId, now: Instant) {
        if self.pending.remove(&id).is_some() && self.keeper.is_in_flight(id) {
            self.keeper.failed(now, &mut self.rng);
        }
    }

    /// A connection closed; `remaining` connections to `peer` are left.
    /// Returns whether it was a bootstrap node's last connection.
    pub(crate) fn closed(&self, peer: &PeerId, remaining: u32) -> bool {
        remaining == 0 && self.keeper.is_bootstrap(peer)
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
        Outbound::new(Keeper::new(boot, start), Rng::new(7))
    }

    #[test]
    fn constants_are_the_designed_ones() {
        assert_eq!((KEEPER_BACKOFF_FIRST, KEEPER_BACKOFF_MAX), (Duration::from_secs(1), Duration::from_secs(16)));
        assert_eq!(KEEPER_CHECK_INTERVAL, Duration::from_secs(5));
        assert_eq!(JITTER, 0.2);
    }

    #[test]
    fn bootstrap_peer_id_is_learned_and_its_last_close_reported() {
        let now = Instant::now();
        let mut o = outbound(vec![addr(1)], now);
        let (boot, other) = (peer(), peer());
        let c = cid();
        o.dialing(c, 0);
        o.established(c, boot);
        // A connection that is not a bootstrap dial teaches nothing.
        o.established(cid(), other);
        assert!(o.keeper.is_bootstrap(&boot), "the bootstrap PeerId is learned on the first dial");
        assert!(!o.keeper.is_bootstrap(&other));
        assert!(!o.closed(&boot, 1), "one connection left");
        assert!(o.closed(&boot, 0), "a bootstrap node's last connection");
        assert!(!o.closed(&other, 0), "not a bootstrap node");
    }

    #[test]
    fn a_failed_keeper_dial_backs_off_and_a_successful_one_resets() {
        let start = Instant::now();
        let mut o = outbound(vec![addr(1)], start);
        let now = start + KEEPER_CHECK_INTERVAL;
        let (i, _, _) = o.keeper.due(now, 0).expect("due");
        let c = cid();
        o.dialing(c, i);
        o.keeper.started(c);
        // A failure of some other dial leaves the keeper alone.
        o.dial_failed(cid(), now);
        assert!(o.keeper.is_in_flight(c));
        o.dial_failed(c, now);
        assert!(!o.keeper.is_in_flight(c));
        assert!(o.keeper.retry_at().is_some_and(|at| at > now), "backing off");
        let later = o.keeper.retry_at().unwrap();
        let (i, _, _) = o.keeper.due(later, 0).expect("due again after the backoff");
        let c = cid();
        o.dialing(c, i);
        o.keeper.started(c);
        o.established(c, peer());
        assert!(o.keeper.retry_at().is_none(), "a success clears the backoff");
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
        k.succeeded();
        assert!(k.due(now, 1).is_none(), "one connected bootstrap is enough");
        assert!(k.due(now, 0).is_some(), "dropping to zero dials at once");
        assert_eq!(k.dials(), 8);
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

    fn s_with(a: u64, b: u64, c: u64) -> ColocationStats {
        ColocationStats { ips_over_threshold: a, max_peers_on_one_ip: b, ips_over_threshold_with_registered_peer: c }
    }
}
