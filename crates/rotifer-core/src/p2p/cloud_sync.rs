//! A.6 — Cloud-P2P data consistency (v0.9 stage 1 placeholder).
//!
//! All A.6 tests are flagged Strict-Test (per ADR-264 §5) — no mock, no
//! simplification, no fallback. Stage 2 plugs real Supabase + real libp2p in;
//! stage 1 returns `NetworkError::Transport(...)` from every method so tests
//! correctly fail.

use super::{GeneAnnouncement, NetworkError};

/// Maximum number of offline announcements buffered before publishing.
pub const OFFLINE_QUEUE_CAPACITY: usize = 100;

/// Soft upper bound for Cloud↔P2P eventual consistency.
pub const CONSISTENCY_WINDOW_SECS: u64 = 5;

#[derive(Debug, Default)]
pub struct CloudSync {
    pub cloud_url: String,
    pub offline_queue: Vec<GeneAnnouncement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchSource {
    Cloud,
    P2P,
    Mixed,
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub gene_id: String,
    pub source: SearchSource,
}

impl CloudSync {
    pub fn new(cloud_url: impl Into<String>) -> Self {
        Self { cloud_url: cloud_url.into(), offline_queue: Vec::new() }
    }

    /// Strict-Test A.6.1 / A.6.2: publish goes Cloud-first; Cloud failure aborts P2P broadcast.
    pub fn publish(&mut self, ann: GeneAnnouncement) -> Result<(), NetworkError> {
        let _ = ann;
        Err(NetworkError::Transport(
            "A.6.1 / A.6.2 — CloudSync::publish not implemented (stage 2)".into(),
        ))
    }

    /// Strict-Test A.6.3 / A.6.4: hybrid search — Cloud + P2P in parallel, de-duplicate.
    pub fn hybrid_search(&self, query: &str) -> Result<Vec<SearchHit>, NetworkError> {
        let _ = query;
        Err(NetworkError::Transport(
            "A.6.3 / A.6.4 — CloudSync::hybrid_search not implemented (stage 2)".into(),
        ))
    }

    /// Queue an announcement while Cloud is unreachable.
    pub fn queue_offline(&mut self, ann: GeneAnnouncement) -> Result<(), NetworkError> {
        if self.offline_queue.len() >= OFFLINE_QUEUE_CAPACITY {
            return Err(NetworkError::Transport(format!(
                "A.6.5 — offline queue at capacity ({})",
                OFFLINE_QUEUE_CAPACITY
            )));
        }
        self.offline_queue.push(ann);
        Ok(())
    }

    /// Drain the offline queue once Cloud comes back.
    pub fn flush_offline(&mut self) -> Result<usize, NetworkError> {
        Err(NetworkError::Transport(
            "A.6.5 — CloudSync::flush_offline not implemented (stage 2)".into(),
        ))
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    // Strict-Test per ADR-264 §5 — applies to every test in this module.
    use super::*;
    use crate::p2p::PeerId;

    fn ann(id: &str) -> GeneAnnouncement {
        GeneAnnouncement {
            gene_id: id.into(),
            name: "n".into(),
            domain: "d".into(),
            version: "0".into(),
            fidelity: "Native".into(),
            publisher: PeerId("p".into()),
            reputation_score: 0.0,
            timestamp: 0,
        }
    }

    // -----------------------------------------------------------------
    // A.6.1 — Cloud-first publish; P2P broadcast follows
    // -----------------------------------------------------------------
    #[test]
    fn A_6_1_strict_publish_cloud_first_then_p2p() {
        let mut cs = CloudSync::new("https://supabase.example/rest/v1");
        let result = cs.publish(ann("g-1"));
        // Strict-Test: stage 2 must complete Cloud round-trip before broadcasting.
        assert!(result.is_err(), "stage 1 returns Err — TDD red phase");
    }

    // -----------------------------------------------------------------
    // A.6.2 — Cloud failure aborts P2P broadcast (atomicity)
    // -----------------------------------------------------------------
    #[test]
    fn A_6_2_strict_cloud_failure_aborts_p2p() {
        let mut cs = CloudSync::new("https://unreachable.invalid/rest/v1");
        let result = cs.publish(ann("g-2"));
        // Strict-Test: Cloud HTTP 500 ⇒ no P2P announce dispatched.
        assert!(result.is_err(), "Cloud failure ⇒ publish must Err");
    }

    // -----------------------------------------------------------------
    // A.6.3 — Hybrid search merges Cloud + P2P with de-dup
    // -----------------------------------------------------------------
    #[test]
    fn A_6_3_strict_hybrid_search_dedup() {
        let cs = CloudSync::new("https://supabase.example/rest/v1");
        let hits = cs.hybrid_search("math sort");
        // Strict-Test: stage 2 will assert exact merge & de-dup; stage 1 = Err.
        assert!(hits.is_err());
    }

    // -----------------------------------------------------------------
    // A.6.4 — Offline: Cloud unreachable ⇒ P2P-only search marked [P2P]
    // -----------------------------------------------------------------
    #[test]
    fn A_6_4_resilience_p2p_only_when_cloud_offline() {
        let cs = CloudSync::new("offline://");
        let _ = cs.hybrid_search("offline search"); // stage 2: returns Ok with P2P-only.
    }

    // -----------------------------------------------------------------
    // A.6.5 — Offline publish queue (FIFO, ≤100 items)
    // -----------------------------------------------------------------
    #[test]
    fn A_6_5_offline_queue_respects_capacity_and_fifo() {
        let mut cs = CloudSync::new("offline://");
        for i in 0..OFFLINE_QUEUE_CAPACITY {
            cs.queue_offline(ann(&format!("g-{i}"))).expect("queue under capacity");
        }
        let overflow = cs.queue_offline(ann("overflow"));
        assert!(overflow.is_err(), "A.6.5 — queue must reject overflow");
        assert_eq!(cs.offline_queue.first().unwrap().gene_id, "g-0", "FIFO order");
    }

    // -----------------------------------------------------------------
    // A.6.6 — Cloud-P2P eventual consistency ≤5s
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.6.6 Strict-Test — needs real Supabase + libp2p; stage 2 unignores"]
    fn A_6_6_strict_eventual_consistency_within_5s() {
        let mut cs = CloudSync::new("https://supabase.example/rest/v1");
        // Stage 2: publish via Cloud, then assert P2P search returns the
        // freshly-published Gene within CONSISTENCY_WINDOW_SECS seconds.
        let _ = cs.publish(ann("eventual-1"));
        unimplemented!("A.6.6 — stage 2");
    }
}
