//! Binding abstraction layer — enables cross-binding gene portability via IR.
//!
//! Each binding environment (Local, Cloud, Web3, Edge, TEE) implements the
//! [`RotiferBinding`] trait, providing its own sandbox configuration, resource
//! metering semantics, and host function capabilities.
//!
//! The core protocol engine operates against this trait so that genes compiled
//! to Rotifer IR can be transferred and executed across different bindings
//! without modification.

pub mod local;
pub mod negotiation;
pub mod web3_mock;

use crate::sandbox::SandboxError;
use crate::types::gene::Phenotype;
use crate::types::{Context, GeneResult, ResourceLimits};
use serde::{Deserialize, Serialize};

/// Abstraction over different protocol binding environments.
///
/// Each binding provides its own sandbox, resource metering semantics,
/// host function capabilities, and security constraints. The core protocol
/// engine operates against this trait, enabling cross-binding gene
/// portability via IR.
pub trait RotiferBinding: Send + Sync {
    /// Human-readable binding identifier (e.g. "local", "web3-mock").
    fn binding_id(&self) -> &str;

    /// The resource metering unit used by this binding.
    fn metering_unit(&self) -> MeteringUnit;

    /// Host functions and constraints provided by this binding.
    fn capabilities(&self) -> &BindingCapabilities;

    /// Execute a gene's WASM IR in this binding's sandbox.
    fn execute_ir(
        &self,
        ir_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
        phenotype: &Phenotype,
    ) -> Result<GeneResult, SandboxError>;

    /// Check if this binding can execute a given IR module.
    /// Performs Capability Negotiation per IR spec §10.
    fn negotiate(&self, requirements: &IrRequirements) -> NegotiationResult;
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/// Resource metering unit — differs across bindings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MeteringUnit {
    /// wasmtime fuel units (Local / Cloud binding).
    Fuel,
    /// EVM gas units (Web3 binding). Converted from fuel via a price multiplier.
    Gas,
    /// Wall-clock milliseconds (Edge binding, future).
    WallClock,
}

impl std::fmt::Display for MeteringUnit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fuel => write!(f, "fuel"),
            Self::Gas => write!(f, "gas"),
            Self::WallClock => write!(f, "wall_clock_ms"),
        }
    }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/// Capabilities declared by a binding environment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindingCapabilities {
    /// IR specification version this binding supports (e.g. "0.2.0").
    /// Used for version compatibility checking in Capability Negotiation.
    pub supported_ir_version: String,
    /// Host functions this binding provides (name → required/optional).
    pub host_functions: Vec<HostFunctionDecl>,
    /// Maximum resource limits this binding supports.
    pub resource_ceiling: ResourceLimits,
    /// Whether this binding supports file system access.
    pub filesystem_access: bool,
    /// Whether this binding supports outbound network access.
    pub network_access: bool,
}

/// A single host function declaration within a binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostFunctionDecl {
    /// Fully-qualified name (e.g. "rotifer.log", "rotifer.ext.getBlockNumber").
    pub name: String,
    /// If true, the binding always provides this function.
    /// If false, it is an optional extension that may not be available.
    pub required: bool,
}

impl HostFunctionDecl {
    pub fn required(name: impl Into<String>) -> Self {
        Self { name: name.into(), required: true }
    }

    pub fn optional(name: impl Into<String>) -> Self {
        Self { name: name.into(), required: false }
    }

    /// Returns true if this is a binding extension function (rotifer.ext.*).
    pub fn is_extension(&self) -> bool {
        self.name.starts_with("rotifer.ext.")
    }
}

// ---------------------------------------------------------------------------
// IR Requirements (extracted from IR module custom sections)
// ---------------------------------------------------------------------------

/// Capability requirements extracted from an IR module's custom sections.
///
/// During cross-binding transfer, the receiving binding compares these
/// requirements against its own [`BindingCapabilities`] to determine
/// compatibility.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct IrRequirements {
    /// Host functions the IR module calls and marks as required.
    pub required_host_functions: Vec<String>,
    /// Host functions the IR module calls but marks as optional
    /// (graceful degradation if absent).
    pub optional_host_functions: Vec<String>,
    /// Minimum memory needed to execute the IR module.
    pub min_memory_bytes: u64,
    /// Minimum fuel/gas budget needed for execution.
    pub min_resource_budget: u64,
    /// IR specification version this module was compiled against.
    pub ir_version: String,
}

