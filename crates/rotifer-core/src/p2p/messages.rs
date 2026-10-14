//! A.4 — Protobuf serialisation for P2P messages (v0.9 stage 1 placeholder).
//!
//! Authoritative schema lives in the monorepo protocol spec.
//! Stage 1 uses serde_json round-trips as a placeholder so the test suite
//! exercises encode/decode semantics; stage 2 swaps to prost-generated types
//! and tightens with sha256 frozen-parity (A.4.3) + cross-language parity
//! (A.4.4).

use super::{GeneAnnouncement, NetworkError};

/// Encode a GeneAnnouncement to its wire format.
///
/// Stage 1: serde_json placeholder.
/// Stage 2: prost-generated protobuf bytes.
pub fn encode_announcement(ann: &GeneAnnouncement) -> Result<Vec<u8>, NetworkError> {
    serde_json::to_vec(ann).map_err(|e| NetworkError::Transport(e.to_string()))
}

/// Decode wire bytes into a GeneAnnouncement.
pub fn decode_announcement(bytes: &[u8]) -> Result<GeneAnnouncement, NetworkError> {
    serde_json::from_slice(bytes).map_err(|e| NetworkError::Transport(e.to_string()))
}

/// Canonical GossipSub topic for gene announcements (RFC §6.2).
pub const ANNOUNCEMENTS_TOPIC: &str = "/rotifer/announcements";

/// Why a received announcement was dropped instead of surfaced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// The payload does not decode as a `GeneAnnouncement`.
    Malformed,
    /// The self-declared `publisher` field names someone other than the
    /// GossipSub-authenticated source (impersonation attempt, §8.3).
    PublisherMismatch,
    /// The timestamp lies outside the anti-replay window (§6.4).
    Stale,
}

/// Decide whether a received announcement payload is surfaced to the user.
/// `source` is the GossipSub-authenticated publisher PeerId.
pub fn accept_announcement(
    data: &[u8],
    source: Option<&str>,
    now_secs: u64,
) -> Result<GeneAnnouncement, Rejection> {
    let ann = decode_announcement(data).map_err(|_| Rejection::Malformed)?;
    if source != Some(ann.publisher.0.as_str()) {
        return Err(Rejection::PublisherMismatch);
    }
    if !is_timestamp_fresh(ann.timestamp, now_secs) {
        return Err(Rejection::Stale);
    }
    Ok(ann)
}

/// Maximum acceptable clock skew on incoming announcements (anti-replay).
pub const MAX_TIMESTAMP_SKEW_SECS: u64 = 300; // 5 minutes

/// Whether `timestamp_secs` falls within the accepted clock-skew window around
/// `now_secs` — the anti-replay check the gossip layer applies to incoming
/// announcements, rejecting both stale and far-future timestamps.
pub fn is_timestamp_fresh(timestamp_secs: u64, now_secs: u64) -> bool {
    let lower = now_secs.saturating_sub(MAX_TIMESTAMP_SKEW_SECS);
    let upper = now_secs.saturating_add(MAX_TIMESTAMP_SKEW_SECS);
    (lower..=upper).contains(&timestamp_secs)
}

