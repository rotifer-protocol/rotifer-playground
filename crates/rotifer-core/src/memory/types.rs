//! AgentMemory types (spec §38.1), in their v0.9.4 wire shape: camelCase
//! fields, UPPERCASE enum values, `value` as base64 bytes, timestamps as
//! RFC 3339 UTC strings. Inside Rust and SQLite timestamps are i64
//! milliseconds; the conversion happens here, at the boundary, and nowhere
//! else (the #448 lesson: an ISO string reaching a u64).

use base64::Engine as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// §38.1 MemoryCategory.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MemoryCategory {
    /// User preferences learned through interaction. Never evicted.
    Preference,
    /// Patterns recognised across executions.
    Pattern,
    /// Accumulated domain knowledge.
    Context,
    /// Rebuildable intermediate results; may be dropped on migration.
    Cache,
}

impl MemoryCategory {
    pub const ALL: [MemoryCategory; 4] =
        [Self::Preference, Self::Pattern, Self::Context, Self::Cache];

    /// The wire / SQLite spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preference => "PREFERENCE",
            Self::Pattern => "PATTERN",
            Self::Context => "CONTEXT",
            Self::Cache => "CACHE",
        }
    }

    pub fn parse(s: &str) -> Result<Self, MemoryError> {
        Self::ALL
            .into_iter()
            .find(|c| c.as_str() == s)
            .ok_or_else(|| MemoryError::InvalidInput(format!("unknown MemoryCategory {s:?}")))
    }
}

/// §38.1 AccessScope.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AccessScope {
    CreatorGeneOnly,
    SameDomain,
    AllGenes,
    DeployerConfigured,
}

impl AccessScope {
    pub const ALL: [AccessScope; 4] = [
        Self::CreatorGeneOnly,
        Self::SameDomain,
        Self::AllGenes,
        Self::DeployerConfigured,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::CreatorGeneOnly => "CREATOR_GENE_ONLY",
            Self::SameDomain => "SAME_DOMAIN",
            Self::AllGenes => "ALL_GENES",
            Self::DeployerConfigured => "DEPLOYER_CONFIGURED",
        }
    }

    pub fn parse(s: &str) -> Result<Self, MemoryError> {
        Self::ALL
            .into_iter()
            .find(|c| c.as_str() == s)
            .ok_or_else(|| MemoryError::InvalidInput(format!("unknown AccessScope {s:?}")))
    }
}

/// §38.1 SharePolicy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SharePolicy {
    Private,
    AnonymizedShare,
    KnowledgeGene,
}

impl SharePolicy {
    pub const ALL: [SharePolicy; 3] = [Self::Private, Self::AnonymizedShare, Self::KnowledgeGene];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Private => "PRIVATE",
            Self::AnonymizedShare => "ANONYMIZED_SHARE",
            Self::KnowledgeGene => "KNOWLEDGE_GENE",
        }
    }

    pub fn parse(s: &str) -> Result<Self, MemoryError> {
        Self::ALL
            .into_iter()
            .find(|c| c.as_str() == s)
            .ok_or_else(|| MemoryError::InvalidInput(format!("unknown SharePolicy {s:?}")))
    }
}

/// §38.1 MemoryAccessPolicy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryAccessPolicy {
    pub read_scope: AccessScope,
    pub write_scope: AccessScope,
    pub share_policy: SharePolicy,
}

impl Default for MemoryAccessPolicy {
    /// The default for a write that names no policy: same-domain read and
    /// write, not shared (§38.2).
    fn default() -> Self {
        Self {
            read_scope: AccessScope::SameDomain,
            write_scope: AccessScope::SameDomain,
            share_policy: SharePolicy::Private,
        }
    }
}

/// §38.1 MemoryEntry, as it crosses every boundary.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryEntry {
    pub entry_id: String,
    pub category: MemoryCategory,
    pub key: String,
    #[serde(with = "base64_bytes")]
    pub value: Vec<u8>,
    pub created_by: String,
    pub last_accessed_by: Option<String>,
    #[serde(with = "rfc3339_ms")]
    pub created_at: i64,
    #[serde(with = "rfc3339_ms")]
    pub updated_at: i64,
    pub access_policy: MemoryAccessPolicy,
    /// §30.2 RetentionPolicy, or null to inherit the agent's DataPolicy.
    pub retention_policy: Option<RetentionPolicy>,
}

