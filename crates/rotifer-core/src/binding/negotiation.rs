//! Capability Negotiation — determines whether an IR module can execute
//! in a target binding environment.
//!
//! Implements the algorithm described in IR Specification §10.

use super::{
    BindingCapabilities, IncompatibilityReason, IrRequirements, NegotiationResult,
};

/// Run capability negotiation between an IR module's requirements and
/// a target binding's capabilities.
///
/// Returns [`NegotiationResult::Compatible`] if all required host functions
/// and resource constraints are satisfied, [`PartiallyCompatible`] if only
/// optional functions are missing, or [`Incompatible`] with specific reasons.
pub fn negotiate(
    requirements: &IrRequirements,
    capabilities: &BindingCapabilities,
) -> NegotiationResult {
    let mut reasons: Vec<IncompatibilityReason> = Vec::new();
    let mut missing_optional: Vec<String> = Vec::new();

    check_ir_version(requirements, capabilities, &mut reasons);
    check_host_functions(requirements, capabilities, &mut reasons, &mut missing_optional);
    check_memory(requirements, capabilities, &mut reasons);
    check_resource_budget(requirements, capabilities, &mut reasons);

    if !reasons.is_empty() {
        return NegotiationResult::Incompatible { reasons };
    }

    if !missing_optional.is_empty() {
        return NegotiationResult::PartiallyCompatible { missing_optional };
    }

    NegotiationResult::Compatible
}

/// Parse the major version number from a semver string.
/// Returns 0 if parsing fails (treating empty/malformed as pre-1.0).
fn parse_major(version: &str) -> u32 {
    version
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
}

fn check_ir_version(
    requirements: &IrRequirements,
    capabilities: &BindingCapabilities,
    reasons: &mut Vec<IncompatibilityReason>,
) {
    if requirements.ir_version.is_empty() || capabilities.supported_ir_version.is_empty() {
        return;
    }

    let req_major = parse_major(&requirements.ir_version);
    let cap_major = parse_major(&capabilities.supported_ir_version);

    if req_major != cap_major {
        reasons.push(IncompatibilityReason::IrVersionIncompatible {
            module_version: requirements.ir_version.clone(),
            binding_supports: capabilities.supported_ir_version.clone(),
        });
    }
}

fn check_host_functions(
    requirements: &IrRequirements,
    capabilities: &BindingCapabilities,
    reasons: &mut Vec<IncompatibilityReason>,
    missing_optional: &mut Vec<String>,
) {
    let provided: Vec<&str> = capabilities
        .host_functions
        .iter()
        .map(|h| h.name.as_str())
        .collect();

    for func_name in &requirements.required_host_functions {
        if !provided.contains(&func_name.as_str()) {
            reasons.push(IncompatibilityReason::MissingRequiredFunction(
                func_name.clone(),
            ));
        }
    }

    for func_name in &requirements.optional_host_functions {
        if !provided.contains(&func_name.as_str()) {
            missing_optional.push(func_name.clone());
        }
    }
}

fn check_memory(
    requirements: &IrRequirements,
    capabilities: &BindingCapabilities,
    reasons: &mut Vec<IncompatibilityReason>,
) {
    if requirements.min_memory_bytes == 0 {
        return;
    }
    if let Some(ceiling) = capabilities.resource_ceiling.max_memory_bytes
        && requirements.min_memory_bytes > ceiling
    {
        reasons.push(IncompatibilityReason::MemoryExceeded {
            required: requirements.min_memory_bytes,
            ceiling,
        });
    }
}