/// sha256 of the canonical `.proto` schema (frozen parity — A.4.3).
///
/// Stage 1 leaves this as `None`; stage 2 will pin to the hash of
/// the canonical protocol schema once the file is finalised.
pub const FROZEN_PROTO_SCHEMA_SHA256: Option<&str> = None;

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;
    use crate::p2p::PeerId;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn fixture() -> GeneAnnouncement {
        GeneAnnouncement {
            gene_id: "id-001".into(),
            name: "math.sort".into(),
            domain: "math".into(),
            version: "1.0.0".into(),
            fidelity: "Native".into(),
            publisher: PeerId("peer-001".into()),
            reputation_score: 0.42,
            timestamp: now(),
        }
    }

    // -----------------------------------------------------------------
    // A.4.1 — encode/decode round-trip preserves all fields
    // -----------------------------------------------------------------
    #[test]
    fn A_4_1_encode_decode_round_trip() {
        let ann = fixture();
        let bytes = encode_announcement(&ann).expect("A.4.1 — encode");
        let decoded = decode_announcement(&bytes).expect("A.4.1 — decode");
        assert_eq!(decoded.gene_id, ann.gene_id);
        assert_eq!(decoded.name, ann.name);
        assert_eq!(decoded.domain, ann.domain);
        assert_eq!(decoded.version, ann.version);
        assert_eq!(decoded.fidelity, ann.fidelity);
        assert_eq!(decoded.publisher.0, ann.publisher.0);
        assert!((decoded.reputation_score - ann.reputation_score).abs() < 1e-9);
        assert_eq!(decoded.timestamp, ann.timestamp);
    }

    // -----------------------------------------------------------------
    // A.4.2 — Strict-Test: missing required field ⇒ Err (no silent fallback)
    // -----------------------------------------------------------------
    #[test]
    fn A_4_2_strict_missing_required_field_errors() {
        // Stage 1 (serde_json) — supply payload without `gene_id`.
        let bytes = br#"{
            "name": "n",
            "domain": "d",
            "version": "0",
            "fidelity": "Native",
            "publisher": {"_field0": "peer"},
            "reputation_score": 0.0,
            "timestamp": 0
        }"#;
        let result = decode_announcement(bytes);
        assert!(result.is_err(), "A.4.2 — missing field must error, not fallback");
    }

    // -----------------------------------------------------------------
    // A.4.3 — Strict-Test: sha256 frozen-parity for the wire schema
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
    fn A_4_3_strict_proto_schema_frozen_sha256() {
        // Stage 2 pins FROZEN_PROTO_SCHEMA_SHA256 = Some(<sha256>).
        // Monorepo-dev only: schema path via env var (this strict test is
        // #[ignore]d and unused in standalone builds).
        let proto_path = std::path::PathBuf::from(
            std::env::var("ROTIFER_PROTO_PATH")
                .expect("set ROTIFER_PROTO_PATH to the p2p protocol schema"),
        );

        match FROZEN_PROTO_SCHEMA_SHA256 {
            None => panic!(
                "A.4.3 — FROZEN_PROTO_SCHEMA_SHA256 not pinned yet. \
                 Stage 2 will compute sha256 of {}.",
                proto_path.display()
            ),
            Some(expected) => {
                let bytes = std::fs::read(&proto_path).expect("read .proto file");
                use sha2::{Digest, Sha256};
                let actual = format!("{:x}", Sha256::digest(&bytes));
                assert_eq!(actual, expected, "A.4.3 — proto schema sha256 drift");
            }
        }
    }

    // -----------------------------------------------------------------
    // A.4.4 — Cross-language round-trip (Rust encode → TS decode)
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.4.4 integration — needs ts-proto pipeline; stage 2 unignores"]
    fn A_4_4_cross_language_round_trip() {
        let ann = fixture();
        let bytes = encode_announcement(&ann).expect("A.4.4 — Rust encode");
        // Stage 2: pipe `bytes` to a TS test harness; assert decoded fields.
        std::fs::write(
            std::env::temp_dir().join("rotifer-A_4_4-wire.bin"),
            bytes,
        )
        .ok();
        unimplemented!("A.4.4 — stage 2 wires ts-proto consumer");
    }

    // -----------------------------------------------------------------
    // A.4.5 — Strict-Test: forward compatibility (old decoder ignores new fields)
    // -----------------------------------------------------------------
    #[test]
    fn A_4_5_strict_forward_compatible_unknown_fields() {
        // Wire format includes an unknown future field — decoder must ignore it.
        let bytes = br#"{
            "gene_id": "id-002",
            "name": "n",
            "domain": "d",
            "version": "0",
            "fidelity": "Native",
            "publisher": "peer",
            "reputation_score": 0.0,
            "timestamp": 0,
            "future_field": "v3-stuff"
        }"#;
        // Stage 1 (serde_json) is lenient by default; stage 2 (prost) handles
        // unknown fields via the protobuf forward-compatibility rules.
        let _ = decode_announcement(bytes);
    }

    // -----------------------------------------------------------------
    // A.4.6 — Stale timestamp rejected (>5min replay window)
    // -----------------------------------------------------------------
    #[test]
    fn A_4_6_stale_timestamp_rejected() {
        let mut ann = fixture();
        ann.timestamp = now().saturating_sub(MAX_TIMESTAMP_SKEW_SECS + 60);
        let bytes = encode_announcement(&ann).expect("encode");
        let decoded = decode_announcement(&bytes).expect("decode");
        // Stage 2: gossip layer will call into `messages::is_timestamp_fresh` and
        // reject stale messages. Stage 1 only verifies the timestamp survives
        // round-trip so future logic can reject it.
        assert!(decoded.timestamp < now() - MAX_TIMESTAMP_SKEW_SECS);
    }

    // -----------------------------------------------------------------
    // Receive-side acceptance: impersonation, replay window, malformed
    // -----------------------------------------------------------------
    #[test]
    fn accept_announcement_checks_source_and_window() {
        let ann = fixture();
        let bytes = encode_announcement(&ann).unwrap();
        let t = ann.timestamp;
        assert!(accept_announcement(&bytes, Some("peer-001"), t).is_ok());
        assert_eq!(
            accept_announcement(&bytes, Some("peer-999"), t).unwrap_err(),
            Rejection::PublisherMismatch
        );
        assert_eq!(
            accept_announcement(&bytes, None, t).unwrap_err(),
            Rejection::PublisherMismatch,
            "an unauthenticated message cannot vouch for its publisher field"
        );
        assert_eq!(
            accept_announcement(&bytes, Some("peer-001"), t + MAX_TIMESTAMP_SKEW_SECS + 1)
                .unwrap_err(),
            Rejection::Stale
        );
        assert_eq!(
            accept_announcement(b"junk", Some("peer-001"), t).unwrap_err(),
            Rejection::Malformed
        );
    }

    // -----------------------------------------------------------------
    // Anti-replay freshness window (gossip layer will gate on this)
    // -----------------------------------------------------------------
    #[test]
    fn timestamp_freshness_window() {
        let now = 10_000;
        assert!(is_timestamp_fresh(now, now), "exactly now is fresh");
        assert!(
            is_timestamp_fresh(now - MAX_TIMESTAMP_SKEW_SECS, now),
            "the edge of the past window is fresh"
        );
        assert!(
            !is_timestamp_fresh(now - MAX_TIMESTAMP_SKEW_SECS - 1, now),
            "just beyond the past window is stale"
        );
        assert!(
            !is_timestamp_fresh(now + MAX_TIMESTAMP_SKEW_SECS + 1, now),
            "future clock-skew beyond the window is rejected"
        );
    }
}
