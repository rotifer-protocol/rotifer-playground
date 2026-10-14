//! P2P wire format v1 — frozen (`proto/p2p-wire-v1.proto`).
//!
//! The protobuf types below mirror that file by hand (`prost` derive, no
//! build-time `protoc`). Tests pin the file's sha256, check the field tags
//! against it, and decode/encode golden vectors produced by an independent
//! encoder (`scripts/p2p-wire-v1-reference.py`).
//!
//! Every message on the announcements topic goes through [`validate_gossip`]
//! *before* GossipSub forwards it; anything not `Accept` is neither surfaced
//! nor relayed.

use std::path::Path;

use prost::Message as _;

use super::GeneAnnouncement;
use crate::gene_id::{self, NotComputable};

/// GossipSub topic carrying wire-v1 gene announcements. Nodes on the
/// pre-freeze JSON format use a different topic and never see these.
pub const ANNOUNCEMENTS_TOPIC: &str = "/rotifer/p2p/1/announcements";

/// Largest gossip payload accepted on the announcements topic.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Maximum acceptable clock skew on incoming announcements (anti-replay).
pub const MAX_TIMESTAMP_SKEW_SECS: u64 = 300; // 5 minutes
const MAX_TIMESTAMP_SKEW_MS: u64 = MAX_TIMESTAMP_SKEW_SECS * 1000;

const MAX_NAME_BYTES: usize = 128;
const MAX_DOMAIN_BYTES: usize = 128;
const MAX_IR_SPEC_BYTES: usize = 32;
const MAX_VERSION_BYTES: usize = 64;

/// sha256 of `proto/p2p-wire-v1.proto` — the frozen schema (A.4.3).
pub const FROZEN_PROTO_SCHEMA_SHA256: &str =
    "aa98bf4a7ae4e576a0e2e867bb208559f1cbb02b82862ac384252d005487f65c";

/// `GossipMessage` (wire tag numbers as in the .proto).
#[derive(Clone, PartialEq, prost::Message)]
pub struct WireGossipMessage {
    #[prost(oneof = "wire_gossip_message::Body", tags = "1")]
    pub body: Option<wire_gossip_message::Body>,
}

pub mod wire_gossip_message {
    #[derive(Clone, PartialEq, prost::Oneof)]
    pub enum Body {
        #[prost(message, tag = "1")]
        Announcement(super::WireGeneAnnouncement),
    }
}

/// `GeneAnnouncement` (wire tag numbers as in the .proto).
#[derive(Clone, PartialEq, prost::Message)]
pub struct WireGeneAnnouncement {
    #[prost(string, tag = "1")]
    pub gene_id: String,
    #[prost(string, tag = "2")]
    pub name: String,
    #[prost(string, tag = "3")]
    pub domain: String,
    #[prost(string, tag = "4")]
    pub fidelity: String,
    #[prost(string, tag = "5")]
    pub ir_spec: String,
    #[prost(string, tag = "6")]
    pub version: String,
    #[prost(uint64, tag = "7")]
    pub timestamp_ms: u64,
}

impl From<&GeneAnnouncement> for WireGeneAnnouncement {
    fn from(a: &GeneAnnouncement) -> Self {
        Self {
            gene_id: a.gene_id.clone(),
            name: a.name.clone(),
            domain: a.domain.clone(),
            fidelity: a.fidelity.clone(),
            ir_spec: a.ir_spec.clone(),
            version: a.version.clone(),
            timestamp_ms: a.timestamp_ms,
        }
    }
}

impl From<WireGeneAnnouncement> for GeneAnnouncement {
    fn from(w: WireGeneAnnouncement) -> Self {
        Self {
            gene_id: w.gene_id,
            name: w.name,
            domain: w.domain,
            fidelity: w.fidelity,
            ir_spec: w.ir_spec,
            version: w.version,
            timestamp_ms: w.timestamp_ms,
        }
    }
}