/// §30.2 RetentionPolicy, exactly: all three fields
/// are required and no others are accepted. `maxRetentionDays` is an integer
/// in 1..=2147483647 (the spec's `Int`) or null.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetentionPolicy {
    // `deserialize_with` makes the key required even though null is allowed.
    #[serde(deserialize_with = "max_retention_days")]
    pub max_retention_days: Option<u32>,
    pub auto_delete_on_termination: bool,
    pub anonymization_supported: bool,
}

/// JSON `30.0` is a float and is refused; JavaScript writes 30 as `30`, so
/// no binding sends it.
fn max_retention_days<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u32>, D::Error> {
    match Option::<serde_json::Value>::deserialize(d)? {
        None => Ok(None),
        Some(v) => v
            .as_u64()
            .filter(|n| (1..=i32::MAX as u64).contains(n))
            .map(|n| Some(n as u32))
            .ok_or_else(|| {
                serde::de::Error::custom(
                    "maxRetentionDays must be an integer from 1 to 2147483647, or null",
                )
            }),
    }
}

impl MemoryEntry {
    /// Bytes counted against the quota: key plus value.
    pub fn size(&self) -> u64 {
        (self.key.len() + self.value.len()) as u64
    }
}

/// §38.1 AgentMemory: the container a deployer or migration sees.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentMemory {
    pub agent_id: String,
    pub entries: Vec<MemoryEntry>,
    pub total_size: u64,
    pub quota: u64,
    #[serde(with = "rfc3339_ms")]
    pub created_at: i64,
}

/// §38.2 queryMemory filter, in its wire shape:
/// `{category?, keyPrefix?, since?, until?, limit?}`. `keyPrefix` is a plain
/// prefix, not a pattern; `since` (inclusive) and `until` (exclusive) bound
/// `updatedAt`; `limit` defaults to [`DEFAULT_QUERY_LIMIT`] and is capped at
/// [`MAX_QUERY_LIMIT`]. Unknown fields — aliases included — are rejected.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryFilter {
    #[serde(default)]
    pub category: Option<MemoryCategory>,
    #[serde(default)]
    pub key_prefix: Option<String>,
    #[serde(default, with = "rfc3339_ms_opt")]
    pub since: Option<i64>,
    #[serde(default, with = "rfc3339_ms_opt")]
    pub until: Option<i64>,
    #[serde(default)]
    pub limit: Option<u32>,
}

/// queryMemory's limit when the filter names none.
pub const DEFAULT_QUERY_LIMIT: u32 = 100;
/// The most entries one queryMemory returns.
pub const MAX_QUERY_LIMIT: u32 = 1000;

/// The gene making a memory call: its content-derived id (v0.9.1 identity)
/// and its declared domain, which SAME_DOMAIN compares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallerGene {
    pub gene_id: String,
    pub domain: String,
}

/// 10 MB of key + value bytes.
pub const DEFAULT_QUOTA_BYTES: u64 = 10 * 1024 * 1024;

/// Longest key accepted, in bytes. Keys are identifiers, not payloads.
pub const MAX_KEY_BYTES: usize = 1024;

/// Largest `value`, in bytes after base64 decoding. The same in every
/// binding.
pub const MAX_VALUE_BYTES: usize = 1024 * 1024;

/// Largest serialized queryMemory response. A query whose rows
/// would exceed it is refused, never truncated.
pub const MAX_QUERY_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// The shared error codes, identical across bindings.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum MemoryError {
    #[error("MEMORY_NOT_FOUND: {0}")]
    NotFound(String),
    #[error("MEMORY_ACCESS_DENIED: {0}")]
    AccessDenied(String),
    #[error("MEMORY_QUOTA_EXCEEDED: {0}")]
    QuotaExceeded(String),
    #[error("MEMORY_INVALID_INPUT: {0}")]
    InvalidInput(String),
    /// The store itself failed (disk, SQLite), not the request.
    #[error("MEMORY_STORAGE_ERROR: {0}")]
    Storage(String),
}

impl MemoryError {
    /// The error code, as it appears on the wire.
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "MEMORY_NOT_FOUND",
            Self::AccessDenied(_) => "MEMORY_ACCESS_DENIED",
            Self::QuotaExceeded(_) => "MEMORY_QUOTA_EXCEEDED",
            Self::InvalidInput(_) => "MEMORY_INVALID_INPUT",
            Self::Storage(_) => "MEMORY_STORAGE_ERROR",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::NotFound(m)
            | Self::AccessDenied(m)
            | Self::QuotaExceeded(m)
            | Self::InvalidInput(m)
            | Self::Storage(m) => m,
        }
    }
}

