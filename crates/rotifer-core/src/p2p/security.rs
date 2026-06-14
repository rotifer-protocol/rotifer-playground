//! A.5 — application-layer P2P security primitives.
//!
//! These are the Cloud-independent defences from the protocol's security model
//! (RFC §8) — the parts that need only the local node, no Cloud attestation:
//!   - per-peer rate limiting (flood defence, §8.6);
//!   - message-nonce de-duplication (replay defence, §6.4 — pairs with the
//!     timestamp-freshness check in `messages.rs`, which bounds the window this
//!     cache de-dupes within);
//!   - bootstrap-connectivity floor (eclipse resistance, §8.5);
//!   - anonymous-peer Sybil throttling (§8.4), fail-closed.
//!
//! Deferred to a follow-up (need real libp2p keys / Cloud): Ed25519 message-
//! envelope signature verification + real PeerId derivation (tested against
//! real nodes), and Cloud-issued proof-of-registration verification.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::LazyLock;
use std::time::Instant;

use super::{NetworkError, PeerId};

/// Per-peer rate limit (msgs / second).
pub const RATE_LIMIT_PER_PEER_PER_SEC: u32 = 10;

/// Anti-replay timestamp window (seconds). Messages outside this window are
/// rejected up front by `messages::is_timestamp_fresh`; the nonce cache below
/// de-dupes replays *within* the window.
pub const ANTI_REPLAY_WINDOW_SECS: u64 = 300;

/// Bootstrap peer connectivity floor — at least N must be reachable for `active`.
pub const BOOTSTRAP_CONNECTIVITY_FLOOR: usize = 2;

/// Width of the per-peer rate-limit window, in milliseconds.
const RATE_WINDOW_MS: u64 = 1000;

/// Upper bound on the replay-nonce cache (bounded LRU, RFC §6.4).
const NONCE_CACHE_CAP: usize = 10_000;

/// Monotonic milliseconds since first use — drives the real-time rate limiter.
/// Relative (not wall-clock) on purpose: rate limiting only needs monotonicity.
fn now_millis() -> u64 {
    static START: LazyLock<Instant> = LazyLock::new(Instant::now);
    START.elapsed().as_millis() as u64
}

pub fn derive_peer_id_from_pubkey(pubkey: &[u8]) -> PeerId {
    // Deferred: libp2p's official derivation (multihash of the public key),
    // landing with the real-node signature-forgery test. Placeholder: sha256
    // hex prefix — deterministic, which is all A.5.1 asserts.
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(pubkey);
    PeerId(format!("rt_{}", &hex::encode(hash)[..16]))
}

#[derive(Debug, Default)]
pub struct Security {
    pub known_peers: Vec<PeerId>,
    /// Per-peer recent message arrival times (millis), for rate limiting.
    msg_times: HashMap<PeerId, VecDeque<u64>>,
    /// Bootstrap peers currently reachable (eclipse-resistance floor).
    reachable_bootstraps: HashSet<PeerId>,
    /// Recently-seen message nonces (replay rejection), FIFO-bounded.
    seen_nonces: HashSet<Vec<u8>>,
    nonce_order: VecDeque<Vec<u8>>,
}

impl Security {
    pub fn new() -> Self {
        Self::default()
    }

    // -- flood defence (§8.6): per-peer sliding-window rate limit --------------

    /// Record a message from `peer` at `now_millis`, enforcing the per-peer
    /// rate ceiling within a 1s sliding window. `Err` once the ceiling is hit.
    /// Time is a parameter so the policy is deterministic under test.
    pub fn record_message_at(&mut self, peer: &PeerId, now_millis: u64) -> Result<(), NetworkError> {
        let window = self.msg_times.entry(peer.clone()).or_default();
        while let Some(&front) = window.front() {
            if now_millis.saturating_sub(front) >= RATE_WINDOW_MS {
                window.pop_front();
            } else {
                break;
            }
        }
        if window.len() as u32 >= RATE_LIMIT_PER_PEER_PER_SEC {
            return Err(NetworkError::Transport(format!(
                "rate limit exceeded for peer {} ({}/s)",
                peer.0, RATE_LIMIT_PER_PEER_PER_SEC
            )));
        }
        window.push_back(now_millis);
        Ok(())
    }

