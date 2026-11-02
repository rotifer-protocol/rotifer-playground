//! P2P node heartbeat v1 — frozen (`proto/p2p-heartbeat-v1.proto`, ADR-300 D6).
//!
//! A node publishes a [`WireNodeHeartbeat`] on [`HEARTBEATS_TOPIC`] every
//! [`HEARTBEAT_INTERVAL_SECS`]. Like the wire-v1 announcement, the type mirrors
//! the `.proto` by hand (`prost` derive, no build-time `protoc`); tests pin the
//! file's sha256, check the field tags against it, and decode/encode golden
//! vectors from an independent encoder (`scripts/p2p-heartbeat-v1-reference.py`).
//!
//! [`validate_heartbeat`] is the topic's registered validator: it checks what
//! needs no state — size, encoding, field limits, the time window. A heartbeat
//! that passes comes back as [`Verdict::Heartbeat`]; the node then checks its
//! attestation and its sender's rate and history before deciding (`por.rs`).

use prost::Message as _;

use super::messages::{Rejection, Verdict};

/// GossipSub topic carrying node heartbeats (ADR-300 D6). One topic, one
/// schema: an incompatible heartbeat gets `/rotifer/p2p/2/heartbeats`.
pub const HEARTBEATS_TOPIC: &str = "/rotifer/p2p/1/heartbeats";

/// How often a node publishes its heartbeat (P2P RFC §6.3.4).
pub const HEARTBEAT_INTERVAL_SECS: u64 = 5 * 60;

/// sha256 of `proto/p2p-heartbeat-v1.proto` — the frozen schema.
pub const FROZEN_HEARTBEAT_PROTO_SHA256: &str =
    "03001da13e46236439cc573761d8c246145e621ca2cef71305cea88ac3e1bcd4";

/// Resource limits (ADR-300 locked contract v2, "心跳处理"). Implementations
/// may tighten these, never loosen them.
pub const MAX_HEARTBEAT_BYTES: usize = 4 * 1024;
pub const MAX_ATTESTATION_BYTES: usize = 2 * 1024;
pub const MAX_VERSION_BYTES: usize = 64;
pub const MAX_BINDINGS: usize = 16;
pub const MAX_BINDING_BYTES: usize = 64;

/// Accepted clock skew: a heartbeat may be up to 300 s old, but at most 60 s
/// ahead of the receiver's clock. A wider future window would let a sender
/// stretch a heartbeat's useful life past the duplicate cache (R11).
pub const MAX_PAST_SKEW_MS: u64 = 300_000;
pub const MAX_FUTURE_SKEW_MS: u64 = 60_000;

/// `NodeHeartbeat` (wire tag numbers as in the .proto).
#[derive(Clone, PartialEq, Eq, prost::Message)]
pub struct WireNodeHeartbeat {
    #[prost(uint32, tag = "1")]
    pub genes_hosted: u32,
    #[prost(uint64, tag = "2")]
    pub uptime_seconds: u64,
    #[prost(string, tag = "3")]
    pub rotifer_version: String,
    #[prost(string, repeated, tag = "4")]
    pub bindings: Vec<String>,
    #[prost(bytes = "vec", tag = "5")]
    pub cloud_attestation: Vec<u8>,
    #[prost(uint64, tag = "6")]
    pub timestamp_ms: u64,
}

impl WireNodeHeartbeat {
    /// The attestation token, if the heartbeat carries one.
    pub fn attestation(&self) -> Option<&[u8]> {
        (!self.cloud_attestation.is_empty()).then_some(self.cloud_attestation.as_slice())
    }
}

/// Encode a heartbeat as the topic's payload.
pub fn encode_heartbeat(hb: &WireNodeHeartbeat) -> Vec<u8> {
    hb.encode_to_vec()
}

/// `MAJOR.MINOR.PATCH`, each a run of ASCII digits, optionally followed by a
/// `-` pre-release or `+` build suffix of `[0-9A-Za-z.+-]`.
pub fn is_version(v: &str) -> bool {
    let (core, suffix) = match v.find(['-', '+']) {
        Some(i) => (&v[..i], &v[i + 1..]),
        None => (v, ""),
    };
    let parts: Vec<&str> = core.split('.').collect();
    let core_ok = parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    let suffix_ok = suffix.bytes().all(|b| b.is_ascii_alphanumeric() || b"+-.".contains(&b));
    let suffix_present_if_marked = core.len() == v.len() || !suffix.is_empty();
    core_ok && suffix_ok && suffix_present_if_marked
}