impl From<rusqlite::Error> for MemoryError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Storage(e.to_string())
    }
}

/// Lowercase hex SHA-256 of `agentId + "\0" + key`. Stable for
/// the life of the entry, so an update keeps its id.
pub fn entry_id(agent_id: &str, key: &str) -> String {
    let mut h = Sha256::new();
    h.update(agent_id.as_bytes());
    h.update([0u8]);
    h.update(key.as_bytes());
    hex::encode(h.finalize())
}

/// Parse an RFC 3339 timestamp into UTC epoch milliseconds.
pub fn parse_rfc3339_ms(s: &str) -> Result<i64, MemoryError> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|t| t.timestamp_millis())
        .map_err(|e| MemoryError::InvalidInput(format!("timestamp {s:?} is not RFC 3339: {e}")))
}

/// Format epoch milliseconds as an RFC 3339 UTC string with millisecond precision.
pub fn format_rfc3339_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub(crate) mod base64_bytes {
    use super::*;

    pub fn serialize<S: Serializer>(v: &[u8], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&base64::engine::general_purpose::STANDARD.encode(v))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        base64::engine::general_purpose::STANDARD
            .decode(s.as_bytes())
            .map_err(|e| {
                serde::de::Error::custom(format!("value is not standard padded base64: {e}"))
            })
    }
}

mod rfc3339_ms {
    use super::*;

    pub fn serialize<S: Serializer>(ms: &i64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&format_rfc3339_ms(*ms))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
        let s = String::deserialize(d)?;
        parse_rfc3339_ms(&s).map_err(serde::de::Error::custom)
    }
}

mod rfc3339_ms_opt {
    use super::*;

