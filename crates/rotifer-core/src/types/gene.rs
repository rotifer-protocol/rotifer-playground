//! Gene and Phenotype definitions — the atomic unit of capability in Rotifer.

use serde::{Deserialize, Serialize};

use super::{GeneId, Timestamp};

fn default_fidelity() -> Fidelity {
    Fidelity::Wrapped
}
fn default_transparency() -> GeneTransparency {
    GeneTransparency::Open
}

/// Metadata describing a gene's interface, lineage, and runtime characteristics.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Phenotype {
    pub domain: String,
    pub input_schema: serde_json::Value,
    pub output_schema: serde_json::Value,
    #[serde(default)]
    pub dependencies: Vec<GeneId>,
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub created_at: Timestamp,
    #[serde(default)]
    pub ir_hash: Option<GeneId>,
    #[serde(default = "default_fidelity")]
    pub fidelity: Fidelity,
    #[serde(default)]
    pub source_framework: Option<String>,
    #[serde(default)]
    pub regulatory_tags: Option<Vec<String>>,
    #[serde(default = "default_transparency")]
    pub transparency: GeneTransparency,
    #[serde(default)]
    pub streaming_capability: Option<StreamingCapability>,
    #[serde(default)]
    pub pricing_hint: Option<PricingHint>,
    #[serde(default)]
    pub semantic_requirements: Option<SemanticRequirements>,
    /// Network access configuration for Hybrid genes.
    #[serde(default)]
    pub network: Option<NetworkConfig>,
    /// LLM-specific metadata for Prompt Genes (optional, forward-compatible).
    #[serde(default)]
    pub llm_requirements: Option<LlmRequirements>,
    /// Guard-specific metadata for Guard Genes (optional, forward-compatible).
    #[serde(default)]
    pub guard_config: Option<GuardConfig>,
}

/// Controlled network access declaration for Hybrid genes.
/// The runtime enforces these constraints via a gateway proxy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkConfig {
    /// Domains the gene is permitted to reach (e.g. `["api.anthropic.com"]`).
    pub allowed_domains: Vec<String>,
    /// Per-request timeout in milliseconds (default 30 000).
    #[serde(default = "default_max_timeout_ms")]
    pub max_timeout_ms: u32,
    /// Maximum response body size in bytes (default 1 MiB).
    #[serde(default = "default_max_response_bytes")]
    pub max_response_bytes: u64,
    /// Maximum requests per minute (default 10).
    #[serde(default = "default_max_requests_per_min")]
    pub max_requests_per_min: u32,
}

fn default_max_timeout_ms() -> u32 { 30_000 }
fn default_max_response_bytes() -> u64 { 1_048_576 }
fn default_max_requests_per_min() -> u32 { 10 }

/// How faithfully a gene's logic maps to its WASM representation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Fidelity {
    /// Thin envelope around an external API call.
    Wrapped,
    /// Mix of native WASM logic and external calls.
    Hybrid,
    /// Entire logic is pure WASM — fully sandboxed.
    Native,
    /// Fallback for forward compatibility — older versions deserialize
    /// unknown future fidelity levels without crashing.
    #[serde(other)]
    Unknown,
}

/// Whether a gene's source code is publicly auditable.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum GeneTransparency {
    /// Source available for audit.
    Open,
    /// Source not disclosed.
    Opaque,
    /// Fallback for forward compatibility.
    #[serde(other)]
    Unknown,
}

/// Declares whether a gene supports streaming output.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamingCapability {
    pub mode: StreamingMode,
    pub chunk_schema: Option<serde_json::Value>,
    pub estimated_chunks: Option<u32>,
}

/// I/O mode for gene communication.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum StreamingMode {
    /// Single request → single response.
    RequestResponse,
    /// Output delivered in chunks.
    Streaming,
    /// Supports both modes.
    Hybrid,
}

/// Advisory pricing information attached to a gene.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PricingHint {
    pub model: PricingModel,
    pub estimated_cost: Option<String>,
    pub currency: Option<String>,
    pub details: Option<String>,
}