impl IrRequirements {
    /// Extract `IrRequirements` from a compiled Rotifer IR WASM binary by
    /// parsing its `rotifer.version` and `rotifer.constraints` custom sections.
    ///
    /// Host functions listed in `rotifer.constraints.hostFunctions` are treated
    /// as required; any functions in a future `rotifer.ext` section would be
    /// treated as optional. Currently `rotifer.ext` parsing is not implemented,
    /// so `optional_host_functions` will be empty.
    ///
    /// Returns `None` if the WASM bytes contain no Rotifer custom sections
    /// (i.e., it's a raw WASM module, not a Rotifer IR module).
    pub fn from_wasm_bytes(wasm_bytes: &[u8]) -> Option<Self> {
        use crate::compiler::ir_sections::{
            ConstraintsSection, VersionSection, SECTION_CONSTRAINTS, SECTION_VERSION,
        };

        let parser = wasmparser::Parser::new(0);
        let mut version_section: Option<VersionSection> = None;
        let mut constraints_section: Option<ConstraintsSection> = None;

        for payload in parser.parse_all(wasm_bytes) {
            let payload = payload.ok()?;
            if let wasmparser::Payload::CustomSection(cs) = payload {
                match cs.name() {
                    SECTION_VERSION => {
                        version_section = rmp_serde::from_slice(cs.data()).ok();
                    }
                    SECTION_CONSTRAINTS => {
                        constraints_section = rmp_serde::from_slice(cs.data()).ok();
                    }
                    _ => {}
                }
            }
        }

        // At minimum we need the version section to consider this a Rotifer IR module.
        let version = version_section?;
        let constraints = constraints_section.unwrap_or_default();

        Some(Self {
            ir_version: version.spec_version,
            required_host_functions: constraints.host_functions,
            optional_host_functions: Vec::new(),
            min_memory_bytes: constraints.memory.total_memory_limit as u64,
            min_resource_budget: constraints.fuel.max_fuel,
        })
    }
}

// ---------------------------------------------------------------------------
// Negotiation Result
// ---------------------------------------------------------------------------

/// Outcome of capability negotiation between an IR module and a target binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NegotiationResult {
    /// All required capabilities are available — gene can execute normally.
    Compatible,
    /// Some optional capabilities are missing — gene can execute with
    /// degraded functionality (missing functions return ERROR_UNSUPPORTED).
    PartiallyCompatible {
        missing_optional: Vec<String>,
    },
    /// Required capabilities are missing — gene cannot execute in this binding.
    Incompatible {
        reasons: Vec<IncompatibilityReason>,
    },
}

impl NegotiationResult {
    pub fn is_compatible(&self) -> bool {
        matches!(self, Self::Compatible | Self::PartiallyCompatible { .. })
    }

    pub fn is_fully_compatible(&self) -> bool {
        matches!(self, Self::Compatible)
    }
}

/// Specific reason why an IR module is incompatible with a binding.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IncompatibilityReason {
    /// A required host function is not provided by the target binding.
    MissingRequiredFunction(String),
    /// The IR module requires more memory than the binding allows.
    MemoryExceeded { required: u64, ceiling: u64 },
    /// The IR module requires more fuel/gas than the binding allows.
    ResourceBudgetExceeded { required: u64, ceiling: u64 },
    /// The IR specification version is incompatible.
    IrVersionIncompatible { module_version: String, binding_supports: String },
    /// File system access required but not available.
    FilesystemUnavailable,
    /// Network access required but not available.
    NetworkUnavailable,
}

impl std::fmt::Display for IncompatibilityReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingRequiredFunction(name) =>
                write!(f, "required host function '{name}' not available"),
            Self::MemoryExceeded { required, ceiling } =>
                write!(f, "memory {required} bytes exceeds binding ceiling {ceiling} bytes"),
            Self::ResourceBudgetExceeded { required, ceiling } =>
                write!(f, "resource budget {required} exceeds binding ceiling {ceiling}"),
            Self::IrVersionIncompatible { module_version, binding_supports } =>
                write!(f, "IR version {module_version} incompatible with binding (supports {binding_supports})"),
            Self::FilesystemUnavailable =>
                write!(f, "filesystem access required but not available in this binding"),
            Self::NetworkUnavailable =>
                write!(f, "network access required but not available in this binding"),
        }
    }
}

// ---------------------------------------------------------------------------
// Cross-binding transfer
// ---------------------------------------------------------------------------

/// Metadata for a cross-binding IR transfer request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IrTransferRequest {
    /// The source binding that compiled this IR.
    pub source_binding: String,
    /// The target binding that will execute this IR.
    pub target_binding: String,
    /// The gene's phenotype (for L0 gate checks on the receiving side).
    pub phenotype: Phenotype,
    /// IR module bytes.
    pub ir_bytes: Vec<u8>,
    /// Requirements extracted from the IR module.
    pub requirements: IrRequirements,
}

/// Result of attempting a cross-binding IR transfer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TransferResult {
    /// Transfer succeeded — IR accepted by target binding.
    Accepted { negotiation: NegotiationResult },
    /// Transfer rejected — IR incompatible with target binding.
    Rejected { reasons: Vec<IncompatibilityReason> },
    /// Transfer failed — IR module has no irHash (not compiled to IR).
    NoIrAvailable,
}

