//! Web3 Mock Binding — simulates a Web3 (EVM) environment for cross-binding
//! IR validation.
//!
//! This binding reuses the [`WasmtimeSandbox`] engine but applies Web3-specific
//! constraints: Gas-based metering, lower resource ceilings, no filesystem
//! access, and Web3 extension host functions.
//!
//! **This is a test/validation binding, not a production Web3 implementation.**
//! The real Web3 Binding will involve Solidity contracts and chain deployment.

use super::negotiation;
use super::{
    BindingCapabilities, HostFunctionDecl, IrRequirements, MeteringUnit,
    NegotiationResult, RotiferBinding,
};
use crate::sandbox::{ConstraintSet, Sandbox, SandboxError, WasmtimeSandbox};
use crate::types::gene::Phenotype;
use crate::types::{Context, ExecutionMetadata, GeneResult, ResourceLimits};

/// Default Gas price: 1 fuel unit = 10 gas units.
const DEFAULT_GAS_PRICE: u64 = 10;
/// Web3 memory ceiling: 16 MB (chain environments are more constrained).
const WEB3_MAX_MEMORY: u64 = 16 * 1024 * 1024;
/// Web3 fuel ceiling (before gas conversion): 500K.
const WEB3_MAX_FUEL: u64 = 500_000;
/// Web3 execution timeout: 5 seconds.
const WEB3_MAX_TIME_MS: u64 = 5_000;

/// Mock Web3 binding for cross-binding IR validation.
///
/// Simulates Web3 environment constraints without requiring actual
/// blockchain infrastructure. Converts fuel consumption to gas units
/// via a configurable price multiplier.
pub struct Web3MockBinding {
    sandbox: WasmtimeSandbox,
    capabilities: BindingCapabilities,
    gas_price: u64,
}

impl Web3MockBinding {
    /// Create with default Web3 constraints and gas price.
    pub fn with_defaults() -> Result<Self, SandboxError> {
        Self::new(DEFAULT_GAS_PRICE)
    }

    /// Create with a custom gas price (fuel-to-gas multiplier).
    pub fn new(gas_price: u64) -> Result<Self, SandboxError> {
        let constraints = ConstraintSet {
            max_memory_bytes: WEB3_MAX_MEMORY,
            max_fuel: WEB3_MAX_FUEL,
            max_execution_time_ms: WEB3_MAX_TIME_MS,
            allowed_host_functions: Vec::new(),
            denied_host_functions: Vec::new(),
        };

        let capabilities = BindingCapabilities {
            supported_ir_version: "0.2.0".into(),
            host_functions: vec![
                HostFunctionDecl::required("rotifer.log"),
                HostFunctionDecl::required("rotifer.readContext"),
                HostFunctionDecl::required("rotifer.remainingBudget"),
                HostFunctionDecl::required("rotifer.logicalTimestamp"),
                HostFunctionDecl::optional("rotifer.ext.getBlockNumber"),
                HostFunctionDecl::optional("rotifer.ext.getChainId"),
            ],
            resource_ceiling: ResourceLimits {
                max_memory_bytes: Some(WEB3_MAX_MEMORY),
                max_execution_time_ms: Some(WEB3_MAX_TIME_MS),
                max_fuel_units: Some(WEB3_MAX_FUEL),
            },
            filesystem_access: false,
            network_access: false,
        };

        let sandbox = WasmtimeSandbox::new(constraints)?;

        Ok(Self {
            sandbox,
            capabilities,
            gas_price,
        })
    }

    /// Get the gas price (fuel-to-gas multiplier).
    pub fn gas_price(&self) -> u64 {
        self.gas_price
    }

    /// Convert a fuel cost to gas units.
    pub fn fuel_to_gas(&self, fuel: f64) -> f64 {
        fuel * self.gas_price as f64
    }

    /// Convert execution result's resource_cost from fuel to gas.
    fn convert_to_gas(&self, result: GeneResult) -> GeneResult {
        match result {
            GeneResult::Success { data, metadata } => GeneResult::Success {
                data,
                metadata: ExecutionMetadata {
                    resource_cost: self.fuel_to_gas(metadata.resource_cost),
                    ..metadata
                },
            },
            error => error,
        }
    }
}

impl RotiferBinding for Web3MockBinding {
    fn binding_id(&self) -> &str {
        "web3-mock"
    }