/// Encode an announcement as a wire-v1 `GossipMessage`.
pub fn encode_announcement(ann: &GeneAnnouncement) -> Vec<u8> {
    WireGossipMessage {
        body: Some(wire_gossip_message::Body::Announcement(ann.into())),
    }
    .encode_to_vec()
}

/// Why an announcement was rejected (and the sender penalized).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// Larger than [`MAX_MESSAGE_BYTES`].
    Oversized,
    /// Not a decodable wire-v1 `GossipMessage`.
    Malformed,
    /// No GossipSub-authenticated source.
    Unauthenticated,
    /// `gene_id` is not `v2:` + 64 lowercase hex.
    InvalidGeneId,
    /// `domain` empty or too long.
    InvalidDomain,
    /// `name` too long.
    InvalidName,
    /// `fidelity` not Native / Wrapped / Hybrid.
    InvalidFidelity,
    /// `ir_spec` too long, or set for a Wrapped gene.
    InvalidIrSpec,
    /// `version` too long.
    InvalidVersion,
    /// Timestamp outside the ±300 s anti-replay window (§6.4).
    Stale,
}

/// Outcome of validating a gossip message before it is forwarded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Valid: surface it and let GossipSub forward it.
    Accept(GeneAnnouncement),
    /// Invalid: drop it and penalize the sender.
    Reject(Rejection),
    /// A well-formed message of a kind this node does not know (a future
    /// oneof body): drop it, do not forward, do not penalize.
    Ignore,
}

/// Field rules a sender and a receiver both enforce.
pub fn check_fields(a: &GeneAnnouncement) -> Result<(), Rejection> {
    if !gene_id::is_valid(&a.gene_id) {
        return Err(Rejection::InvalidGeneId);
    }
    if a.domain.is_empty() || a.domain.len() > MAX_DOMAIN_BYTES {
        return Err(Rejection::InvalidDomain);
    }
    if a.name.len() > MAX_NAME_BYTES {
        return Err(Rejection::InvalidName);
    }
    let compiled = match a.fidelity.as_str() {
        "Native" | "Hybrid" => true,
        "Wrapped" => false,
        _ => return Err(Rejection::InvalidFidelity),
    };
    if a.ir_spec.len() > MAX_IR_SPEC_BYTES || (!compiled && !a.ir_spec.is_empty()) {
        return Err(Rejection::InvalidIrSpec);
    }
    if a.version.len() > MAX_VERSION_BYTES {
        return Err(Rejection::InvalidVersion);
    }
    Ok(())
}

/// Whether `timestamp_ms` falls within the accepted clock-skew window around
/// `now_ms`, rejecting both stale and far-future timestamps.
pub fn is_timestamp_fresh(timestamp_ms: u64, now_ms: u64) -> bool {
    let lower = now_ms.saturating_sub(MAX_TIMESTAMP_SKEW_MS);
    let upper = now_ms.saturating_add(MAX_TIMESTAMP_SKEW_MS);
    (lower..=upper).contains(&timestamp_ms)
}

/// Validate a message received on [`ANNOUNCEMENTS_TOPIC`]. `source` is the
/// GossipSub-authenticated publisher — which is the announcement's publisher.
pub fn validate_gossip(data: &[u8], source: Option<&str>, now_ms: u64) -> Verdict {
    if data.len() > MAX_MESSAGE_BYTES {
        return Verdict::Reject(Rejection::Oversized);
    }
    if source.is_none() {
        return Verdict::Reject(Rejection::Unauthenticated);
    }
    let Ok(msg) = WireGossipMessage::decode(data) else {
        return Verdict::Reject(Rejection::Malformed);
    };
    let Some(wire_gossip_message::Body::Announcement(wire)) = msg.body else {
        return Verdict::Ignore;
    };
    let ann = GeneAnnouncement::from(wire);
    if let Err(r) = check_fields(&ann) {
        return Verdict::Reject(r);
    }
    if !is_timestamp_fresh(ann.timestamp_ms, now_ms) {
        return Verdict::Reject(Rejection::Stale);
    }
    Verdict::Accept(ann)
}