    pub fn serialize<S: Serializer>(ms: &Option<i64>, s: S) -> Result<S::Ok, S::Error> {
        match ms {
            Some(ms) => s.serialize_str(&format_rfc3339_ms(*ms)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|s| parse_rfc3339_ms(&s).map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MemoryEntry {
        MemoryEntry {
            entry_id: entry_id("agent-1", "lang"),
            category: MemoryCategory::Preference,
            key: "lang".into(),
            value: b"zh-CN".to_vec(),
            created_by: "v2:aa".into(),
            last_accessed_by: None,
            created_at: 1_761_800_000_123,
            updated_at: 1_761_800_000_456,
            access_policy: MemoryAccessPolicy::default(),
            retention_policy: None,
        }
    }

    #[test]
    fn wire_shape_is_camel_case_with_uppercase_enums_base64_and_rfc3339() {
        let v = serde_json::to_value(sample()).unwrap();
        let keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        for k in [
            "entryId",
            "category",
            "key",
            "value",
            "createdBy",
            "lastAccessedBy",
            "createdAt",
            "updatedAt",
            "accessPolicy",
            "retentionPolicy",
        ] {
            assert!(keys.contains(&k), "missing {k} in {keys:?}");
        }
        assert_eq!(keys.len(), 10);
        assert_eq!(v["category"], "PREFERENCE");
        assert_eq!(v["value"], "emgtQ04=");
        assert_eq!(v["createdAt"], "2025-10-30T04:53:20.123Z");
        assert_eq!(
            v["accessPolicy"],
            serde_json::json!({"readScope": "SAME_DOMAIN", "writeScope": "SAME_DOMAIN", "sharePolicy": "PRIVATE"})
        );
        assert!(v["retentionPolicy"].is_null());
    }

    #[test]
    fn retention_policy_round_trips_and_requires_every_field() {
        let r = RetentionPolicy {
            max_retention_days: None,
            auto_delete_on_termination: true,
            anonymization_supported: false,
        };
        let v = serde_json::to_value(r).unwrap();
        assert_eq!(
            v,
            serde_json::json!({"maxRetentionDays": null, "autoDeleteOnTermination": true, "anonymizationSupported": false})
        );
        assert_eq!(serde_json::from_value::<RetentionPolicy>(v).unwrap(), r);
        // Nullable is not optional: the key must be there.
        let missing =
            serde_json::json!({"autoDeleteOnTermination": true, "anonymizationSupported": false});
        assert!(serde_json::from_value::<RetentionPolicy>(missing).is_err());
        let max = serde_json::json!({"maxRetentionDays": 2147483647, "autoDeleteOnTermination": false, "anonymizationSupported": true});
        assert_eq!(
            serde_json::from_value::<RetentionPolicy>(max)
                .unwrap()
                .max_retention_days,
            Some(i32::MAX as u32)
        );
    }

    #[test]
    fn round_trips_through_json() {
        let e = sample();
        let back: MemoryEntry = serde_json::from_str(&serde_json::to_string(&e).unwrap()).unwrap();
        assert_eq!(back, e);
    }

    #[test]
    fn rejects_lowercase_enums_bad_base64_and_unknown_fields() {
        let mut v = serde_json::to_value(sample()).unwrap();
        v["category"] = "preference".into();
        assert!(serde_json::from_value::<MemoryEntry>(v.clone()).is_err());
        v["category"] = "PREFERENCE".into();
        v["value"] = "not base64!".into();
        assert!(serde_json::from_value::<MemoryEntry>(v.clone()).is_err());
        v["value"] = "emgtQ04=".into();
        v["extra"] = 1.into();
        assert!(serde_json::from_value::<MemoryEntry>(v).is_err());
    }

    #[test]
    fn a_timestamp_must_be_rfc3339_not_a_bare_number() {
        let mut v = serde_json::to_value(sample()).unwrap();
        v["createdAt"] = 1_761_800_000_123i64.into();
        assert!(serde_json::from_value::<MemoryEntry>(v).is_err());
    }

    #[test]
    fn entry_id_is_sha256_of_agent_nul_key_and_stable() {
        let id = entry_id("agent-1", "lang");
        assert_eq!(id.len(), 64);
        assert_eq!(id, id.to_lowercase());
        assert_eq!(id, entry_id("agent-1", "lang"));
        assert_ne!(id, entry_id("agent-1", "lang2"));
        // The NUL separator keeps ("a", "bc") and ("ab", "c") apart.
        assert_ne!(entry_id("a", "bc"), entry_id("ab", "c"));
        let mut h = Sha256::new();
        h.update(b"agent-1\0lang");
        assert_eq!(id, hex::encode(h.finalize()));
    }

    #[test]
    fn enum_parsers_accept_only_the_wire_spellings() {
        for c in MemoryCategory::ALL {
            assert_eq!(MemoryCategory::parse(c.as_str()).unwrap(), c);
        }
        for s in AccessScope::ALL {
            assert_eq!(AccessScope::parse(s.as_str()).unwrap(), s);
        }
        for p in SharePolicy::ALL {
            assert_eq!(SharePolicy::parse(p.as_str()).unwrap(), p);
        }
        assert!(matches!(
            MemoryCategory::parse("cache"),
            Err(MemoryError::InvalidInput(_))
        ));
        assert!(AccessScope::parse("same_domain").is_err());
        assert!(SharePolicy::parse("").is_err());
    }

    #[test]
    fn filter_reads_rfc3339_bounds_and_defaults_to_empty() {
        let f: MemoryFilter = serde_json::from_str(
            r#"{"category":"CACHE","keyPrefix":"q.","since":"2025-10-30T04:53:20.000Z","limit":5}"#,
        )
        .unwrap();
        assert_eq!(f.category, Some(MemoryCategory::Cache));
        assert_eq!(f.since, Some(1_761_800_000_000));
        assert_eq!(f.until, None);
        assert_eq!(
            serde_json::from_str::<MemoryFilter>("{}").unwrap(),
            MemoryFilter::default()
        );
        // The wire names are final; no binding accepts an alias.
        for alias in [
            r#"{"updatedAfter":"2025-10-30T04:53:20.000Z"}"#,
            r#"{"from":"x"}"#,
            r#"{"timeField":"x"}"#,
        ] {
            assert!(
                serde_json::from_str::<MemoryFilter>(alias).is_err(),
                "{alias}"
            );
        }
    }

    #[test]
    fn error_codes_are_the_wire_codes() {
        assert_eq!(MemoryError::NotFound("x".into()).code(), "MEMORY_NOT_FOUND");
        assert_eq!(
            MemoryError::AccessDenied("x".into()).code(),
            "MEMORY_ACCESS_DENIED"
        );
        assert_eq!(
            MemoryError::QuotaExceeded("x".into()).code(),
            "MEMORY_QUOTA_EXCEEDED"
        );
        assert_eq!(
            MemoryError::InvalidInput("x".into()).code(),
            "MEMORY_INVALID_INPUT"
        );
        assert_eq!(
            MemoryError::AccessDenied("no".into()).to_string(),
            "MEMORY_ACCESS_DENIED: no"
        );
    }
}