    /// Real-time entry point for the node's receive path.
    pub fn record_message(&mut self, peer: &PeerId) -> Result<(), NetworkError> {
        self.record_message_at(peer, now_millis())
    }

    // -- replay defence (§6.4): bounded nonce de-duplication ------------------

    /// Accept a message nonce the first time it is seen; reject any replay.
    /// The cache is FIFO-bounded to `NONCE_CACHE_CAP` entries.
    pub fn check_and_record_nonce(&mut self, nonce: &[u8]) -> Result<(), NetworkError> {
        if self.seen_nonces.contains(nonce) {
            return Err(NetworkError::Transport(
                "replayed message nonce rejected".into(),
            ));
        }
        self.seen_nonces.insert(nonce.to_vec());
        self.nonce_order.push_back(nonce.to_vec());
        if self.nonce_order.len() > NONCE_CACHE_CAP
            && let Some(evicted) = self.nonce_order.pop_front()
        {
            self.seen_nonces.remove(&evicted);
        }
        Ok(())
    }

    // -- eclipse defence (§8.5): bootstrap-connectivity floor -----------------

    pub fn mark_bootstrap_reachable(&mut self, peer: PeerId) {
        self.reachable_bootstraps.insert(peer);
    }

    pub fn mark_bootstrap_unreachable(&mut self, peer: &PeerId) {
        self.reachable_bootstraps.remove(peer);
    }

    pub fn bootstrap_reachable(&self) -> usize {
        self.reachable_bootstraps.len()
    }

    /// Whether enough distinct bootstrap anchors are reachable to resist an
    /// eclipse (a single attacker-controlled peer cannot isolate the node).
    pub fn is_eclipse_safe(&self) -> bool {
        self.bootstrap_reachable() >= BOOTSTRAP_CONNECTIVITY_FLOOR
    }

    // -- Sybil defence (§8.4): anonymous-peer throttle ------------------------

