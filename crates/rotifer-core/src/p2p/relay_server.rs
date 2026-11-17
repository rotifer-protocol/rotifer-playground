//! Circuit Relay v2 *server* role (ADR-304 D3; T-231 B2 design §2.2–§2.3).
//!
//! Off unless an operator turns it on (`NetworkConfig::relay_server`). A relay
//! sees the IP addresses of both ends of every circuit through it (P2P RFC
//! §8.7) and spends outbound traffic on them, so only a node whose operator
//! chose to run one serves it.
//!
//! What this module adds on top of libp2p's relay behaviour:
//! - [`RelayServerLimits`]: the design §2.2 values, with a per-IP reservation
//!   bucket, a tighter per-IP circuit bucket and a global circuit bucket;
//! - the order of the circuit rate limiters (review R3): per peer, per IP,
//!   then the global bucket **last**, so a request one IP is no longer allowed
//!   to make never takes a global token;
//! - [`RelayServerStats`]: what the relay did, by cause (review X12);
//! - [`parse_announce`]: the operator's public address, checked (design §2.3).

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr};
use std::num::NonZeroU32;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use libp2p::multiaddr::Protocol;
use libp2p::relay;
use libp2p::{Multiaddr, PeerId};
use serde::{Deserialize, Serialize};

use super::NetworkError;

/// libp2p's own per-peer limiter for reservations and circuits
/// (`relay::Config::default()`: 30 tokens, one back every 2 min). Kept as is
/// (design §2.2 "保留").
const PER_PEER: TokenBucket = TokenBucket { capacity: 30, refill_secs: 120 };

/// libp2p's own per-IP limiter for reservations and circuits
/// (`relay::Config::default()`: 60 tokens, one back every minute). Kept as is;
/// the per-IP buckets in [`RelayServerLimits`] run after it and are tighter.
const PER_IP_LIBP2P: TokenBucket = TokenBucket { capacity: 60, refill_secs: 60 };

/// Most distinct source IPs remembered for
/// [`RelayServerStats::circuits_denied_global_sources`]. Past it the count
/// stops growing (it is a lower bound) so a flood cannot grow memory.
const GLOBAL_SOURCES_CAP: usize = 4096;

/// A token bucket: `capacity` tokens, one more every `refill_secs` seconds.
/// Each accepted request takes one; a request finding none is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenBucket {
    pub capacity: u32,
    pub refill_secs: u64,
}

impl TokenBucket {
    fn checked(self, what: &str) -> Result<(NonZeroU32, Duration), NetworkError> {
        match (NonZeroU32::new(self.capacity), self.refill_secs) {
            (Some(capacity), secs) if secs > 0 => Ok((capacity, Duration::from_secs(secs))),
            _ => Err(NetworkError::Transport(format!(
                "relay server {what}: capacity and refill_secs must both be above 0 (got {} and {})",
                self.capacity, self.refill_secs
            ))),
        }
    }
}

/// Limits of the relay server (design §2.2). [`Default`] is the production
/// value set; a config that names only some fields takes the rest from it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RelayServerLimits {
    /// Reservations held at once, all peers together. Renewals are refused
    /// too once it is reached (upstream `>=` check).
    pub max_reservations: usize,
    /// Reservations per peer (upstream compares with `>`, so one more fits).
    pub max_reservations_per_peer: usize,
    /// How long a reservation lasts; clients renew after 3/4 of it.
    pub reservation_duration_secs: u64,
    /// Reservation requests per source IP, renewals included (design §2.2,
    /// review R2): 16 tokens, one back every 225 s, so one IP keeps at most
    /// about 12 reservations once they renew every 45 min.
    pub reservations_per_ip: TokenBucket,
    /// Circuits open at once, all peers together.
    pub max_circuits: usize,
    /// Circuits per source peer (upstream `>`, so one more fits).
    pub max_circuits_per_peer: usize,
    /// A circuit is closed after this long.
    pub max_circuit_duration_secs: u64,
    /// A circuit is closed once this many bytes crossed it, both directions
    /// together.
    pub max_circuit_bytes: u64,
    /// Circuit requests per source IP (review R3): 10 tokens, one back every
    /// 6 min. It runs before the global bucket, so draining the global bucket
    /// takes many IPs (60 tokens/6 s ⇒ 600 an hour ⇒ at least 60 IPs).
    pub circuits_per_ip: TokenBucket,
    /// Circuit requests, all sources together (design §2.2): 60 tokens, one
    /// back every 6 s. This caps the relay payload budget (§2.2a).
    pub circuits_global: TokenBucket,
}

