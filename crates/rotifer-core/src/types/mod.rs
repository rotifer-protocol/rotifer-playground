//! Protocol-wide types shared across all Rotifer subsystems.

pub mod gene;
pub mod agent;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

/// Content-addressable identifier for a gene — SHA-256 digest (32 bytes).
pub type GeneId = [u8; 32];
/// Millisecond-precision UTC timestamp.
pub type Timestamp = u64;
/// Unbounded reputation score for an agent (higher is better).
pub type ReputationScore = f64;

/// Encode a [`GeneId`] as a lowercase hex string (64 chars).
pub fn gene_id_to_hex(id: &GeneId) -> String {
    hex::encode(id)
}

/// Compute a [`GeneId`] by SHA-256 hashing arbitrary content bytes.
pub fn compute_gene_id(content: &[u8]) -> GeneId {
    let mut hasher = Sha256::new();
    hasher.update(content);
    let result = hasher.finalize();
    let mut id = [0u8; 32];
    id.copy_from_slice(&result);
    id
}

/// Execution context passed to every gene invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Context {
    pub agent_id: String,
    pub timestamp: Timestamp,
    pub permissions: PermissionSet,
    pub trace_id: Option<String>,
    /// Binding-specific extensions (e.g. HTTP headers, chain data).
    pub binding_extensions: Option<HashMap<String, serde_json::Value>>,
}

/// Permission boundary for gene execution.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PermissionSet {
    pub allowed_domains: Option<Vec<String>>,
    pub resource_limits: ResourceLimits,
    pub network_access: bool,
    pub file_system_access: Option<Vec<String>>,
}

/// Hard resource caps enforced by the sandbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceLimits {
    pub max_memory_bytes: Option<u64>,
    pub max_execution_time_ms: Option<u64>,
    pub max_fuel_units: Option<u64>,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            max_memory_bytes: Some(64 * 1024 * 1024), // 64 MB
            max_execution_time_ms: Some(30_000),       // 30s
            max_fuel_units: Some(1_000_000),
        }
    }
}


/// Outcome of a single gene execution — either success with data or a typed error.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum GeneResult {
    /// Gene completed successfully.
    Success {
        data: serde_json::Value,
        metadata: ExecutionMetadata,
    },
    /// Gene failed with a categorized error.
    Error {
        code: ErrorCode,
        message: String,
        retryable: bool,
        details: Option<serde_json::Value>,
    },
}

/// Telemetry captured during a single gene invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionMetadata {
    pub duration_ms: u64,
    pub resource_cost: f64,
    pub cache_hit: Option<bool>,
    /// Host-side metering for hybrid genes (ADR-327 D4). `None` for pure
    /// Native runs — absent from serialized output, so stored records are
    /// unchanged for non-hybrid executions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<HostMetering>,
}

/// IR spec §6.1 "metering participation" made concrete: what the gene spent
/// inside host functions, on top of (not instead of) the fuel surcharges
/// already deducted per call (ADR-327 D4).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HostMetering {
    /// Total wall time spent inside host functions.
    pub host_call_millis: u64,
    /// Number of hybrid host function invocations.
    pub host_calls: u64,
    /// Payload bytes crossing the boundary into the guest.
    pub host_bytes_in: u64,
    /// Payload bytes crossing the boundary out of the guest.
    pub host_bytes_out: u64,
}

/// Standardized error codes per Rotifer spec §6.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorCode {
    InvalidInput,
    ExecutionFailure,
    Timeout,
    PermissionDenied,
    ResourceExhausted,
    DependencyFailed,
    SandboxViolation,
    InternalError,
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInput => write!(f, "INVALID_INPUT"),
            Self::ExecutionFailure => write!(f, "EXECUTION_FAILURE"),
            Self::Timeout => write!(f, "TIMEOUT"),
            Self::PermissionDenied => write!(f, "PERMISSION_DENIED"),
            Self::ResourceExhausted => write!(f, "RESOURCE_EXHAUSTED"),
            Self::DependencyFailed => write!(f, "DEPENDENCY_FAILED"),
            Self::SandboxViolation => write!(f, "SANDBOX_VIOLATION"),
            Self::InternalError => write!(f, "INTERNAL_ERROR"),
        }
    }
}