/// Attempt to transfer an IR module from one binding to another.
///
/// This is the top-level entry point for cross-binding gene portability.
pub fn transfer_ir(
    request: &IrTransferRequest,
    target: &dyn RotiferBinding,
) -> TransferResult {
    if request.ir_bytes.is_empty() {
        return TransferResult::NoIrAvailable;
    }

    let negotiation = target.negotiate(&request.requirements);

    match &negotiation {
        NegotiationResult::Incompatible { reasons } => {
            TransferResult::Rejected { reasons: reasons.clone() }
        }
        _ => {
            TransferResult::Accepted { negotiation }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metering_unit_display() {
        assert_eq!(MeteringUnit::Fuel.to_string(), "fuel");
        assert_eq!(MeteringUnit::Gas.to_string(), "gas");
        assert_eq!(MeteringUnit::WallClock.to_string(), "wall_clock_ms");
    }

    #[test]
    fn host_function_decl_constructors() {
        let req = HostFunctionDecl::required("rotifer.log");
        assert!(req.required);
        assert!(!req.is_extension());

        let opt = HostFunctionDecl::optional("rotifer.ext.getBlockNumber");
        assert!(!opt.required);
        assert!(opt.is_extension());
    }

    #[test]
    fn negotiation_result_helpers() {
        assert!(NegotiationResult::Compatible.is_compatible());
        assert!(NegotiationResult::Compatible.is_fully_compatible());

        let partial = NegotiationResult::PartiallyCompatible {
            missing_optional: vec!["rotifer.ext.foo".into()],
        };
        assert!(partial.is_compatible());
        assert!(!partial.is_fully_compatible());

        let incompat = NegotiationResult::Incompatible {
            reasons: vec![IncompatibilityReason::FilesystemUnavailable],
        };
        assert!(!incompat.is_compatible());
        assert!(!incompat.is_fully_compatible());
    }

    #[test]
    fn incompatibility_reason_display() {
        let r = IncompatibilityReason::MissingRequiredFunction("rotifer.ext.foo".into());
        assert!(r.to_string().contains("rotifer.ext.foo"));

        let r = IncompatibilityReason::MemoryExceeded { required: 100, ceiling: 50 };
        assert!(r.to_string().contains("100"));
        assert!(r.to_string().contains("50"));
    }

    #[test]
    fn from_wasm_bytes_extracts_requirements() {
        let pheno = test_phenotype();
        let payloads =
            crate::compiler::ir_sections::CustomSectionPayloads::build(&pheno, None, None)
                .unwrap();
        let raw_wasm = crate::compiler::ir_injector::tests::minimal_wasm_pub();
        let injected =
            crate::compiler::ir_injector::inject_custom_sections(&raw_wasm, &payloads).unwrap();

        let req = IrRequirements::from_wasm_bytes(&injected.wasm_bytes)
            .expect("should parse Rotifer IR");

        assert_eq!(req.ir_version, crate::compiler::ir_sections::IR_SPEC_VERSION);
        assert!(req.required_host_functions.contains(&"rotifer.log".into()));
        assert!(req.required_host_functions.contains(&"rotifer.readContext".into()));
        assert_eq!(req.min_memory_bytes, 5_242_880);
        assert_eq!(req.min_resource_budget, 1_000_000);
        assert!(req.optional_host_functions.is_empty());
    }

    #[test]
    fn from_wasm_bytes_returns_none_for_raw_wasm() {
        let raw_wasm = crate::compiler::ir_injector::tests::minimal_wasm_pub();
        assert!(IrRequirements::from_wasm_bytes(&raw_wasm).is_none());
    }

    #[test]
    fn from_wasm_bytes_returns_none_for_garbage() {
        assert!(IrRequirements::from_wasm_bytes(b"not wasm").is_none());
    }

    #[test]
    fn transfer_empty_ir_returns_no_ir() {
        let request = IrTransferRequest {
            source_binding: "local".into(),
            target_binding: "web3-mock".into(),
            phenotype: test_phenotype(),
            ir_bytes: vec![],
            requirements: IrRequirements::default(),
        };

        // Use a minimal mock for this test
        let target = crate::binding::local::LocalBinding::with_defaults()
            .expect("sandbox init");
        let result = transfer_ir(&request, &target);
        assert!(matches!(result, TransferResult::NoIrAvailable));
    }

    fn test_phenotype() -> Phenotype {
        Phenotype {
            domain: "test".into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "test".into(),
            created_at: 0,
            ir_hash: None,
            fidelity: crate::types::gene::Fidelity::Native,
            source_framework: None,
            regulatory_tags: None,
            transparency: crate::types::gene::GeneTransparency::Open,
            streaming_capability: None,
            pricing_hint: None,
            semantic_requirements: None,
            network: None,
            llm_requirements: None,
            guard_config: None,
        }
    }
}