impl Default for RelayServerLimits {
    fn default() -> Self {
        Self {
            max_reservations: 128,
            max_reservations_per_peer: 4,
            reservation_duration_secs: 60 * 60,
            reservations_per_ip: TokenBucket { capacity: 16, refill_secs: 225 },
            max_circuits: 16,
            max_circuits_per_peer: 4,
            max_circuit_duration_secs: 2 * 60,
            max_circuit_bytes: 128 * 1024,
            circuits_per_ip: TokenBucket { capacity: 10, refill_secs: 6 * 60 },
            circuits_global: TokenBucket { capacity: 60, refill_secs: 6 },
        }
    }
}

/// What the relay server did since the node started (review X12: what each
/// count means). All zero, and `advertising` false, when the server is off.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RelayServerStats {
    /// The relay offers the hop protocol now. libp2p turns it on only while
    /// the node has a confirmed external address (`NetworkConfig::announce`);
    /// without one every reservation fails.
    pub advertising: bool,
    /// Reservations accepted on a connection that held none.
    pub reservations_accepted: u64,
    /// Renewals of a reservation the connection already held.
    pub reservations_renewed: u64,
    /// Reservation requests the relay answered with a refusal, any cause:
    /// at capacity (`max_reservations`, renewals included), over the per-peer
    /// count, or over a rate limit.
    pub reservations_denied: u64,
    /// Refusal decisions made by a per-IP reservation bucket. A decision is
    /// counted even if the refusal could not be delivered, so this can exceed
    /// its share of `reservations_denied` by those few.
    pub reservations_denied_per_ip: u64,
    /// Reservations granted whose acceptance could not be written back (the
    /// peer reset the stream). libp2p keeps such a slot taken for as long as
    /// the connection lives (review X5); the node closes the peer's
    /// connections at once to free it.
    pub reservations_accept_failed: u64,
    /// Reservations held now: accepted minus timed out, and all of a peer's
    /// dropped when its last connection closes. libp2p does not say which
    /// connection a reservation closed on, so a peer holding reservations on
    /// several connections that closes only some of them stays counted
    /// until it times out or disconnects: an upper bound.
    pub reservations_active: u64,
    /// Circuits accepted.
    pub circuits_accepted: u64,
    /// Circuits open now: accepted minus closed (exact).
    pub circuits_active: u64,
    /// Circuits the relay cut at `max_circuit_bytes` (both directions
    /// together). Under design §2.2a 甲 this is the normal end of a circuit
    /// whose hole punch did not finish in time.
    pub circuits_closed_over_bytes: u64,
    /// Circuits the relay cut at `max_circuit_duration_secs`.
    pub circuits_closed_over_time: u64,
    /// Circuit requests the relay answered with a refusal, any cause.
    pub circuits_denied: u64,
    /// Of those, refused because the destination holds no reservation here.
    pub circuits_denied_no_reservation: u64,
    /// Refusal decisions made by a per-IP circuit bucket.
    pub circuits_denied_per_ip: u64,
    /// Refusal decisions made by the global circuit bucket. Only requests
    /// every earlier limiter allowed reach it.
    pub circuits_denied_global: u64,
    /// Distinct source IPs among `circuits_denied_global` (a lower bound past
    /// 4096). Few IPs and many refusals reads as abuse; many IPs reads as
    /// real demand outgrowing the bucket (review R3 trigger line).
    pub circuits_denied_global_sources: u64,
}

/// Shared between the event loop, the rate limiters and the sync API.
pub(crate) type SharedRelayStats = Arc<Mutex<RelayServerStats>>;

/// Which counter a rate limiter's refusal goes to.
#[derive(Debug, Clone, Copy)]
enum Cause {
    /// Counted only through the relay's own refusal events.
    Uncounted,
    ReservationPerIp,
    CircuitPerIp,
}