/// Strategy for handling errors in multi-gene compositions.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ErrorPolicy {
    /// Abort the entire composition on first error.
    Fail,
    /// Skip the failed gene and continue.
    Skip,
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::gene::{Gene, Phenotype, Fidelity, GeneTransparency};

    #[test]
    fn compute_gene_id_deterministic() {
        let a = compute_gene_id(b"hello");
        let b = compute_gene_id(b"hello");
        assert_eq!(a, b);
    }

    #[test]
    fn compute_gene_id_different_content() {
        let a = compute_gene_id(b"aaa");
        let b = compute_gene_id(b"bbb");
        assert_ne!(a, b);
    }

    #[test]
    fn compute_gene_id_empty_content() {
        let id = compute_gene_id(&[]);
        // SHA-256 of empty input is a known constant
        assert_ne!(id, [0u8; 32], "hash of empty should not be all zeros");
    }

    #[test]
    fn gene_id_to_hex_format() {
        let id = compute_gene_id(b"test");
        let hex = gene_id_to_hex(&id);
        assert_eq!(hex.len(), 64);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(hex.chars().all(|c| !c.is_ascii_uppercase()));
    }

    #[test]
    fn gene_serde_roundtrip() {
        let gene = Gene {
            id: compute_gene_id(b"rt"),
            phenotype: Phenotype {
                domain: "test.domain".into(),
                input_schema: serde_json::json!({"type": "object"}),
                output_schema: serde_json::json!({"type": "string"}),
                dependencies: vec![[1u8; 32]],
                version: "1.0.0".into(),
                author: "alice".into(),
                created_at: 12345,
                ir_hash: Some([2u8; 32]),
                fidelity: Fidelity::Native,
                source_framework: Some("rust".into()),
                regulatory_tags: Some(vec!["gdpr".into()]),
                transparency: GeneTransparency::Open,
                streaming_capability: None,
                pricing_hint: None,
                semantic_requirements: None,
                network: None,
                external_dependencies: None,
            llm_requirements: None,
            guard_config: None,
            },
            wasm_bytes: Some(vec![0, 97, 115, 109]),
            source_code: Some("fn main() {}".into()),
        };
        let json = serde_json::to_string(&gene).unwrap();
        let decoded: Gene = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.id, gene.id);
        assert_eq!(decoded.phenotype.domain, gene.phenotype.domain);
        assert_eq!(decoded.wasm_bytes, gene.wasm_bytes);
        assert_eq!(decoded.source_code, gene.source_code);
    }

    #[test]
    fn gene_serde_with_optional_fields_none() {
        let gene = Gene {
            id: [0u8; 32],
            phenotype: Phenotype {
                domain: "d".into(),
                input_schema: serde_json::json!({}),
                output_schema: serde_json::json!({}),
                dependencies: vec![],
                version: "0.1.0".into(),
                author: "a".into(),
                created_at: 0,
                ir_hash: None,
                fidelity: Fidelity::Wrapped,
                source_framework: None,
                regulatory_tags: None,
                transparency: GeneTransparency::Opaque,
                streaming_capability: None,
                pricing_hint: None,
                semantic_requirements: None,
                network: None,
                external_dependencies: None,
            llm_requirements: None,
            guard_config: None,
            },
            wasm_bytes: None,
            source_code: None,
        };
        let json = serde_json::to_string(&gene).unwrap();
        let decoded: Gene = serde_json::from_str(&json).unwrap();
        assert!(decoded.wasm_bytes.is_none());
        assert!(decoded.source_code.is_none());
        assert!(decoded.phenotype.ir_hash.is_none());
    }

    #[test]
    fn context_serde_roundtrip() {
        let mut ext = HashMap::new();
        ext.insert("key".into(), serde_json::json!("value"));
        let ctx = Context {
            agent_id: "agent-1".into(),
            timestamp: 99999,
            permissions: PermissionSet::default(),
            trace_id: Some("trace-abc".into()),
            binding_extensions: Some(ext),
        };
        let json = serde_json::to_string(&ctx).unwrap();
        let decoded: Context = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.agent_id, "agent-1");
        assert_eq!(decoded.trace_id.unwrap(), "trace-abc");
        assert!(decoded.binding_extensions.unwrap().contains_key("key"));
    }

    #[test]
    fn error_code_display_all_variants() {
        assert_eq!(ErrorCode::InvalidInput.to_string(), "INVALID_INPUT");
        assert_eq!(ErrorCode::ExecutionFailure.to_string(), "EXECUTION_FAILURE");
        assert_eq!(ErrorCode::Timeout.to_string(), "TIMEOUT");
        assert_eq!(ErrorCode::PermissionDenied.to_string(), "PERMISSION_DENIED");
        assert_eq!(ErrorCode::ResourceExhausted.to_string(), "RESOURCE_EXHAUSTED");
        assert_eq!(ErrorCode::DependencyFailed.to_string(), "DEPENDENCY_FAILED");
        assert_eq!(ErrorCode::SandboxViolation.to_string(), "SANDBOX_VIOLATION");
        assert_eq!(ErrorCode::InternalError.to_string(), "INTERNAL_ERROR");
    }

    #[test]
    fn resource_limits_default_values() {
        let rl = ResourceLimits::default();
        assert_eq!(rl.max_memory_bytes, Some(64 * 1024 * 1024));
        assert_eq!(rl.max_execution_time_ms, Some(30_000));
        assert_eq!(rl.max_fuel_units, Some(1_000_000));
    }

    #[test]
    fn permission_set_default() {
        let ps = PermissionSet::default();
        assert!(!ps.network_access);
        assert!(ps.allowed_domains.is_none());
        assert!(ps.file_system_access.is_none());
    }
}