/// Billing model for a gene's invocation cost.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PricingModel {
    Free,
    PerCall,
    Subscription,
    Negotiated,
    Unknown,
}

/// Non-functional requirements that constrain how a gene may be composed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticRequirements {
    pub time_model: Option<TimeModel>,
    pub concurrency_model: Option<ConcurrencyModel>,
    pub persistence_guarantee: Option<PersistenceGuarantee>,
    pub failure_semantics: Option<EventualFailureSemantics>,
    pub cost_model: Option<CostModel>,
}

/// How the gene perceives time.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum TimeModel {
    WallClock,
    BlockTime,
    RealTime,
    Logical,
    Sync,
    Async,
}

/// Concurrency guarantees a gene requires from the runtime.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ConcurrencyModel {
    Serialized,
    AsyncEventual,
    Cooperative,
    Preemptive,
    Stateless,
}

/// Durability guarantees for gene outputs.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum PersistenceGuarantee {
    Immutable,
    Durable,
    Volatile,
    BestEffort,
}

/// How a gene behaves when an external dependency is unreachable
/// (spec §4.2 `DegradationBehavior`, the external-dependency axis).
///
/// One of three orthogonal degradation axes (ADR-220 E2, ADR-297): external
/// dependency behavior ⊥ degradation mode (`DegradationSpec.mode`) ⊥ eventual
/// failure semantics ([`EventualFailureSemantics`]). Serializes to the spec's
/// SCREAMING_SNAKE_CASE literals.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExternalDependencyBehavior {
    /// Fail the gene when the dependency is unreachable.
    Fail,
    /// Fall back to a degraded path / alternative source.
    Fallback,
    /// Return a previously cached result.
    Cache,
    /// Skip this dependency and continue.
    Skip,
}

/// Transaction failure semantics for a gene's own execution
/// (spec §45 `FailureSemantics`, the eventual-failure axis).
///
/// Split out of the former 5-variant `FailureSemantics`, which conflated this
/// transaction axis with the external-dependency axis ([`ExternalDependencyBehavior`])
/// — ADR-297 Option B. Serializes to the spec's SCREAMING_SNAKE_CASE literals;
/// the legacy PascalCase literals (and the dropped `Retry`, which folds into
/// `PartialRetry`) still deserialize via aliases through the v0.9.1 grace window
/// (hard cut in v0.9.2 — ADR-297 D3 phase 4).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventualFailureSemantics {
    #[serde(alias = "AtomicRollback")]
    AtomicRollback,
    #[serde(alias = "PartialRetry", alias = "Retry")]
    PartialRetry,
    #[serde(alias = "SilentDegrade")]
    SilentDegrade,
    #[serde(alias = "FailFast")]
    FailFast,
}

/// Cost accounting model for resource consumption.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CostModel {
    PerOperation,
    Subscription,
    ResourceBound,
    FreeTier,
}

/// LLM-specific requirements for Prompt Genes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequirements {
    pub template_format: String,
    pub template_variables: Vec<String>,
    #[serde(default)]
    pub target_models: Option<Vec<String>>,
    #[serde(default)]
    pub min_context_window: Option<u32>,
    #[serde(default)]
    pub expected_output_format: Option<String>,
    #[serde(default)]
    pub temperature_hint: Option<f64>,
    #[serde(default)]
    pub max_output_tokens: Option<u32>,
    #[serde(default)]
    pub system_prompt_path: Option<String>,
    #[serde(default)]
    pub user_prompt_path: Option<String>,
    #[serde(default)]
    pub few_shot_examples: Option<u32>,
    #[serde(default)]
    pub chain_of_thought: Option<bool>,
}

/// Guard-specific configuration for Guard Genes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardConfig {
    pub position: String,
    pub categories: Vec<String>,
    #[serde(default = "default_guard_action")]
    pub default_action: String,
    #[serde(default = "default_risk_threshold")]
    pub risk_threshold: f64,
    #[serde(default = "default_contribute_to_vg")]
    pub contribute_to_vg: bool,
}

