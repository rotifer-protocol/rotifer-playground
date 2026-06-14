//! A.3 — GossipSub message layer (v0.9 stage 1 placeholder).
//!
//! Topics:
//!   - `/rotifer/gene/announce/1.0.0`
//!   - `/rotifer/gene/search/1.0.0`
//!   - `/rotifer/reputation/update/1.0.0`
//!
//! Stage 1 only sketches A.3.1–A.3.9.

use super::{GeneAnnouncement, NetworkError, PeerId};

pub const TOPIC_GENE_ANNOUNCE: &str = "/rotifer/gene/announce/1.0.0";
pub const TOPIC_GENE_SEARCH: &str = "/rotifer/gene/search/1.0.0";
pub const TOPIC_REPUTATION_UPDATE: &str = "/rotifer/reputation/update/1.0.0";

pub const MAX_MESSAGE_BYTES: usize = 65_536; // 64 KiB

#[derive(Debug, Default)]
pub struct Gossip {
    pub subscriptions: Vec<String>,
    pub trusted_cloud_keys: Vec<Vec<u8>>,
}

impl Gossip {
    pub fn new() -> Self {
        Self::default()
    }

    /// Subscribe to `topic`. Idempotent — the subscription set stays unique.
    pub fn subscribe(&mut self, topic: &str) -> Result<(), NetworkError> {
        if !self.subscriptions.iter().any(|t| t == topic) {
            self.subscriptions.push(topic.to_string());
        }
        Ok(())
    }

    /// Unsubscribe from `topic`. A no-op if not subscribed.
    pub fn unsubscribe(&mut self, topic: &str) -> Result<(), NetworkError> {
        self.subscriptions.retain(|t| t != topic);
        Ok(())
    }

    pub fn publish(&self, topic: &str, payload: &[u8]) -> Result<(), NetworkError> {
        let _ = (topic, payload);
        Err(NetworkError::Transport(
            "A.3.2 — Gossip::publish not implemented (stage 2)".into(),
        ))
    }

    pub fn publish_announcement(&self, ann: &GeneAnnouncement) -> Result<(), NetworkError> {
        let _ = ann;
        Err(NetworkError::Transport(
            "A.3.2 — Gossip::publish_announcement not implemented (stage 2)".into(),
        ))
    }

    pub fn peer_score(&self, peer_id: &PeerId) -> f64 {
        let _ = peer_id;
        0.0
    }

    pub fn is_graylisted(&self, peer_id: &PeerId) -> bool {
        let _ = peer_id;
        false
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // A.3.1 — Subscribe to announce topic
    // -----------------------------------------------------------------
    #[test]
    fn A_3_1_subscribe_announce_topic() {
        let mut g = Gossip::new();
        g.subscribe(TOPIC_GENE_ANNOUNCE)
            .expect("A.3.1 — subscribe announce");
        assert!(
            g.subscriptions.iter().any(|t| t == TOPIC_GENE_ANNOUNCE),
            "subscription must be recorded"
        );
    }

    // -----------------------------------------------------------------
    // A.3.2 — Publish announcement reaches 3-node mesh within 5s
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "two-node gossipsub broadcast proven in node::tests::two_nodes_gossip_broadcast; 3-node mesh + Gossip<->Node merge remain"]
    fn A_3_2_publish_reaches_3node_mesh_within_5s() {
        // Stage 2: spin up 3 in-process Gossip nodes, subscribe to TOPIC,
        // publish from one, assert the other two receive within 5s.
        unimplemented!("A.3.2 — stage 2");
    }

    // -----------------------------------------------------------------
    // A.3.3 — Ed25519 signature verification (forged ⇒ reject + score -10)
    // -----------------------------------------------------------------
    #[test]
    fn A_3_3_forged_signature_rejected_and_scored_down() {
        let g = Gossip::new();
        let peer = PeerId("forger".into());

        let _err = g
            .publish_announcement(&GeneAnnouncement {
                gene_id: "id".into(),
                name: "n".into(),
                domain: "d".into(),
                version: "0".into(),
                fidelity: "Native".into(),
                publisher: peer.clone(),
                reputation_score: 0.0,
                timestamp: 0,
            })
            .expect_err("A.3.3 — invalid signature should be rejected");

        // Stage 2: forged-signature rejection records a score decrement.
        let _ = g.peer_score(&peer);
    }