/// A libp2p rate limiter that counts its refusals.
struct Counted {
    inner: Box<dyn relay::RateLimiter>,
    cause: Cause,
    stats: SharedRelayStats,
}

impl relay::RateLimiter for Counted {
    fn try_next(&mut self, peer: PeerId, addr: &Multiaddr, now: Instant) -> bool {
        let allowed = self.inner.try_next(peer, addr, now);
        if !allowed && let Ok(mut s) = self.stats.lock() {
            match self.cause {
                Cause::Uncounted => {}
                Cause::ReservationPerIp => s.reservations_denied_per_ip += 1,
                Cause::CircuitPerIp => s.circuits_denied_per_ip += 1,
            }
        }
        allowed
    }
}

/// A token bucket that keeps fractions of a refill period across calls, so a
/// steady `1 / refill` tokens a second come back however requests are timed.
/// (libp2p's own bucket restarts the period at each refill and drops the
/// remainder, so its long-run rate depends on when requests arrive and can
/// fall well below `1 / refill`: the design §2.2 arithmetic would not hold.)
#[derive(Debug, Clone, Copy)]
struct Bucket {
    capacity: u32,
    refill: Duration,
    tokens: u32,
    /// Start of the refill period now running.
    since: Instant,
}

impl Bucket {
    fn full(capacity: NonZeroU32, refill: Duration, now: Instant) -> Self {
        Self { capacity: capacity.get(), refill, tokens: capacity.get(), since: now }
    }

    /// Add the tokens earned since the last call.
    fn refill(&mut self, now: Instant) {
        if self.tokens >= self.capacity {
            // A full bucket earns nothing: the next token is one refill
            // period after the bucket stops being full.
            self.since = now;
            return;
        }
        let elapsed = now.saturating_duration_since(self.since);
        let earned = elapsed.as_nanos() / self.refill.as_nanos().max(1);
        if earned == 0 {
            return;
        }
        let total = u128::from(self.tokens) + earned;
        if total >= u128::from(self.capacity) {
            self.tokens = self.capacity;
            self.since = now;
        } else {
            // `earned` < capacity here, so it fits in a u32.
            self.tokens = total as u32;
            self.since += self.refill * earned as u32;
        }
    }

    /// Take a token if there is one.
    fn take(&mut self, now: Instant) -> bool {
        self.refill(now);
        if self.tokens == 0 {
            return false;
        }
        self.tokens -= 1;
        true
    }
}

/// One bucket for all circuit requests, whoever sends them (design §2.2).
/// libp2p only ships per-peer and per-IP buckets.
pub(crate) struct GlobalBucket {
    bucket: Bucket,
    stats: SharedRelayStats,
    denied_sources: HashSet<IpAddr>,
}

impl GlobalBucket {
    pub(crate) fn new(capacity: NonZeroU32, refill: Duration, stats: SharedRelayStats) -> Self {
        Self { bucket: Bucket::full(capacity, refill, Instant::now()), stats, denied_sources: HashSet::new() }
    }
}

impl relay::RateLimiter for GlobalBucket {
    fn try_next(&mut self, _peer: PeerId, addr: &Multiaddr, now: Instant) -> bool {
        let allowed = self.bucket.take(now);
        if !allowed {
            if self.denied_sources.len() < GLOBAL_SOURCES_CAP
                && let Some(ip) = ip_of(addr)
            {
                self.denied_sources.insert(ip);
            }
            if let Ok(mut s) = self.stats.lock() {
                s.circuits_denied_global += 1;
                s.circuits_denied_global_sources = self.denied_sources.len() as u64;
            }
        }
        allowed
    }
}

/// One [`Bucket`] per source IP. A request whose address carries no IP is
/// allowed, as libp2p's per-IP limiter does (relayed requests are refused
/// earlier anyway).
pub(crate) struct PerIpBucket {
    capacity: NonZeroU32,
    refill: Duration,
    /// Only IPs whose bucket is not full: a missing entry is a full bucket.
    buckets: std::collections::HashMap<IpAddr, Bucket>,
    calls: u32,
}

impl PerIpBucket {
    pub(crate) fn new(capacity: NonZeroU32, refill: Duration) -> Self {
        Self { capacity, refill, buckets: std::collections::HashMap::new(), calls: 0 }
    }