    fn metering_unit(&self) -> MeteringUnit {
        MeteringUnit::Gas
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
        let result = self.sandbox.execute_gated(ir_bytes, context, input, phenotype)?;
        Ok(self.convert_to_gas(result))
    }

    fn negotiate(&self, requirements: &IrRequirements) -> NegotiationResult {
        negotiation::negotiate(requirements, &self.capabilities)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_id_is_web3_mock() {
        let binding = Web3MockBinding::with_defaults().unwrap();
        assert_eq!(binding.binding_id(), "web3-mock");
    }

    #[test]
    fn metering_unit_is_gas() {
        let binding = Web3MockBinding::with_defaults().unwrap();
        assert_eq!(binding.metering_unit(), MeteringUnit::Gas);
    }

    #[test]
    fn gas_price_default() {
        let binding = Web3MockBinding::with_defaults().unwrap();
        assert_eq!(binding.gas_price(), DEFAULT_GAS_PRICE);
    }

    #[test]
    fn fuel_to_gas_conversion() {
        let binding = Web3MockBinding::new(10).unwrap();
        assert_eq!(binding.fuel_to_gas(100.0), 1000.0);
        assert_eq!(binding.fuel_to_gas(0.0), 0.0);
    }

    #[test]
    fn no_filesystem_no_network() {
        let binding = Web3MockBinding::with_defaults().unwrap();
        let caps = binding.capabilities();
        assert!(!caps.filesystem_access);
        assert!(!caps.network_access);
    }

    #[test]
    fn has_web3_extension_functions() {
        let binding = Web3MockBinding::with_defaults().unwrap();
        let caps = binding.capabilities();
        let names: Vec<&str> = caps.host_functions.iter().map(|h| h.name.as_str()).collect();
        assert!(names.contains(&"rotifer.ext.getBlockNumber"));
        assert!(names.contains(&"rotifer.ext.getChainId"));
    }

    #[test]
    fn web3_extensions_are_optional() {
        let binding = Web3MockBinding::with_defaults().unwrap();
        let ext_funcs: Vec<&HostFunctionDecl> = binding
            .capabilities()
            .host_functions
            .iter()
            .filter(|h| h.is_extension())
            .collect();
        assert!(ext_funcs.iter().all(|h| !h.required));
    }

    #[test]
    fn stricter_resource_limits_than_local() {
        let web3 = Web3MockBinding::with_defaults().unwrap();
        let local = crate::binding::local::LocalBinding::with_defaults().unwrap();

        let web3_mem = web3.capabilities().resource_ceiling.max_memory_bytes.unwrap();
        let local_mem = local.capabilities().resource_ceiling.max_memory_bytes.unwrap();
        assert!(web3_mem < local_mem, "web3 memory ({web3_mem}) should be less than local ({local_mem})");

        let web3_fuel = web3.capabilities().resource_ceiling.max_fuel_units.unwrap();
        let local_fuel = local.capabilities().resource_ceiling.max_fuel_units.unwrap();
        assert!(web3_fuel < local_fuel, "web3 fuel ({web3_fuel}) should be less than local ({local_fuel})");
    }

    #[test]
    fn negotiate_simple_gene_compatible() {
        let binding = Web3MockBinding::with_defaults().unwrap();
        let req = IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            min_memory_bytes: 4 * 1024 * 1024,
            min_resource_budget: 100_000,
            ..Default::default()
        };
        assert!(binding.negotiate(&req).is_fully_compatible());
    }

    #[test]
    fn negotiate_high_memory_gene_incompatible() {
        let binding = Web3MockBinding::with_defaults().unwrap();
        let req = IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            min_memory_bytes: 32 * 1024 * 1024, // 32 MB > 16 MB ceiling
            ..Default::default()
        };
        assert!(!binding.negotiate(&req).is_compatible());
    }

    #[test]
    fn convert_result_fuel_to_gas() {
        let binding = Web3MockBinding::new(10).unwrap();
        let result = GeneResult::Success {
            data: serde_json::json!({"ok": true}),
            metadata: ExecutionMetadata {
                duration_ms: 50,
                resource_cost: 100.0,   // fuel
                cache_hit: None,
            },
        };
        let converted = binding.convert_to_gas(result);
        match converted {
            GeneResult::Success { metadata, .. } => {
                assert_eq!(metadata.resource_cost, 1000.0); // 100 fuel × 10 = 1000 gas
                assert_eq!(metadata.duration_ms, 50);       // unchanged
            }
            _ => panic!("expected Success"),
        }
    }
}
