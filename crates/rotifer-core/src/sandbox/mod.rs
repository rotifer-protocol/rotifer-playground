//! WASM sandbox for isolated gene execution.
//!
//! The sandbox enforces resource limits (memory, fuel, time) and exposes
//! Rotifer host functions (`rotifer.log`, `rotifer.readContext`, etc.).

mod wasmtime_sandbox;

pub use wasmtime_sandbox::WasmtimeSandbox;

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
}
