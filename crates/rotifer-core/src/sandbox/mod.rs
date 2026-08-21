//! WASM sandbox for isolated gene execution.
//!
//! The sandbox enforces resource limits (memory, fuel, time) and exposes
//! Rotifer host functions (`rotifer.log`, `rotifer.readContext`, etc.).

mod wasmtime_sandbox;

pub use wasmtime_sandbox::WasmtimeSandbox;

use crate::types::gene::Phenotype;
use crate::types::{Context, GeneResult};
use thiserror::Error;

/// Errors that can occur during sandboxed gene execution.
#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("compilation failed: {0}")]
    CompilationFailed(String),
    #[error("execution failed: {0}")]
    ExecutionFailed(String),
    #[error("resource limit exceeded: {0}")]
    ResourceLimitExceeded(String),
    #[error("constraint violation: {0}")]
    ConstraintViolation(String),
    #[error("invalid wasm: {0}")]
    InvalidWasm(String),
}

/// Runtime constraints applied to a sandbox instance.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ConstraintSet {
    pub max_memory_bytes: u64,
    pub max_fuel: u64,
    pub max_execution_time_ms: u64,
    pub allowed_host_functions: Vec<String>,
    pub denied_host_functions: Vec<String>,
}

impl Default for ConstraintSet {
    fn default() -> Self {
        Self {
            max_memory_bytes: 64 * 1024 * 1024,
            max_fuel: 1_000_000,
            max_execution_time_ms: 30_000,
            allowed_host_functions: Vec::new(),
            denied_host_functions: Vec::new(),
        }
    }
}

/// Trait for executing WASM gene modules in isolation.
pub trait Sandbox: Send + Sync {
    /// Execute a gene's WASM bytes with the given context and JSON input.
    fn execute(
        &self,
        wasm_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
    ) -> Result<GeneResult, SandboxError>;

    /// Validate that WASM bytes conform to the given constraints without executing.
    fn validate(
        &self,
        wasm_bytes: &[u8],
        constraints: &ConstraintSet,
    ) -> Result<bool, SandboxError>;

    /// The constraint set this sandbox enforces. Required so the L0 gate below
    /// can compare a gene's declared caps against what the sandbox actually allows.
    fn constraints(&self) -> &ConstraintSet;

    /// Execute with L0 gate enforcement — the entry point every caller should use.
    ///
    /// This lives on the trait, not on a concrete sandbox, on purpose. It used to be
    /// an inherent method on `WasmtimeSandbox`, which meant a caller holding a
    /// `&dyn Sandbox` simply could not reach it — and `AlgebraExecutor` therefore ran
    /// every genome step through the ungated `execute()` instead. Spec makes L0 the one
    /// layer that cannot be bypassed, so the gate belongs where bypassing it takes
    /// deliberate effort: a new implementor inherits it, and a new call site has to
    /// reach past it to `execute()` rather than merely forget it exists.
    fn execute_gated(
        &self,
        wasm_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
        phenotype: &Phenotype,
    ) -> Result<GeneResult, SandboxError> {
        let l0_result = crate::l0::L0Gate::check(phenotype, &context.permissions, self.constraints());
        if !l0_result.passed {
            let msgs: Vec<String> = l0_result.violations.iter().map(|v| v.to_string()).collect();
            return Err(SandboxError::ConstraintViolation(format!(
                "L0 gate blocked: {}",
                msgs.join("; ")
            )));
        }
        self.execute(wasm_bytes, context, input)
    }
}