    fn take(&mut self, ip: IpAddr, now: Instant) -> bool {
        // Now and then forget IPs whose bucket has refilled, so memory tracks
        // the IPs active within one bucket's refill time, not all ever seen.
        self.calls = self.calls.wrapping_add(1);
        if self.calls.is_multiple_of(256) {
            self.buckets.retain(|_, b| {
                b.refill(now);
                b.tokens < b.capacity
            });
        }
        let (capacity, refill) = (self.capacity, self.refill);
        self.buckets.entry(ip).or_insert_with(|| Bucket::full(capacity, refill, now)).take(now)
    }
}

impl relay::RateLimiter for PerIpBucket {
    fn try_next(&mut self, _peer: PeerId, addr: &Multiaddr, now: Instant) -> bool {
        match ip_of(addr) {
            Some(ip) => self.take(ip, now),
            None => true,
        }
    }
}

fn ip_of(addr: &Multiaddr) -> Option<IpAddr> {
    addr.iter().find_map(|p| match p {
        Protocol::Ip4(ip) => Some(IpAddr::V4(ip)),
        Protocol::Ip6(ip) => Some(IpAddr::V6(ip)),
        _ => None,
    })
}

/// Wrap the limiter a `relay::Config` builder just pushed.
fn count_last(limiters: &mut Vec<Box<dyn relay::RateLimiter>>, cause: Cause, stats: &SharedRelayStats) {
    if let Some(inner) = limiters.pop() {
        limiters.push(Box::new(Counted { inner, cause, stats: Arc::clone(stats) }));
    }
}

impl RelayServerLimits {
    /// Reject values libp2p would panic on or that make no sense.
    pub(crate) fn validate(&self) -> Result<(), NetworkError> {
        self.reservations_per_ip.checked("reservations_per_ip")?;
        self.circuits_per_ip.checked("circuits_per_ip")?;
        self.circuits_global.checked("circuits_global")?;
        // libp2p: 0 s is an immediate timeout, and the circuit duration must
        // fit in a u32 of seconds; 0 bytes means unlimited.
        if self.reservation_duration_secs == 0
            || self.max_circuit_duration_secs == 0
            || self.max_circuit_duration_secs > u64::from(u32::MAX)
            || self.max_circuit_bytes == 0
        {
            return Err(NetworkError::Transport(
                "relay server: reservation_duration_secs, max_circuit_duration_secs and max_circuit_bytes must be above 0"
                    .into(),
            ));
        }
        Ok(())
    }

    /// The libp2p relay configuration, its rate limiters counting into
    /// `stats`. Circuit limiters run in this order, each only if all before
    /// it allowed the request (`.all(..)`): per peer, per IP (libp2p's, then
    /// [`Self::circuits_per_ip`]), global. Reservations: per peer, per IP
    /// (libp2p's, then [`Self::reservations_per_ip`]). The buckets this module
    /// adds keep fractions of a period (see [`Bucket`]), so their long-run
    /// rate is exactly `1 / refill_secs`. Call [`Self::validate`] first.
    pub(crate) fn relay_config(&self, stats: &SharedRelayStats) -> relay::Config {
        let bucket = |b: TokenBucket| b.checked("limit").expect("validated before building");
        let mut config = relay::Config {
            max_reservations: self.max_reservations,
            max_reservations_per_peer: self.max_reservations_per_peer,
            reservation_duration: Duration::from_secs(self.reservation_duration_secs),
            reservation_rate_limiters: Vec::new(),
            max_circuits: self.max_circuits,
            max_circuits_per_peer: self.max_circuits_per_peer,
            max_circuit_duration: Duration::from_secs(self.max_circuit_duration_secs),
            max_circuit_bytes: self.max_circuit_bytes,
            circuit_src_rate_limiters: Vec::new(),
        };

        let (n, t) = bucket(PER_PEER);
        config = config.reservation_rate_per_peer(n, t);
        count_last(&mut config.reservation_rate_limiters, Cause::Uncounted, stats);
        let (n, t) = bucket(PER_IP_LIBP2P);
        config = config.reservation_rate_per_ip(n, t);
        count_last(&mut config.reservation_rate_limiters, Cause::ReservationPerIp, stats);
        let (n, t) = bucket(self.reservations_per_ip);
        config.reservation_rate_limiters.push(Box::new(PerIpBucket::new(n, t)));
        count_last(&mut config.reservation_rate_limiters, Cause::ReservationPerIp, stats);

        let (n, t) = bucket(PER_PEER);
        config = config.circuit_src_per_peer(n, t);
        count_last(&mut config.circuit_src_rate_limiters, Cause::Uncounted, stats);
        let (n, t) = bucket(PER_IP_LIBP2P);
        config = config.circuit_src_per_ip(n, t);
        count_last(&mut config.circuit_src_rate_limiters, Cause::CircuitPerIp, stats);
        let (n, t) = bucket(self.circuits_per_ip);
        config.circuit_src_rate_limiters.push(Box::new(PerIpBucket::new(n, t)));
        count_last(&mut config.circuit_src_rate_limiters, Cause::CircuitPerIp, stats);
        // Last (review R3): only requests the per-peer and per-IP buckets let
        // through can take a global token.
        let (n, t) = bucket(self.circuits_global);
        config
            .circuit_src_rate_limiters
            .push(Box::new(GlobalBucket::new(n, t, Arc::clone(stats))));
        config
    }
}