fn check_resource_budget(
    requirements: &IrRequirements,
    capabilities: &BindingCapabilities,
    reasons: &mut Vec<IncompatibilityReason>,
) {
    if requirements.min_resource_budget == 0 {
        return;
    }
    if let Some(ceiling) = capabilities.resource_ceiling.max_fuel_units
        && requirements.min_resource_budget > ceiling
    {
        reasons.push(IncompatibilityReason::ResourceBudgetExceeded {
            required: requirements.min_resource_budget,
            ceiling,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binding::HostFunctionDecl;
    use crate::types::ResourceLimits;

    fn local_capabilities() -> BindingCapabilities {
        BindingCapabilities {
            supported_ir_version: "0.2.0".into(),
            host_functions: vec![
                HostFunctionDecl::required("rotifer.log"),
                HostFunctionDecl::required("rotifer.readContext"),
                HostFunctionDecl::required("rotifer.remainingBudget"),
                HostFunctionDecl::required("rotifer.logicalTimestamp"),
            ],
            resource_ceiling: ResourceLimits::default(),
            filesystem_access: true,
            network_access: false,
        }
    }

    fn web3_capabilities() -> BindingCapabilities {
        BindingCapabilities {
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
                max_memory_bytes: Some(16 * 1024 * 1024),
                max_execution_time_ms: Some(5_000),
                max_fuel_units: Some(500_000),
            },
            filesystem_access: false,
            network_access: false,
        }
    }

    #[test]
    fn compatible_when_all_requirements_met() {
        let req = IrRequirements {
            required_host_functions: vec![
                "rotifer.log".into(),
                "rotifer.readContext".into(),
            ],
            optional_host_functions: vec![],
            min_memory_bytes: 4 * 1024 * 1024,
            min_resource_budget: 100_000,
            ir_version: "0.1.0".into(),
        };
        let result = negotiate(&req, &local_capabilities());
        assert!(matches!(result, NegotiationResult::Compatible));
    }

    #[test]
    fn partially_compatible_missing_optional() {
        let req = IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            optional_host_functions: vec!["rotifer.ext.getBlockNumber".into()],
            min_memory_bytes: 0,
            min_resource_budget: 0,
            ir_version: "0.1.0".into(),
        };
        let result = negotiate(&req, &local_capabilities());
        match result {
            NegotiationResult::PartiallyCompatible { missing_optional } => {
                assert_eq!(missing_optional, vec!["rotifer.ext.getBlockNumber"]);
            }
            other => panic!("expected PartiallyCompatible, got {other:?}"),
        }
    }

    #[test]
    fn incompatible_missing_required_function() {
        let req = IrRequirements {
            required_host_functions: vec![
                "rotifer.log".into(),
                "rotifer.ext.chainCall".into(),
            ],
            optional_host_functions: vec![],
            min_memory_bytes: 0,
            min_resource_budget: 0,
            ir_version: "0.1.0".into(),
        };
        let result = negotiate(&req, &local_capabilities());
        match result {
            NegotiationResult::Incompatible { reasons } => {
                assert_eq!(reasons.len(), 1);
                assert!(matches!(
                    &reasons[0],
                    IncompatibilityReason::MissingRequiredFunction(name) if name == "rotifer.ext.chainCall"
                ));
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn incompatible_memory_exceeded() {
        let req = IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            optional_host_functions: vec![],
            min_memory_bytes: 32 * 1024 * 1024, // 32 MB
            min_resource_budget: 0,
            ir_version: "0.1.0".into(),
        };
        let result = negotiate(&req, &web3_capabilities());
        match result {
            NegotiationResult::Incompatible { reasons } => {
                assert!(reasons.iter().any(|r| matches!(r, IncompatibilityReason::MemoryExceeded { .. })));
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn incompatible_resource_budget_exceeded() {
        let req = IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            optional_host_functions: vec![],
            min_memory_bytes: 0,
            min_resource_budget: 2_000_000,
            ir_version: "0.1.0".into(),
        };
        let result = negotiate(&req, &web3_capabilities());
        match result {
            NegotiationResult::Incompatible { reasons } => {
                assert!(reasons.iter().any(|r| matches!(r, IncompatibilityReason::ResourceBudgetExceeded { .. })));
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn optional_ext_available_in_web3() {
        let req = IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            optional_host_functions: vec!["rotifer.ext.getBlockNumber".into()],
            min_memory_bytes: 0,
            min_resource_budget: 0,
            ir_version: "0.1.0".into(),
        };
        let result = negotiate(&req, &web3_capabilities());
        assert!(matches!(result, NegotiationResult::Compatible));
    }

    #[test]
    fn multiple_incompatibilities_reported() {
        let req = IrRequirements {
            required_host_functions: vec![
                "rotifer.ext.chainCall".into(),
                "rotifer.ext.sendTx".into(),
            ],
            optional_host_functions: vec![],
            min_memory_bytes: 128 * 1024 * 1024,
            min_resource_budget: 10_000_000,
            ir_version: "0.1.0".into(),
        };
        let result = negotiate(&req, &web3_capabilities());
        match result {
            NegotiationResult::Incompatible { reasons } => {
                assert!(reasons.len() >= 3, "expected at least 3 reasons, got {}", reasons.len());
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn zero_requirements_always_compatible() {
        let req = IrRequirements::default();
        assert!(matches!(negotiate(&req, &local_capabilities()), NegotiationResult::Compatible));
        assert!(matches!(negotiate(&req, &web3_capabilities()), NegotiationResult::Compatible));
    }

    #[test]
    fn same_major_version_compatible() {
        let req = IrRequirements {
            ir_version: "0.1.0".into(),
            ..Default::default()
        };
        let caps = local_capabilities(); // supports 0.2.0
        assert!(matches!(negotiate(&req, &caps), NegotiationResult::Compatible));
    }

    #[test]
    fn different_major_version_incompatible() {
        let req = IrRequirements {
            ir_version: "1.0.0".into(),
            ..Default::default()
        };
        let caps = local_capabilities(); // supports 0.2.0
        match negotiate(&req, &caps) {
            NegotiationResult::Incompatible { reasons } => {
                assert!(reasons.iter().any(|r| matches!(
                    r,
                    IncompatibilityReason::IrVersionIncompatible { .. }
                )));
            }
            other => panic!("expected Incompatible, got {other:?}"),
        }
    }

    #[test]
    fn empty_version_skips_check() {
        let req = IrRequirements {
            ir_version: "".into(),
            ..Default::default()
        };
        let caps = local_capabilities();
        assert!(matches!(negotiate(&req, &caps), NegotiationResult::Compatible));
    }
}
