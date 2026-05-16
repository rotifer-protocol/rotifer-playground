//! A.2 — mDNS + Kademlia DHT discovery (v0.9 stage 1 placeholder).
//!
//! Stage 1 ships type signatures + test scaffolds (A.2.1–A.2.7) only.

use super::{NetworkError, PeerId};

/// Combined mDNS + Kademlia DHT discovery façade.
#[derive(Debug, Default)]
pub struct Discovery {
    pub mdns_enabled: bool,
    pub kad_enabled: bool,
}

impl Discovery {
    pub fn new(mdns_enabled: bool, kad_enabled: bool) -> Self {
        Self { mdns_enabled, kad_enabled }
    }

    pub fn bootstrap(&mut self) -> Result<(), NetworkError> {
        Err(NetworkError::Transport(
            "A.2.x — Discovery::bootstrap not implemented (stage 2)".into(),
        ))
    }

    pub fn find_node(&self, peer_id: &PeerId, k: usize) -> Result<Vec<PeerId>, NetworkError> {
        let _ = (peer_id, k);
        Err(NetworkError::Transport(
            "A.2.3 — Discovery::find_node not implemented (stage 2)".into(),
        ))
    }

    pub fn put(&self, key: &[u8], value: &[u8], ttl_secs: u64) -> Result<(), NetworkError> {
        let _ = (key, value, ttl_secs);
        Err(NetworkError::Transport(
            "A.2.4 — Discovery::put not implemented (stage 2)".into(),
        ))
    }

    pub fn get(&self, key: &[u8]) -> Result<Option<Vec<u8>>, NetworkError> {
        let _ = key;
        Err(NetworkError::Transport(
            "A.2.4 — Discovery::get not implemented (stage 2)".into(),
        ))
    }

    pub fn routing_table_len(&self) -> usize {
        0
    }

    pub fn mark_unreachable(&mut self, peer_id: &PeerId, last_seen_secs_ago: u64) {
        let _ = (peer_id, last_seen_secs_ago);
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------
    // A.2.1 — mDNS publish + discover (LAN simulation)
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.2.1 integration — requires two co-process nodes; stage 2 unignores"]
    fn A_2_1_mdns_publish_and_discover() {
        let mut d1 = Discovery::new(true, false);
        let mut d2 = Discovery::new(true, false);
        d1.bootstrap().expect("A.2.1 — d1 mdns up");
        d2.bootstrap().expect("A.2.1 — d2 mdns up");
        // Stage 2: poll until both discovery instances see each other.
        unimplemented!("A.2.1 — stage 2 wires the mDNS event-loop");
    }

    // -----------------------------------------------------------------
    // A.2.2 — Kademlia DHT join + routing-table fill
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.2.2 integration — needs bootstrap node; stage 2 unignores"]
    fn A_2_2_kad_join_populates_routing_table() {
        let mut d = Discovery::new(false, true);
        d.bootstrap().expect("A.2.2 — bootstrap");
        assert!(d.routing_table_len() >= 1, "routing table must populate");
    }

    // -----------------------------------------------------------------
    // A.2.3 — FIND_NODE returns nearest-k peers
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
    fn A_2_3_find_node_returns_k_nearest() {
        let d = Discovery::new(false, true);
        let peers = d
            .find_node(&PeerId("target".into()), 20)
            .expect("A.2.3 — find_node");
        assert!(peers.len() <= 20, "must respect k");
    }

    #[test]
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
    fn A_2_3_find_node_unknown_returns_empty() {
        let d = Discovery::new(false, true);
        let peers = d
            .find_node(&PeerId("nope-nonexistent".into()), 20)
            .expect("A.2.3 — find_node missing");
        assert!(peers.is_empty(), "unknown peer ⇒ empty result");
    }

    // -----------------------------------------------------------------
    // A.2.4 — DHT PUT/GET round-trip + TTL expiry
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
    fn A_2_4_put_get_round_trip() {
        let d = Discovery::new(false, true);
        let key = b"gene/abc";
        let value = b"announcement-bytes";
        d.put(key, value, 60).expect("A.2.4 — put");
        let got = d.get(key).expect("A.2.4 — get");
        assert_eq!(got.as_deref(), Some(&value[..]));
    }

    #[test]
    #[ignore = "A.2.4 TTL expiry — requires sleep; stage 2 will use a fake clock"]
    fn A_2_4_get_after_ttl_returns_none() {
        let d = Discovery::new(false, true);
        let key = b"gene/expires";
        d.put(key, b"v", 1).expect("A.2.4 — put with 1s ttl");
        std::thread::sleep(std::time::Duration::from_secs(2));
        let got = d.get(key).expect("A.2.4 — get after ttl");
        assert!(got.is_none(), "value must expire after ttl");
    }

    // -----------------------------------------------------------------
    // A.2.5 — Kad keeps working after mDNS shutdown
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
    fn A_2_5_kad_survives_mdns_off() {
        let mut d = Discovery::new(true, true);
        d.bootstrap().expect("A.2.5 — initial bootstrap");
        d.mdns_enabled = false;
        // Should still be able to perform DHT ops.
        d.find_node(&PeerId("any".into()), 10)
            .expect("A.2.5 — kad survives mdns off");
    }

    // -----------------------------------------------------------------
    // A.2.6 — Network partition recovery — routing table rebuilt ≤10s
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.2.6 resilience — needs partition simulation; stage 2 unignores"]
    fn A_2_6_partition_recovery() {
        let mut d = Discovery::new(false, true);
        d.bootstrap().expect("A.2.6 — initial bootstrap");
        // Stage 2: simulate disconnect → reconnect; assert routing table refills.
        unimplemented!("A.2.6 — stage 2");
    }

    // -----------------------------------------------------------------
    // A.2.7 — Peers marked unreachable after 30s without contact
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
    fn A_2_7_unreachable_peer_marked_after_30s() {
        let mut d = Discovery::new(false, true);
        d.bootstrap().expect("A.2.7 — bootstrap");
        d.mark_unreachable(&PeerId("ghost".into()), 35);
        // Stage 2 will expose a query like `is_reachable` — for now the API must
        // exist; the assertion focuses on the API being available without panic.
    }
}