/// Whether `timestamp_ms` is inside the heartbeat window around `now_ms`.
pub fn is_heartbeat_fresh(timestamp_ms: u64, now_ms: u64) -> bool {
    let lower = now_ms.saturating_sub(MAX_PAST_SKEW_MS);
    let upper = now_ms.saturating_add(MAX_FUTURE_SKEW_MS);
    (lower..=upper).contains(&timestamp_ms)
}

/// Field rules a sender and a receiver both enforce.
pub fn check_heartbeat_fields(hb: &WireNodeHeartbeat) -> Result<(), Rejection> {
    if hb.rotifer_version.len() > MAX_VERSION_BYTES || !is_version(&hb.rotifer_version) {
        return Err(Rejection::InvalidVersion);
    }
    if hb.bindings.len() > MAX_BINDINGS || hb.bindings.iter().any(|b| b.len() > MAX_BINDING_BYTES) {
        return Err(Rejection::InvalidBindings);
    }
    if hb.cloud_attestation.len() > MAX_ATTESTATION_BYTES {
        return Err(Rejection::OversizedAttestation);
    }
    Ok(())
}

/// Validate a message received on [`HEARTBEATS_TOPIC`]: everything that needs
/// no state. `source` is the GossipSub-authenticated publisher, the node the
/// heartbeat describes.
pub fn validate_heartbeat(data: &[u8], source: Option<&str>, now_ms: u64) -> Verdict {
    if data.len() > MAX_HEARTBEAT_BYTES {
        return Verdict::Reject(Rejection::Oversized);
    }
    if source.is_none() {
        return Verdict::Reject(Rejection::Unauthenticated);
    }
    let Ok(hb) = WireNodeHeartbeat::decode(data) else {
        return Verdict::Reject(Rejection::Malformed);
    };
    if let Err(r) = check_heartbeat_fields(&hb) {
        return Verdict::Reject(r);
    }
    if !is_heartbeat_fresh(hb.timestamp_ms, now_ms) {
        return Verdict::Reject(Rejection::Stale);
    }
    Verdict::Heartbeat(Box::new(hb))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_760_000_000_000;
    const SRC: Option<&str> = Some("12D3KooWsource");

    fn fixture() -> WireNodeHeartbeat {
        WireNodeHeartbeat {
            genes_hosted: 3,
            uptime_seconds: 600,
            rotifer_version: "0.34.0".into(),
            bindings: vec!["local".into()],
            cloud_attestation: Vec::new(),
            timestamp_ms: NOW,
        }
    }

    fn verdict(hb: &WireNodeHeartbeat) -> Verdict {
        validate_heartbeat(&encode_heartbeat(hb), SRC, NOW)
    }

    #[test]
    fn heartbeat_proto_schema_frozen_sha256() {
        use sha2::{Digest, Sha256};
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/proto/p2p-heartbeat-v1.proto");
        let bytes = std::fs::read(path).expect("read the frozen .proto");
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            FROZEN_HEARTBEAT_PROTO_SHA256,
            "proto/p2p-heartbeat-v1.proto changed — a frozen schema only gains fields; \
             update the pin only together with a compatible addition"
        );
    }

    #[test]
    fn heartbeat_struct_tags_match_the_proto() {
        let proto = include_str!("../../proto/p2p-heartbeat-v1.proto");
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
            ("uint32 genes_hosted", 1),
            ("uint64 uptime_seconds", 2),
            ("string rotifer_version", 3),
            ("repeated string bindings", 4),
            ("bytes cloud_attestation", 5),
            ("uint64 timestamp_ms", 6),
        ]
        .into_iter()
        .map(|(f, t)| (f.to_string(), t))
        .collect();
        assert_eq!(declared, expected, "update WireNodeHeartbeat with the .proto");
    }

    // Golden vectors from an independent encoder decode and re-encode byte
    // for byte.
    #[test]
    fn heartbeat_golden_vectors() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/p2p-heartbeat-v1/vectors.json");
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let vectors = doc["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 4);
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let f = &v["heartbeat"];
            let hb = WireNodeHeartbeat {
                genes_hosted: f["genes_hosted"].as_u64().unwrap() as u32,
                uptime_seconds: f["uptime_seconds"].as_u64().unwrap(),
                rotifer_version: f["rotifer_version"].as_str().unwrap().into(),
                bindings: f["bindings"].as_array().unwrap().iter().map(|b| b.as_str().unwrap().into()).collect(),
                cloud_attestation: f["cloud_attestation"].as_str().unwrap().as_bytes().to_vec(),
                timestamp_ms: f["timestamp_ms"].as_u64().unwrap(),
            };
            let hex = v["hex"].as_str().unwrap();
            assert_eq!(hex::encode(encode_heartbeat(&hb)), hex, "{name}: encode");
            let decoded = WireNodeHeartbeat::decode(hex::decode(hex).unwrap().as_slice()).expect("decode");
            assert_eq!(decoded, hb, "{name}: decode");
            let verdict = validate_heartbeat(&hex::decode(hex).unwrap(), SRC, hb.timestamp_ms);
            assert_eq!(verdict, Verdict::Heartbeat(Box::new(hb)), "{name}: validate");
        }
    }

    #[test]
    fn a_valid_heartbeat_passes_with_its_fields() {
        let hb = fixture();
        assert_eq!(verdict(&hb), Verdict::Heartbeat(Box::new(hb)));
    }

    // R11: 300 s into the past, only 60 s into the future.
    #[test]
    fn heartbeat_time_window_is_asymmetric() {
        let at = |ts: u64| {
            let mut hb = fixture();
            hb.timestamp_ms = ts;
            verdict(&hb)
        };
        assert!(matches!(at(NOW - MAX_PAST_SKEW_MS), Verdict::Heartbeat(_)));
        assert!(matches!(at(NOW + MAX_FUTURE_SKEW_MS), Verdict::Heartbeat(_)));
        assert_eq!(at(NOW - MAX_PAST_SKEW_MS - 1), Verdict::Reject(Rejection::Stale));
        assert_eq!(at(NOW + MAX_FUTURE_SKEW_MS + 1), Verdict::Reject(Rejection::Stale));
        assert_eq!(at(NOW + 299_000), Verdict::Reject(Rejection::Stale), "the announcement window's future half does not apply");
    }

    // R18: every limit is enforced, at exactly one past the limit.
    #[test]
    fn heartbeat_resource_limits() {
        let cases: Vec<(fn(&mut WireNodeHeartbeat), Rejection)> = vec![
            (|h| h.rotifer_version = format!("1.0.0-{}", "a".repeat(MAX_VERSION_BYTES - 5)), Rejection::InvalidVersion),
            (|h| h.bindings = vec!["b".into(); MAX_BINDINGS + 1], Rejection::InvalidBindings),
            (|h| h.bindings = vec!["b".repeat(MAX_BINDING_BYTES + 1)], Rejection::InvalidBindings),
            (|h| h.cloud_attestation = vec![b'a'; MAX_ATTESTATION_BYTES + 1], Rejection::OversizedAttestation),
        ];
        for (mutate, expected) in cases {
            let mut hb = fixture();
            mutate(&mut hb);
            assert_eq!(verdict(&hb), Verdict::Reject(expected), "{hb:?}");
        }
        let mut at_limit = fixture();
        at_limit.rotifer_version = format!("1.0.0-{}", "a".repeat(MAX_VERSION_BYTES - 6));
        at_limit.bindings = vec!["b".repeat(MAX_BINDING_BYTES); MAX_BINDINGS];
        at_limit.cloud_attestation = vec![b'a'; MAX_ATTESTATION_BYTES];
        assert!(matches!(verdict(&at_limit), Verdict::Heartbeat(_)), "exactly at every limit is fine");
        assert_eq!(
            validate_heartbeat(&vec![0u8; MAX_HEARTBEAT_BYTES + 1], SRC, NOW),
            Verdict::Reject(Rejection::Oversized)
        );
    }

    #[test]
    fn unauthenticated_and_malformed_heartbeats_are_rejected() {
        let bytes = encode_heartbeat(&fixture());
        assert_eq!(validate_heartbeat(&bytes, None, NOW), Verdict::Reject(Rejection::Unauthenticated));
        assert_eq!(validate_heartbeat(b"\xff\xff\xff", SRC, NOW), Verdict::Reject(Rejection::Malformed));
    }

    #[test]
    fn rotifer_version_must_parse() {
        for ok in ["0.34.0", "1.0.0-rc.1", "1.0.0+build.7", "10.20.30-alpha.1+x"] {
            assert!(is_version(ok), "{ok}");
        }
        for bad in ["", "1.0", "1.0.0.0", "v1.0.0", "1.0.0-", "1.0.0+", "1..0", "1.0.0-rc 1", "a.b.c"] {
            assert!(!is_version(bad), "{bad}");
        }
        let mut hb = fixture();
        hb.rotifer_version.clear();
        assert_eq!(verdict(&hb), Verdict::Reject(Rejection::InvalidVersion), "the version is required");
    }

    // A field this version does not know is ignored, not rejected.
    #[test]
    fn unknown_heartbeat_field_is_ignored() {
        let hb = fixture();
        let mut bytes = encode_heartbeat(&hb);
        bytes.extend([15 << 3, 1]);
        assert_eq!(validate_heartbeat(&bytes, SRC, NOW), Verdict::Heartbeat(Box::new(hb)));
    }
}