    /// Decide whether `peer` is an attested (registered) node. Fail-closed: a
    /// peer is attested only with a proof we can *verify*, and verifying a proof
    /// requires the Cloud issuer (rotifer.dev JWT), which is deferred. Until
    /// then every peer is unattested and the caller must apply the stricter
    /// anonymous rate limit. The no-proof path is the real Cloud-independent
    /// decision; the present-proof path stays fail-closed (never trust an
    /// unverifiable attestation).
    pub fn check_sybil_proof(&self, peer: &PeerId, proof: Option<&[u8]>) -> Result<(), NetworkError> {
        let reason = match proof {
            None => "no proof-of-registration",
            Some(_) => "proof-of-registration unverifiable without Cloud",
        };
        Err(NetworkError::Transport(format!(
            "peer {} is unattested ({reason}); throttle as anonymous",
            peer.0
        )))
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // A.5.1 — PeerId derivation determinism
    // -----------------------------------------------------------------
    #[test]
    fn A_5_1_peer_id_derivation_is_deterministic() {
        let pubkey = b"some-public-key-bytes";
        let p1 = derive_peer_id_from_pubkey(pubkey);
        let p2 = derive_peer_id_from_pubkey(pubkey);
        assert_eq!(p1, p2, "same pubkey → same PeerId");
    }

    #[test]
    fn A_5_1_peer_id_differs_for_different_keys() {
        let p1 = derive_peer_id_from_pubkey(b"key-a");
        let p2 = derive_peer_id_from_pubkey(b"key-b");
        assert_ne!(p1, p2, "different pubkeys → different PeerIds");
    }

    // -----------------------------------------------------------------
    // A.5.2 — Anti-replay: a re-seen nonce is rejected (§6.4)
    // -----------------------------------------------------------------
    #[test]
    fn A_5_2_replayed_nonce_rejected() {
        let mut sec = Security::new();
        assert!(sec.check_and_record_nonce(b"nonce-1").is_ok(), "first sighting accepted");
        assert!(
            sec.check_and_record_nonce(b"nonce-1").is_err(),
            "replay of the same nonce rejected"
        );
        assert!(sec.check_and_record_nonce(b"nonce-2").is_ok(), "a distinct nonce is accepted");
    }

    // -----------------------------------------------------------------
    // A.5.3 — Rate limit: 11th message in a 1s window dropped (§8.6)
    // -----------------------------------------------------------------
    #[test]
    fn A_5_3_rate_limit_drops_eleventh_message() {
        let mut sec = Security::new();
        let peer = PeerId("noisy".into());

        let mut accepted = 0_u32;
        let mut dropped = 0_u32;
        for _ in 0..11 {
            match sec.record_message_at(&peer, 0) {
                Ok(()) => accepted += 1,
                Err(_) => dropped += 1,
            }
        }
        assert_eq!(accepted, RATE_LIMIT_PER_PEER_PER_SEC, "exactly 10 accepted in the window");
        assert_eq!(dropped, 1, "the 11th is dropped");
    }

    #[test]
    fn A_5_3_rate_limit_window_slides_after_one_second() {
        let mut sec = Security::new();
        let peer = PeerId("steady".into());
        for _ in 0..RATE_LIMIT_PER_PEER_PER_SEC {
            assert!(sec.record_message_at(&peer, 0).is_ok());
        }
        assert!(sec.record_message_at(&peer, 0).is_err(), "budget exhausted in-window");
        assert!(
            sec.record_message_at(&peer, RATE_WINDOW_MS).is_ok(),
            "the window slid → budget refreshed"
        );
    }

    #[test]
    fn A_5_3_rate_limit_is_per_peer() {
        let mut sec = Security::new();
        let a = PeerId("a".into());
        let b = PeerId("b".into());
        for _ in 0..RATE_LIMIT_PER_PEER_PER_SEC {
            let _ = sec.record_message_at(&a, 0);
        }
        assert!(sec.record_message_at(&a, 0).is_err(), "peer a exhausted");
        assert!(sec.record_message_at(&b, 0).is_ok(), "peer b has its own budget");
    }

    // -----------------------------------------------------------------
    // A.5.4 — Sybil defence: unattested peer throttled (§8.4)
    // -----------------------------------------------------------------
    #[test]
    fn A_5_4_sybil_unproven_peer_throttled() {
        let sec = Security::new();
        let unknown = PeerId("freshly-spawned".into());
        let err = sec
            .check_sybil_proof(&unknown, None)
            .expect_err("an unattested peer must be throttled");
        assert!(matches!(err, NetworkError::Transport(_)));
    }

    #[test]
    fn A_5_4_sybil_unverifiable_proof_stays_fail_closed() {
        let sec = Security::new();
        let peer = PeerId("claims-proof".into());
        // A present-but-unverifiable proof is fail-closed until Cloud lands.
        assert!(sec.check_sybil_proof(&peer, Some(b"bogus-jwt")).is_err());
    }

    // -----------------------------------------------------------------
    // A.5.5 — Eclipse defence: ≥2 bootstrap peers reachable to be `active` (§8.5)
    // -----------------------------------------------------------------
    #[test]
    fn A_5_5_eclipse_floor_requires_two_bootstraps() {
        let mut sec = Security::new();
        assert!(!sec.is_eclipse_safe(), "zero bootstraps → eclipse-unsafe");
        sec.mark_bootstrap_reachable(PeerId("boot-1".into()));
        assert!(!sec.is_eclipse_safe(), "one bootstrap → still below floor");
        sec.mark_bootstrap_reachable(PeerId("boot-2".into()));
        assert!(sec.is_eclipse_safe(), "two bootstraps → meets the floor");
        sec.mark_bootstrap_unreachable(&PeerId("boot-1".into()));
        assert!(!sec.is_eclipse_safe(), "back below floor → eclipse-unsafe again");
    }
}