/// Whether `ip` is a public IPv4 unicast address: not private, loopback,
/// link-local, shared (CGNAT), documentation, benchmarking, multicast,
/// reserved, broadcast or "this network". (`Ipv4Addr::is_global` is unstable.)
fn is_global_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || a == 0
        || (a == 100 && (64..128).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 198 && (18..20).contains(&b))
        || a >= 240)
}

/// Parse `NetworkConfig::announce` (design §2.3): each entry exactly
/// `/ip4/<public IPv4>/tcp/<port>`. DNS names are refused (this build has no
/// DNS transport, so peers could not dial them, and nothing would say so);
/// private and loopback addresses are refused (peers elsewhere cannot reach
/// them) unless `allow_loopback` (tests), which admits 127.0.0.0/8 only.
pub(crate) fn parse_announce(entries: &[String], allow_loopback: bool) -> Result<Vec<Multiaddr>, NetworkError> {
    entries
        .iter()
        .map(|raw| {
            let bad = |why: &str| NetworkError::Transport(format!("announce address {raw}: {why}"));
            let addr: Multiaddr = raw.parse().map_err(|e| bad(&format!("{e}")))?;
            let parts: Vec<Protocol> = addr.iter().collect();
            let (ip, port) = match parts.as_slice() {
                [Protocol::Ip4(ip), Protocol::Tcp(port)] => (*ip, *port),
                [Protocol::Dns(_) | Protocol::Dns4(_) | Protocol::Dns6(_) | Protocol::Dnsaddr(_), ..] => {
                    return Err(bad("DNS names cannot be dialled by this build; use /ip4/<public IP>/tcp/<port>"));
                }
                _ => return Err(bad("must be exactly /ip4/<public IP>/tcp/<port>")),
            };
            if port == 0 {
                return Err(bad("port 0 is not a reachable port"));
            }
            if !(is_global_v4(ip) || (allow_loopback && ip.is_loopback())) {
                return Err(bad("not a public IPv4 address; peers elsewhere could not reach it"));
            }
            Ok(addr)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats() -> SharedRelayStats {
        Arc::new(Mutex::new(RelayServerStats::default()))
    }

    // PR-① test 8: what `announce` accepts and refuses.
    #[test]
    fn announce_accepts_only_public_ipv4_tcp() {
        let ok = parse_announce(&["/ip4/203.0.114.7/tcp/9878".into(), "/ip4/8.8.8.8/tcp/1".into()], false)
            .expect("public IPv4 + TCP is accepted");
        assert_eq!(ok.len(), 2);

        for bad in [
            "/dns4/relay.example.org/tcp/9878",
            "/dns6/relay.example.org/tcp/9878",
            "/dnsaddr/relay.example.org",
            "/dns/relay.example.org/tcp/9878",
            "/ip4/10.1.2.3/tcp/9878",
            "/ip4/172.16.0.1/tcp/9878",
            "/ip4/192.168.1.1/tcp/9878",
            "/ip4/100.64.0.1/tcp/9878",
            "/ip4/169.254.1.1/tcp/9878",
            "/ip4/127.0.0.1/tcp/9878",
            "/ip4/0.0.0.0/tcp/9878",
            "/ip4/203.0.113.5/tcp/9878",
            "/ip4/198.18.0.1/tcp/9878",
            "/ip4/224.0.0.1/tcp/9878",
            "/ip4/255.255.255.255/tcp/9878",
            "/ip4/8.8.8.8/tcp/0",
            "/ip4/8.8.8.8/udp/9878/quic-v1",
            "/ip6/2001:4860::8888/tcp/9878",
            "/ip4/8.8.8.8/tcp/9878/p2p/12D3KooWD3eckifWpRn9wQpMG9R9hX3sD158z7EqHWmweQAJU5SA",
            "not a multiaddr",
        ] {
            let err = parse_announce(&[bad.into()], false).expect_err(bad);
            assert!(err.to_string().contains(bad), "the error names the entry: {err}");
        }
        assert!(
            parse_announce(&["/dns4/relay.example.org/tcp/9878".into()], false)
                .unwrap_err()
                .to_string()
                .contains("DNS"),
            "a DNS name says why"
        );
    }

    #[test]
    fn announce_admits_loopback_only_behind_the_test_switch() {
        assert!(parse_announce(&["/ip4/127.0.0.1/tcp/4001".into()], true).is_ok());
        assert!(parse_announce(&["/ip4/127.0.0.1/tcp/4001".into()], false).is_err());
        assert!(
            parse_announce(&["/ip4/192.168.1.1/tcp/4001".into()], true).is_err(),
            "the switch admits loopback, not private addresses"
        );
    }

    // The design §2.2 values, pinned: changing one is an ADR-304 decision.
    #[test]
    fn default_limits_are_the_design_values() {
        let d = RelayServerLimits::default();
        assert_eq!(
            (d.max_reservations, d.max_reservations_per_peer, d.reservation_duration_secs),
            (128, 4, 3600)
        );
        assert_eq!(d.reservations_per_ip, TokenBucket { capacity: 16, refill_secs: 225 });
        assert_eq!(
            (d.max_circuits, d.max_circuits_per_peer, d.max_circuit_duration_secs, d.max_circuit_bytes),
            (16, 4, 120, 131_072)
        );
        assert_eq!(d.circuits_per_ip, TokenBucket { capacity: 10, refill_secs: 360 });
        assert_eq!(d.circuits_global, TokenBucket { capacity: 60, refill_secs: 6 });
        d.validate().expect("the defaults are valid");
        // A partial config takes the rest from the defaults.
        let partial: RelayServerLimits = serde_json::from_str(r#"{"max_reservations":2}"#).expect("parse");
        assert_eq!(partial, RelayServerLimits { max_reservations: 2, ..RelayServerLimits::default() });
    }

    #[test]
    fn limits_libp2p_would_panic_on_are_refused() {
        let zero = TokenBucket { capacity: 0, refill_secs: 1 };
        let never = TokenBucket { capacity: 1, refill_secs: 0 };
        for bad in [
            RelayServerLimits { circuits_global: zero, ..Default::default() },
            RelayServerLimits { circuits_per_ip: never, ..Default::default() },
            RelayServerLimits { reservations_per_ip: zero, ..Default::default() },
            RelayServerLimits { max_circuit_duration_secs: 0, ..Default::default() },
            RelayServerLimits { max_circuit_bytes: 0, ..Default::default() },
            RelayServerLimits { reservation_duration_secs: 0, ..Default::default() },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
    }

    #[test]
    fn global_bucket_refills_one_token_per_period_up_to_capacity() {
        let t0 = Instant::now();
        let mut b = Bucket::full(NonZeroU32::new(2).unwrap(), Duration::from_secs(10), t0);
        assert!(b.take(t0));
        assert!(b.take(t0));
        assert!(!b.take(t0), "empty");
        assert!(!b.take(t0 + Duration::from_secs(9)), "not a full period yet");
        assert!(b.take(t0 + Duration::from_secs(10)), "one token back after one period");
        assert!(!b.take(t0 + Duration::from_secs(11)));
        // A long idle refills to capacity, no further.
        let later = t0 + Duration::from_secs(1000);
        assert!(b.take(later));
        assert!(b.take(later));
        assert!(!b.take(later), "never more than capacity");
        // The partial period carries over: 15 s after emptying is one token
        // (10 s) and 5 s towards the next.
        assert!(b.take(later + Duration::from_secs(15)));
        assert!(b.take(later + Duration::from_secs(20)), "the carried 5 s count");
    }

    // The design §2.2 arithmetic (one IP keeps `refill rate ÷ renewal rate`
    // reservations) needs the long-run rate to be exactly 1 / refill however
    // requests are timed. Here demand (one every 3 s) outruns supply (one
    // every 4 s), so the bucket never fills: 40 requests over 117 s get the
    // 2 tokens it started with plus floor(117 / 4) = 29. libp2p's bucket,
    // which restarts the period at each refill, would grant 21.
    #[test]
    fn bucket_keeps_fractions_of_a_period() {
        let t0 = Instant::now();
        let two = NonZeroU32::new(2).unwrap();
        let mut b = Bucket::full(two, Duration::from_secs(4), t0);
        let granted = (0..40u64).filter(|i| b.take(t0 + Duration::from_secs(3 * i))).count();
        assert_eq!(granted, 31);
        let mut per_ip = PerIpBucket::new(two, Duration::from_secs(4));
        let (a, c): (IpAddr, IpAddr) = ([1, 2, 3, 4].into(), [5, 6, 7, 8].into());
        let granted = (0..40u64).filter(|i| per_ip.take(a, t0 + Duration::from_secs(3 * i))).count();
        assert_eq!(granted, 31, "the same per IP");
        assert!(per_ip.take(c, t0 + Duration::from_secs(117)), "another IP has its own bucket");
    }

    #[test]
    fn global_bucket_counts_refusals_and_distinct_sources() {
        let s = stats();
        let mut b = GlobalBucket::new(NonZeroU32::new(1).unwrap(), Duration::from_secs(3600), Arc::clone(&s));
        let a: Multiaddr = "/ip4/1.2.3.4/tcp/1".parse().unwrap();
        let c: Multiaddr = "/ip4/5.6.7.8/tcp/1".parse().unwrap();
        let p = PeerId::random();
        let now = Instant::now();
        assert!(relay::RateLimiter::try_next(&mut b, p, &a, now));
        for addr in [&a, &a, &c] {
            assert!(!relay::RateLimiter::try_next(&mut b, p, addr, now));
        }
        let got = *s.lock().unwrap();
        assert_eq!((got.circuits_denied_global, got.circuits_denied_global_sources), (3, 2));
    }

    // Review R3: the global bucket runs last, so requests a per-IP bucket
    // refuses take no global token.
    #[test]
    fn global_bucket_runs_after_the_per_ip_buckets() {
        let s = stats();
        let limits = RelayServerLimits {
            circuits_per_ip: TokenBucket { capacity: 3, refill_secs: 3600 },
            circuits_global: TokenBucket { capacity: 5, refill_secs: 3600 },
            ..Default::default()
        };
        let mut config = limits.relay_config(&s);
        let now = Instant::now();
        let flood: Multiaddr = "/ip4/1.2.3.4/tcp/1".parse().unwrap();
        let mut allowed = 0;
        for _ in 0..20 {
            let src = PeerId::random();
            if config.circuit_src_rate_limiters.iter_mut().all(|l| l.try_next(src, &flood, now)) {
                allowed += 1;
            }
        }
        assert_eq!(allowed, 3, "one IP gets its per-IP share");
        let got = *s.lock().unwrap();
        assert_eq!(got.circuits_denied_per_ip, 17);
        assert_eq!(got.circuits_denied_global, 0, "the flood took only 3 global tokens");
        // The other 2 global tokens are left for everyone else.
        let other: Multiaddr = "/ip4/5.6.7.8/tcp/1".parse().unwrap();
        for _ in 0..2 {
            let src = PeerId::random();
            assert!(config.circuit_src_rate_limiters.iter_mut().all(|l| l.try_next(src, &other, now)));
        }
        let src = PeerId::random();
        assert!(!config.circuit_src_rate_limiters.iter_mut().all(|l| l.try_next(src, &other, now)));
        assert_eq!(s.lock().unwrap().circuits_denied_global, 1);
    }
}
