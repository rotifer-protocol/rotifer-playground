//! Local Binding — wraps the existing [`WasmtimeSandbox`] as a [`RotiferBinding`].
//!
//! This is the default binding used by the Playground CLI. It uses wasmtime
//! fuel-based metering, supports file system access, and provides the four
//! core Rotifer host functions.

use super::negotiation;
use super::{
    BindingCapabilities, HostFunctionDecl, IrRequirements, MeteringUnit,
    NegotiationResult, RotiferBinding,
};
use crate::sandbox::{ConstraintSet, Sandbox, SandboxError, WasmtimeSandbox};
use crate::types::gene::Phenotype;
use crate::types::{Context, GeneResult, ResourceLimits};

/// [`RotiferBinding`] implementation for the local/cloud environment.
///
/// Delegates execution to [`WasmtimeSandbox`] with fuel-based metering.
/// This is a thin wrapper that adds capability declaration and negotiation
/// without changing any existing execution behavior.
pub struct LocalBinding {
    sandbox: WasmtimeSandbox,
    capabilities: BindingCapabilities,
}

impl LocalBinding {
    /// Create a local binding with protocol-default constraints.
    pub fn with_defaults() -> Result<Self, SandboxError> {
        Self::new(ConstraintSet::default())
    }

    /// Create a local binding with custom constraints.
    pub fn new(constraints: ConstraintSet) -> Result<Self, SandboxError> {
        let capabilities = BindingCapabilities {
            supported_ir_version: "0.2.0".into(),
            host_functions: vec![
                HostFunctionDecl::required("rotifer.log"),
                HostFunctionDecl::required("rotifer.readContext"),
                HostFunctionDecl::required("rotifer.remainingBudget"),
                HostFunctionDecl::required("rotifer.logicalTimestamp"),
            ],
            resource_ceiling: ResourceLimits {
                max_memory_bytes: Some(constraints.max_memory_bytes),
                max_execution_time_ms: Some(constraints.max_execution_time_ms),
                max_fuel_units: Some(constraints.max_fuel),
            },
            filesystem_access: true,
            network_access: false,
        };

        let sandbox = WasmtimeSandbox::new(constraints)?;

        Ok(Self {
            sandbox,
            capabilities,
        })
    }

    /// Direct access to the underlying sandbox (for backward compatibility
    /// with code that doesn't use the binding abstraction yet).
    pub fn sandbox(&self) -> &WasmtimeSandbox {
        &self.sandbox
    }
}

impl RotiferBinding for LocalBinding {
    fn binding_id(&self) -> &str {
        "local"
    }

    fn metering_unit(&self) -> MeteringUnit {
        MeteringUnit::Fuel
    }

    fn capabilities(&self) -> &BindingCapabilities {
        &self.capabilities
    }

    fn execute_ir(
        &self,
        ir_bytes: &[u8],
        context: &Context,
        input: serde_json::Value,
        phenotype: &Phenotype,
    ) -> Result<GeneResult, SandboxError> {
        self.sandbox.execute_gated(ir_bytes, context, input, phenotype)
    }

    fn negotiate(&self, requirements: &IrRequirements) -> NegotiationResult {
        negotiation::negotiate(requirements, &self.capabilities)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_id_is_local() {
        let binding = LocalBinding::with_defaults().unwrap();
        assert_eq!(binding.binding_id(), "local");
    }

    #[test]
    fn metering_unit_is_fuel() {
        let binding = LocalBinding::with_defaults().unwrap();
        assert_eq!(binding.metering_unit(), MeteringUnit::Fuel);
    }

    #[test]
    fn capabilities_include_core_host_functions() {
        let binding = LocalBinding::with_defaults().unwrap();
        let caps = binding.capabilities();
        let names: Vec<&str> = caps.host_functions.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"rotifer.log"));
        assert!(names.contains(&"rotifer.readContext"));
        assert!(names.contains(&"rotifer.remainingBudget"));
        assert!(names.contains(&"rotifer.logicalTimestamp"));
    }

    #[test]
    fn local_has_filesystem_no_network() {
        let binding = LocalBinding::with_defaults().unwrap();
        let caps = binding.capabilities();
        assert!(caps.filesystem_access);
        assert!(!caps.network_access);
    }

    #[test]
    fn negotiate_simple_gene_compatible() {
        let binding = LocalBinding::with_defaults().unwrap();
        let req = IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            ..Default::default()
        };
        assert!(binding.negotiate(&req).is_fully_compatible());
    }

    #[test]
    fn negotiate_web3_extension_partially_compatible() {
        let binding = LocalBinding::with_defaults().unwrap();
        let req = IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            optional_host_functions: vec!["rotifer.ext.getBlockNumber".into()],
            ..Default::default()
        };
        let result = binding.negotiate(&req);
        assert!(result.is_compatible());
        assert!(!result.is_fully_compatible());
    }
}