/// Build the announcement for the local gene `name` under `genes_root`: its
/// v2 ID, display fields from `phenotype.json`, and the IR spec version of a
/// compiled gene. Fails when the ID is not computable or a field would be
/// rejected by receivers.
pub fn local_announcement(genes_root: &Path, name: &str, now_ms: u64) -> Result<GeneAnnouncement, NotComputable> {
    let id = gene_id::gene_id_in_workspace(genes_root, name)?;
    let dir = genes_root.join(name);
    let raw = std::fs::read(dir.join("phenotype.json"))
        .map_err(|e| NotComputable(format!("phenotype.json: {e}")))?;
    let pheno: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|e| NotComputable(format!("phenotype.json: {e}")))?;
    let text = |k: &str| pheno.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    let fidelity = text("fidelity");
    let ir_spec = if gene_id::Kind::from_fidelity(&fidelity)?.is_compiled() {
        let wasm = std::fs::read(dir.join(gene_id::IR_MODULE_FILE))
            .map_err(|e| NotComputable(format!("{}: {e}", gene_id::IR_MODULE_FILE)))?;
        gene_id::compiled_inputs(&wasm)?.ir_spec
    } else {
        String::new()
    };
    let display_name = match text("name") {
        n if n.is_empty() => name.to_string(),
        n => n,
    };
    let ann = GeneAnnouncement {
        gene_id: id,
        name: display_name,
        domain: text("domain"),
        fidelity,
        ir_spec,
        version: text("version"),
        timestamp_ms: now_ms,
    };
    check_fields(&ann).map_err(|r| NotComputable(format!("receivers would reject this announcement: {r:?}")))?;
    Ok(ann)
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    const NOW: u64 = 1_760_000_000_000;
    const SRC: Option<&str> = Some("12D3KooWsource");

    fn fixture() -> GeneAnnouncement {
        GeneAnnouncement {
            gene_id: format!("v2:{}", "ab".repeat(32)),
            name: "math.sort".into(),
            domain: "math".into(),
            fidelity: "Native".into(),
            ir_spec: "0.2.0".into(),
            version: "1.0.0".into(),
            timestamp_ms: NOW,
        }
    }

    fn reject(a: &GeneAnnouncement) -> Rejection {
        match validate_gossip(&encode_announcement(a), SRC, NOW) {
            Verdict::Reject(r) => r,
            other => panic!("expected Reject, got {other:?}"),
        }
    }

    // A.4.1 — encode/decode round-trip preserves every field.
    #[test]
    fn A_4_1_encode_decode_round_trip() {
        let ann = fixture();
        assert_eq!(validate_gossip(&encode_announcement(&ann), SRC, NOW), Verdict::Accept(ann));
    }

    // A.4.2 — proto3 has no required fields: a missing gene_id decodes as ""
    // and must be rejected by validation, not accepted as an empty ID.
    #[test]
    fn A_4_2_strict_missing_gene_id_is_rejected() {
        let mut ann = fixture();
        ann.gene_id.clear();
        let bytes = encode_announcement(&ann);
        assert!(WireGossipMessage::decode(bytes.as_slice()).is_ok(), "decodes fine…");
        assert_eq!(reject(&ann), Rejection::InvalidGeneId, "…but is not accepted");
    }

    // A.4.3 — the frozen schema file is pinned.
    #[test]
    fn A_4_3_strict_proto_schema_frozen_sha256() {
        use sha2::{Digest, Sha256};
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/proto/p2p-wire-v1.proto");
        let bytes = std::fs::read(path).expect("read the frozen .proto");
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            FROZEN_PROTO_SCHEMA_SHA256,
            "proto/p2p-wire-v1.proto changed — a frozen schema only gains fields; \
             update the pin only together with a compatible addition"
        );
    }

    // A.4.3b — the hand-written prost tags match the .proto declarations.
    #[test]
    fn A_4_3b_struct_tags_match_the_proto() {
        let proto = include_str!("../../proto/p2p-wire-v1.proto");
        let declared: Vec<(String, u32)> = proto
            .lines()
            .map(str::trim)
            .filter(|l| !l.starts_with("//") && l.ends_with(';') && l.contains(" = "))
            .filter_map(|l| {
                let (lhs, rhs) = l.trim_end_matches(';').split_once(" = ")?;
                Some((lhs.split_whitespace().collect::<Vec<_>>().join(" "), rhs.trim().parse().ok()?))
            })
            .collect();
        let expected: Vec<(String, u32)> = [
            ("GeneAnnouncement announcement", 1),
            ("string gene_id", 1),
            ("string name", 2),
            ("string domain", 3),
            ("string fidelity", 4),
            ("string ir_spec", 5),
            ("string version", 6),
            ("uint64 timestamp_ms", 7),
        ]
        .into_iter()
        .map(|(f, t)| (f.to_string(), t))
        .collect();
        assert_eq!(declared, expected, "update WireGossipMessage / WireGeneAnnouncement with the .proto");
    }

    // A.4.4 — golden vectors from an independent encoder decode and
    // re-encode byte for byte (the second implementation of the wire format).
    #[test]
    fn A_4_4_golden_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/p2p-wire-v1/vectors.json");
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let vectors = doc["vectors"].as_array().unwrap();
        assert!(!vectors.is_empty());
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let bytes = hex::decode(v["hex"].as_str().unwrap()).unwrap();
            let f = &v["announcement"];
            let ann = GeneAnnouncement {
                gene_id: f["gene_id"].as_str().unwrap().into(),
                name: f["name"].as_str().unwrap().into(),
                domain: f["domain"].as_str().unwrap().into(),
                fidelity: f["fidelity"].as_str().unwrap().into(),
                ir_spec: f["ir_spec"].as_str().unwrap().into(),
                version: f["version"].as_str().unwrap().into(),
                timestamp_ms: f["timestamp_ms"].as_u64().unwrap(),
            };
            assert_eq!(hex::encode(encode_announcement(&ann)), v["hex"].as_str().unwrap(), "{name}: encode");
            assert_eq!(
                validate_gossip(&bytes, SRC, ann.timestamp_ms),
                Verdict::Accept(ann),
                "{name}: decode"
            );
        }
    }

    // A.4.5 — forward compatibility: a field this version does not know is ignored.
    #[test]
    fn A_4_5_strict_unknown_field_is_ignored() {
        let ann = fixture();
        // GossipMessage{ announcement{ …, field 15 = varint 1 } }
        let mut inner = WireGeneAnnouncement::from(&ann).encode_to_vec();
        inner.extend([15 << 3, 1]);
        let mut outer = vec![(1 << 3) | 2, inner.len() as u8];
        outer.extend(inner);
        assert_eq!(validate_gossip(&outer, SRC, NOW), Verdict::Accept(ann));
    }

    // A future message body (oneof tag 2, e.g. GeneRetraction) is ignored, not accepted or penalized.
    #[test]
    fn unknown_message_body_is_ignored() {
        assert_eq!(validate_gossip(&[(2 << 3) | 2, 0], SRC, NOW), Verdict::Ignore);
        assert_eq!(validate_gossip(&[], SRC, NOW), Verdict::Ignore, "empty GossipMessage has no body");
    }

    // A.4.6 — stale and far-future timestamps are rejected.
    #[test]
    fn A_4_6_timestamp_window() {
        let mut ann = fixture();
        ann.timestamp_ms = NOW - MAX_TIMESTAMP_SKEW_MS - 1;
        assert_eq!(reject(&ann), Rejection::Stale);
        ann.timestamp_ms = NOW + MAX_TIMESTAMP_SKEW_MS + 1;
        assert_eq!(reject(&ann), Rejection::Stale);
        ann.timestamp_ms = NOW - MAX_TIMESTAMP_SKEW_MS;
        assert!(matches!(validate_gossip(&encode_announcement(&ann), SRC, NOW), Verdict::Accept(_)));
    }

    #[test]
    fn timestamp_freshness_window() {
        let now = 10_000_000;
        assert!(is_timestamp_fresh(now, now));
        assert!(is_timestamp_fresh(now - MAX_TIMESTAMP_SKEW_MS, now));
        assert!(!is_timestamp_fresh(now - MAX_TIMESTAMP_SKEW_MS - 1, now));
        assert!(!is_timestamp_fresh(now + MAX_TIMESTAMP_SKEW_MS + 1, now));
    }

    #[test]
    fn field_rules() {
        let cases: Vec<(fn(&mut GeneAnnouncement), Rejection)> = vec![
            (|a| a.gene_id = "math.sort".into(), Rejection::InvalidGeneId),
            (|a| a.gene_id = a.gene_id.to_uppercase().replace("V2:", "v2:"), Rejection::InvalidGeneId),
            (|a| a.domain.clear(), Rejection::InvalidDomain),
            (|a| a.domain = "d".repeat(129), Rejection::InvalidDomain),
            (|a| a.name = "n".repeat(129), Rejection::InvalidName),
            (|a| a.fidelity = "Unknown".into(), Rejection::InvalidFidelity),
            (|a| a.fidelity = "origin".into(), Rejection::InvalidFidelity),
            (|a| a.ir_spec = "x".repeat(33), Rejection::InvalidIrSpec),
            (|a| a.fidelity = "Wrapped".into(), Rejection::InvalidIrSpec),
            (|a| a.version = "v".repeat(65), Rejection::InvalidVersion),
        ];
        for (mutate, expected) in cases {
            let mut a = fixture();
            mutate(&mut a);
            assert_eq!(reject(&a), expected, "{a:?}");
        }
    }

    #[test]
    fn unauthenticated_oversized_and_malformed_are_rejected() {
        let bytes = encode_announcement(&fixture());
        assert_eq!(validate_gossip(&bytes, None, NOW), Verdict::Reject(Rejection::Unauthenticated));
        assert_eq!(
            validate_gossip(&vec![0u8; MAX_MESSAGE_BYTES + 1], SRC, NOW),
            Verdict::Reject(Rejection::Oversized)
        );
        assert_eq!(validate_gossip(b"\xff\xff\xff", SRC, NOW), Verdict::Reject(Rejection::Malformed));
    }

    // A pre-freeze JSON announcement (npm 0.9.0–0.26.x) is never accepted.
    #[test]
    fn legacy_json_announcement_is_not_accepted() {
        let legacy = br#"{"gene_id":"my-gene","name":"my-gene","domain":"d","version":"1.0.0","fidelity":"Native","publisher":"12D3KooWsource","reputation_score":0.0,"timestamp":1760000000}"#;
        assert!(!matches!(validate_gossip(legacy, SRC, NOW), Verdict::Accept(_)));
    }

    #[test]
    fn local_announcement_builds_valid_wrapped_and_refuses_uncomputable() {
        let root = tempfile::tempdir().unwrap();
        let g = root.path().join("writer");
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(
            g.join("phenotype.json"),
            r#"{"name":"writer","domain":"content","version":"1.2.3","fidelity":"Wrapped"}"#,
        )
        .unwrap();
        std::fs::write(g.join("SKILL.md"), "# writer").unwrap();
        let ann = local_announcement(root.path(), "writer", NOW).unwrap();
        assert!(gene_id::is_valid(&ann.gene_id));
        assert_eq!((ann.version.as_str(), ann.ir_spec.as_str()), ("1.2.3", ""));
        assert_eq!(validate_gossip(&encode_announcement(&ann), SRC, NOW), Verdict::Accept(ann));

        let n = root.path().join("uncompiled");
        std::fs::create_dir_all(&n).unwrap();
        std::fs::write(n.join("phenotype.json"), r#"{"domain":"math","fidelity":"Native"}"#).unwrap();
        assert!(local_announcement(root.path(), "uncompiled", NOW).is_err());
    }
}