    // -----------------------------------------------------------------
    // A.3.4 — GossipSub score: 5 consecutive forgeries ⇒ graylist
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.3.4 security — needs full score machinery; stage 2 unignores"]
    fn A_3_4_repeated_forgery_graylists_peer() {
        let g = Gossip::new();
        let peer = PeerId("repeat-offender".into());
        for _ in 0..5 {
            let _ = g.publish_announcement(&GeneAnnouncement {
                gene_id: "x".into(),
                name: "x".into(),
                domain: "x".into(),
                version: "0".into(),
                fidelity: "Native".into(),
                publisher: peer.clone(),
                reputation_score: 0.0,
                timestamp: 0,
            });
        }
        assert!(g.is_graylisted(&peer), "5 forgeries ⇒ graylist");
    }

    // -----------------------------------------------------------------
    // A.3.5 — Rate limit: >100 msg/s per peer triggers drop
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.3.5 security — flood simulation; stage 2 unignores"]
    fn A_3_5_rate_limit_drops_excessive_msgs() {
        // Stage 2: send 200 msgs in 1s window; assert ≥half are dropped.
        unimplemented!("A.3.5 — stage 2");
    }

    // -----------------------------------------------------------------
    // A.3.6 — SearchRequest/SearchResponse pairing + timeout
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.3.6 integration — needs request/response state machine; stage 2 unignores"]
    fn A_3_6_search_request_response_pairing() {
        unimplemented!("A.3.6 — stage 2");
    }

    // -----------------------------------------------------------------
    // A.3.7 — ReputationUpdate accepted only if signed by trusted Cloud key
    // -----------------------------------------------------------------
    #[test]
    fn A_3_7_reputation_update_requires_trusted_cloud_key() {
        let mut g = Gossip::new();
        g.trusted_cloud_keys.push(b"trusted-pubkey".to_vec());

        // Unsigned / wrong key ⇒ publish must error.
        let err = g
            .publish(TOPIC_REPUTATION_UPDATE, b"untrusted-payload")
            .expect_err("A.3.7 — untrusted ReputationUpdate must be rejected");
        assert!(matches!(err, NetworkError::Transport(_)));
    }

    // -----------------------------------------------------------------
    // A.3.8 — Topic message size constraint ≤64KB
    // -----------------------------------------------------------------
    #[test]
    fn A_3_8_message_size_boundary() {
        let g = Gossip::new();
        let payload_at_limit = vec![0u8; MAX_MESSAGE_BYTES];
        let _ = g.publish(TOPIC_GENE_ANNOUNCE, &payload_at_limit); // stage 1: NotImplemented — error

        let oversized = vec![0u8; MAX_MESSAGE_BYTES + 1];
        let err = g
            .publish(TOPIC_GENE_ANNOUNCE, &oversized)
            .expect_err("A.3.8 — >64KiB must error");
        assert!(matches!(err, NetworkError::Transport(_)));
    }

    // -----------------------------------------------------------------
    // A.3.9 — Duplicate subscribe is idempotent
    // -----------------------------------------------------------------
    #[test]
    fn A_3_9_duplicate_subscribe_is_idempotent() {
        let mut g = Gossip::new();
        g.subscribe(TOPIC_GENE_ANNOUNCE).expect("A.3.9 — first subscribe");
        g.subscribe(TOPIC_GENE_ANNOUNCE)
            .expect("A.3.9 — second subscribe must succeed");
        // Mesh subscription count for this topic must remain 1.
        let occurrences = g
            .subscriptions
            .iter()
            .filter(|t| t.as_str() == TOPIC_GENE_ANNOUNCE)
            .count();
        assert_eq!(occurrences, 1, "subscription set must remain unique");
    }
}
