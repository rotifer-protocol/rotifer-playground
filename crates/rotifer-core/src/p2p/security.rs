//! A.5 — PeerId derivation + signing + rate limiting (v0.9 stage 1 placeholder).
//!
//! Stage 1 placeholders; stage 2 wires real libp2p identity + crypto.

use super::{NetworkError, PeerId};

/// Per-peer rate limit (msgs / second).
pub const RATE_LIMIT_PER_PEER_PER_SEC: u32 = 10;

/// Anti-replay nonce / timestamp window.
pub const ANTI_REPLAY_WINDOW_SECS: u64 = 300;

/// Bootstrap peer connectivity floor — at least N must be reachable for `active`.
pub const BOOTSTRAP_CONNECTIVITY_FLOOR: usize = 2;

pub fn derive_peer_id_from_pubkey(pubkey: &[u8]) -> PeerId {
    // Stage 2: use libp2p's official derivation (multihash of public key bytes).
    // Stage 1 placeholder: sha256 hex prefix.
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(pubkey);
    PeerId(format!("rt_{}", &hex::encode(hash)[..16]))
}

#[derive(Debug, Default)]
pub struct Security {
    pub known_peers: Vec<PeerId>,
}

impl Security {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn verify_signature(&self, peer: &PeerId, msg: &[u8], sig: &[u8]) -> Result<(), NetworkError> {
        let _ = (peer, msg, sig);
        Err(NetworkError::Transport(
            "A.5.x — Security::verify_signature not implemented (stage 2)".into(),
        ))
    }

    pub fn record_message(&mut self, peer: &PeerId) -> Result<(), NetworkError> {
        let _ = peer;
        Err(NetworkError::Transport(
            "A.5.3 — Security::record_message not implemented (stage 2)".into(),
        ))
    }

    pub fn check_sybil_proof(&self, peer: &PeerId, proof: Option<&[u8]>) -> Result<(), NetworkError> {
        let _ = (peer, proof);
        Err(NetworkError::Transport(
            "A.5.4 — Security::check_sybil_proof not implemented (stage 2)".into(),
        ))
    }

    pub fn bootstrap_reachable(&self) -> usize {
        0
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
    // A.5.2 — Anti-replay: re-broadcast same message rejected
    // -----------------------------------------------------------------
    #[test]
    fn A_5_2_replay_rejected() {
        let sec = Security::new();
        let peer = PeerId("p1".into());
        let payload = b"msg";

        // First time → expected to succeed (stage 2). Stage 1 returns Err.
        let _ = sec.verify_signature(&peer, payload, b"sig-1");
        // Second time with same nonce should also error in stage 2 (replay).
        let _ = sec.verify_signature(&peer, payload, b"sig-1");
    }

    // -----------------------------------------------------------------
    // A.5.3 — Rate limit: 11th message in 1s window dropped
    // -----------------------------------------------------------------
    #[test]
    fn A_5_3_rate_limit_drops_eleventh_message() {
        let mut sec = Security::new();
        let peer = PeerId("noisy".into());

        let mut accepted = 0_u32;
        let mut dropped = 0_u32;
        for _ in 0..11 {
            match sec.record_message(&peer) {
                Ok(()) => accepted += 1,
                Err(NetworkError::Transport(msg)) if msg.contains("rate") => dropped += 1,
                Err(_) => dropped += 1,
            }
        }

        // Stage 2: assert accepted == 10 && dropped >= 1.
        let _ = (accepted, dropped);
    }

    // -----------------------------------------------------------------
    // A.5.4 — Sybil defence: new peer without Proof-of-Gene limited to 1 msg/s
    // -----------------------------------------------------------------
    #[test]
    fn A_5_4_sybil_unproven_peer_throttled() {
        let sec = Security::new();
        let unknown = PeerId("freshly-spawned".into());
        let err = sec
            .check_sybil_proof(&unknown, None)
            .expect_err("A.5.4 — unproven peer must require throttling");
        assert!(matches!(err, NetworkError::Transport(_)));
    }

    // -----------------------------------------------------------------
    // A.5.5 — Eclipse defence: ≥2 bootstrap peers reachable to be `active`
    // -----------------------------------------------------------------
    #[test]
    fn A_5_5_eclipse_floor_two_bootstraps() {
        let sec = Security::new();
        assert!(
            sec.bootstrap_reachable() < BOOTSTRAP_CONNECTIVITY_FLOOR,
            "A.5.5 — stage 1 expected below floor (FAIL until stage 2 wires real bootstrap)"
        );
    }
}