fn default_guard_action() -> String { "block".into() }
fn default_risk_threshold() -> f64 { 0.7 }
fn default_contribute_to_vg() -> bool { true }

/// A gene — the atomic, content-addressable unit of capability in Rotifer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gene {
    pub id: GeneId,
    pub phenotype: Phenotype,
    pub wasm_bytes: Option<Vec<u8>>,
    pub source_code: Option<String>,
}

/// Lifecycle state machine for a gene in the registry.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum GeneLifecycleState {
    Draft,
    Published,
    Active,
    Deprecated,
    Archived,
    Tombstoned,
}

#[cfg(test)]
mod degradation_enum_tests {
    //! §3.3 F7 (ADR-297): the former 5-variant `FailureSemantics` split into two
    //! orthogonal enums. These lock the spec-aligned wire format and the legacy
    //! alias bridge that keeps v0.7+ phenotypes loading through the grace window.
    use super::*;

    fn de<T: serde::de::DeserializeOwned>(s: &str) -> T {
        serde_json::from_str(s).expect("deserialize")
    }
    fn ser<T: Serialize>(v: &T) -> String {
        serde_json::to_string(v).expect("serialize")
    }

    #[test]
    fn external_dependency_behavior_uses_spec_uppercase() {
        assert_eq!(ser(&ExternalDependencyBehavior::Fail), "\"FAIL\"");
        assert_eq!(ser(&ExternalDependencyBehavior::Fallback), "\"FALLBACK\"");
        assert_eq!(ser(&ExternalDependencyBehavior::Cache), "\"CACHE\"");
        assert_eq!(ser(&ExternalDependencyBehavior::Skip), "\"SKIP\"");
        assert_eq!(de::<ExternalDependencyBehavior>("\"CACHE\""), ExternalDependencyBehavior::Cache);
        assert_eq!(de::<ExternalDependencyBehavior>("\"SKIP\""), ExternalDependencyBehavior::Skip);
    }

    #[test]
    fn eventual_failure_semantics_uses_spec_uppercase() {
        assert_eq!(ser(&EventualFailureSemantics::FailFast), "\"FAIL_FAST\"");
        assert_eq!(ser(&EventualFailureSemantics::AtomicRollback), "\"ATOMIC_ROLLBACK\"");
        assert_eq!(ser(&EventualFailureSemantics::PartialRetry), "\"PARTIAL_RETRY\"");
        assert_eq!(ser(&EventualFailureSemantics::SilentDegrade), "\"SILENT_DEGRADE\"");
    }

    #[test]
    fn eventual_failure_semantics_accepts_legacy_pascalcase() {
        // v0.7+ phenotypes wrote PascalCase; they must keep loading (grace window).
        assert_eq!(de::<EventualFailureSemantics>("\"FailFast\""), EventualFailureSemantics::FailFast);
        assert_eq!(de::<EventualFailureSemantics>("\"AtomicRollback\""), EventualFailureSemantics::AtomicRollback);
        assert_eq!(de::<EventualFailureSemantics>("\"SilentDegrade\""), EventualFailureSemantics::SilentDegrade);
        assert_eq!(de::<EventualFailureSemantics>("\"PartialRetry\""), EventualFailureSemantics::PartialRetry);
    }

    #[test]
    fn dropped_retry_folds_into_partial_retry() {
        // `Retry` was removed in the un-collapse; the legacy literal aliases to
        // the closest transaction semantics so old `failureSemantics:"Retry"` loads.
        assert_eq!(de::<EventualFailureSemantics>("\"Retry\""), EventualFailureSemantics::PartialRetry);
    }

    #[test]
    fn semantic_requirements_round_trips_legacy_failure_semantics() {
        // Missing Option fields default to None; the legacy value still loads.
        let sr: SemanticRequirements = de(r#"{"failureSemantics":"FailFast"}"#);
        assert_eq!(sr.failure_semantics, Some(EventualFailureSemantics::FailFast));
    }
}
