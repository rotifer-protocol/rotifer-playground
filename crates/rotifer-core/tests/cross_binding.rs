//! Cross-binding integration tests — validates that genes compiled to Rotifer IR
//! can be transferred and executed across different binding environments.
//!
//! These tests exercise the 6 scenarios from the v0.6.5 plan:
//! 1. Same gene → same result (Local vs Web3)
//! 2. Fuel → Gas resource cost conversion
//! 3. High-memory gene rejected by Web3
//! 4. Optional host function → PartiallyCompatible
//! 5. Required host function → Incompatible
//! 6. Full transfer_ir round-trip

use rotifer_core::binding::local::LocalBinding;
use rotifer_core::binding::web3_mock::Web3MockBinding;
use rotifer_core::binding::{
    transfer_ir, IncompatibilityReason, IrRequirements, IrTransferRequest,
    MeteringUnit, NegotiationResult, RotiferBinding, TransferResult,
};
use rotifer_core::compiler::{compile_to_ir, genesis};
use rotifer_core::types::gene::{Fidelity, GeneTransparency, Phenotype};
use rotifer_core::types::{Context, GeneResult, PermissionSet};

fn test_context() -> Context {
    Context {
        agent_id: "cross-binding-test".into(),
        timestamp: 1_700_000_000,
        permissions: PermissionSet::default(),
        trace_id: Some("xb-trace-001".into()),
        binding_extensions: None,
    }
}

/// Context with resource limits that fit within Web3's tighter constraints.
fn web3_context() -> Context {
    use rotifer_core::types::ResourceLimits;
    Context {
        agent_id: "cross-binding-test".into(),
        timestamp: 1_700_000_000,
        permissions: PermissionSet {
            resource_limits: ResourceLimits {
                max_memory_bytes: Some(16 * 1024 * 1024), // 16 MB
                max_execution_time_ms: Some(5_000),
                max_fuel_units: Some(500_000),
            },
            ..Default::default()
        },
        trace_id: Some("xb-trace-001".into()),
        binding_extensions: None,
    }
}

fn test_phenotype() -> Phenotype {
    Phenotype {
        domain: "general".into(),
        input_schema: serde_json::json!({"type": "object"}),
        output_schema: serde_json::json!({"type": "object"}),
        dependencies: vec![],
        version: "0.1.0".into(),
        author: "test".into(),
        created_at: 0,
        ir_hash: None,
        fidelity: Fidelity::Native,
        source_framework: None,
        regulatory_tags: None,
        transparency: GeneTransparency::Open,
        streaming_capability: None,
        pricing_hint: None,
        semantic_requirements: None,
        network: None,
        external_dependencies: None,
        llm_requirements: None,
        guard_config: None,
    }
}

// ---------------------------------------------------------------------------
// Test 1: Same gene → same data in both bindings
// ---------------------------------------------------------------------------

#[test]
fn same_gene_same_result_across_bindings() {
    let local = LocalBinding::with_defaults().unwrap();
    let web3 = Web3MockBinding::with_defaults().unwrap();
    let wasm = genesis::build_echo_gene_wasm();
    let input = serde_json::json!({"message": "cross-binding portability"});
    let local_ctx = test_context();
    let web3_ctx = web3_context();
    let pheno = test_phenotype();

    let local_result = local
        .execute_ir(&wasm, &local_ctx, input.clone(), &pheno)
        .expect("local execution should succeed");
    let web3_result = web3
        .execute_ir(&wasm, &web3_ctx, input.clone(), &pheno)
        .expect("web3 execution should succeed");

    let local_data = match &local_result {
        GeneResult::Success { data, .. } => data.clone(),
        other => panic!("expected local Success, got {other:?}"),
    };
    let web3_data = match &web3_result {
        GeneResult::Success { data, .. } => data.clone(),
        other => panic!("expected web3 Success, got {other:?}"),
    };

    assert_eq!(
        local_data, web3_data,
        "same IR should produce identical output data across bindings"
    );
}

// ---------------------------------------------------------------------------
// Test 2: Fuel → Gas conversion is applied by Web3MockBinding
// ---------------------------------------------------------------------------

#[test]
fn web3_converts_fuel_to_gas() {
    let local = LocalBinding::with_defaults().unwrap();
    let web3 = Web3MockBinding::with_defaults().unwrap();
    let wasm = genesis::build_echo_gene_wasm();
    let input = serde_json::json!({"x": 1});
    let local_ctx = test_context();
    let web3_ctx = web3_context();
    let pheno = test_phenotype();

    assert_eq!(local.metering_unit(), MeteringUnit::Fuel);
    assert_eq!(web3.metering_unit(), MeteringUnit::Gas);

    let local_result = local
        .execute_ir(&wasm, &local_ctx, input.clone(), &pheno)
        .expect("local execution should succeed");
    let web3_result = web3
        .execute_ir(&wasm, &web3_ctx, input, &pheno)
        .expect("web3 execution should succeed");

    let local_cost = match &local_result {
        GeneResult::Success { metadata, .. } => metadata.resource_cost,
        other => panic!("expected Success, got {other:?}"),
    };
    let web3_cost = match &web3_result {
        GeneResult::Success { metadata, .. } => metadata.resource_cost,
        other => panic!("expected Success, got {other:?}"),
    };

    let expected_gas = local_cost * web3.gas_price() as f64;
    assert!(
        (web3_cost - expected_gas).abs() < f64::EPSILON,
        "web3 cost ({web3_cost}) should equal local fuel ({local_cost}) × gas_price ({})",
        web3.gas_price()
    );
}

// ---------------------------------------------------------------------------
// Test 3: High-memory IR rejected by Web3 but accepted by Local
// ---------------------------------------------------------------------------

#[test]
fn high_memory_gene_rejected_by_web3() {
    let local = LocalBinding::with_defaults().unwrap();
    let web3 = Web3MockBinding::with_defaults().unwrap();

    let req = IrRequirements {
        required_host_functions: vec!["rotifer.log".into()],
        optional_host_functions: vec![],
        min_memory_bytes: 32 * 1024 * 1024, // 32 MB
        min_resource_budget: 0,
        ir_version: "0.1.0".into(),
    };

    let local_result = local.negotiate(&req);
    let web3_result = web3.negotiate(&req);

    assert!(
        local_result.is_compatible(),
        "local should accept 32MB gene (64MB ceiling)"
    );
    assert!(
        !web3_result.is_compatible(),
        "web3 should reject 32MB gene (16MB ceiling)"
    );

    if let NegotiationResult::Incompatible { reasons } = web3_result {
        assert!(reasons.iter().any(|r| matches!(
            r,
            IncompatibilityReason::MemoryExceeded { .. }
        )));
    }
}

// ---------------------------------------------------------------------------
// Test 4: Optional host function → PartiallyCompatible in Local
// ---------------------------------------------------------------------------

#[test]
fn optional_web3_extension_partially_compatible_in_local() {
    let local = LocalBinding::with_defaults().unwrap();

    let req = IrRequirements {
        required_host_functions: vec!["rotifer.log".into()],
        optional_host_functions: vec![
            "rotifer.ext.getBlockNumber".into(),
            "rotifer.ext.getChainId".into(),
        ],
        min_memory_bytes: 0,
        min_resource_budget: 0,
        ir_version: "0.1.0".into(),
    };

    let result = local.negotiate(&req);

    match result {
        NegotiationResult::PartiallyCompatible { missing_optional } => {
            assert!(missing_optional.contains(&"rotifer.ext.getBlockNumber".to_string()));
            assert!(missing_optional.contains(&"rotifer.ext.getChainId".to_string()));
        }
        other => panic!(
            "expected PartiallyCompatible for web3 extensions in local, got {other:?}"
        ),
    }
}

// ---------------------------------------------------------------------------
// Test 5: Required host function → Incompatible
// ---------------------------------------------------------------------------

#[test]
fn required_unknown_function_incompatible() {
    let local = LocalBinding::with_defaults().unwrap();
    let web3 = Web3MockBinding::with_defaults().unwrap();

    let req = IrRequirements {
        required_host_functions: vec![
            "rotifer.log".into(),
            "rotifer.ext.sendTransaction".into(), // neither binding provides this
        ],
        optional_host_functions: vec![],
        min_memory_bytes: 0,
        min_resource_budget: 0,
        ir_version: "0.1.0".into(),
    };

    let local_result = local.negotiate(&req);
    let web3_result = web3.negotiate(&req);

    assert!(
        !local_result.is_compatible(),
        "local should reject unknown required function"
    );
    assert!(
        !web3_result.is_compatible(),
        "web3 should reject unknown required function"
    );
}

// ---------------------------------------------------------------------------
// Test 6: Full transfer_ir round-trip
// ---------------------------------------------------------------------------

#[test]
fn transfer_ir_local_to_web3_accepted() {
    let web3 = Web3MockBinding::with_defaults().unwrap();
    let wasm = genesis::build_echo_gene_wasm();

    let request = IrTransferRequest {
        source_binding: "local".into(),
        target_binding: "web3-mock".into(),
        phenotype: test_phenotype(),
        ir_bytes: wasm,
        requirements: IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            optional_host_functions: vec![],
            min_memory_bytes: 1024 * 1024, // 1 MB
            min_resource_budget: 50_000,
            ir_version: "0.1.0".into(),
        },
    };

    let result = transfer_ir(&request, &web3);

    match result {
        TransferResult::Accepted { negotiation } => {
            assert!(negotiation.is_fully_compatible());
        }
        other => panic!("expected Accepted, got {other:?}"),
    }
}

#[test]
fn transfer_ir_empty_bytes_returns_no_ir() {
    let web3 = Web3MockBinding::with_defaults().unwrap();

    let request = IrTransferRequest {
        source_binding: "local".into(),
        target_binding: "web3-mock".into(),
        phenotype: test_phenotype(),
        ir_bytes: vec![],
        requirements: IrRequirements::default(),
    };

    let result = transfer_ir(&request, &web3);
    assert!(matches!(result, TransferResult::NoIrAvailable));
}

#[test]
fn transfer_ir_rejected_when_incompatible() {
    let web3 = Web3MockBinding::with_defaults().unwrap();
    let wasm = genesis::build_echo_gene_wasm();

    let request = IrTransferRequest {
        source_binding: "local".into(),
        target_binding: "web3-mock".into(),
        phenotype: test_phenotype(),
        ir_bytes: wasm,
        requirements: IrRequirements {
            required_host_functions: vec!["rotifer.ext.sendTransaction".into()],
            optional_host_functions: vec![],
            min_memory_bytes: 64 * 1024 * 1024, // exceeds web3 ceiling
            min_resource_budget: 0,
            ir_version: "0.1.0".into(),
        },
    };

    let result = transfer_ir(&request, &web3);
    match result {
        TransferResult::Rejected { reasons } => {
            assert!(reasons.len() >= 2, "should have multiple rejection reasons");
        }
        other => panic!("expected Rejected, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test: PartiallyCompatible gene can still execute (graceful degradation)
// ---------------------------------------------------------------------------

#[test]
fn partially_compatible_gene_executes_if_optional_not_called() {
    let local = LocalBinding::with_defaults().unwrap();
    let wasm = genesis::build_echo_gene_wasm();
    let input = serde_json::json!({"data": "graceful degradation test"});
    let ctx = test_context();
    let pheno = test_phenotype();

    // Negotiation says PartiallyCompatible (echo gene doesn't actually call
    // getBlockNumber, but we're testing the principle that PartiallyCompatible
    // genes can still execute when the missing optional functions aren't invoked).
    let req = IrRequirements {
        required_host_functions: vec!["rotifer.log".into()],
        optional_host_functions: vec!["rotifer.ext.getBlockNumber".into()],
        ..Default::default()
    };
    let negotiation = local.negotiate(&req);
    assert!(negotiation.is_compatible());
    assert!(!negotiation.is_fully_compatible());

    // Despite PartiallyCompatible, execution should succeed since echo gene
    // doesn't invoke the missing optional function.
    let result = local
        .execute_ir(&wasm, &ctx, input.clone(), &pheno)
        .expect("execution should succeed for PartiallyCompatible gene");

    match result {
        GeneResult::Success { data, .. } => {
            assert_eq!(data, input, "output should match input (echo behavior)");
        }
        other => panic!("expected Success, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Test: End-to-end from_wasm_bytes → negotiate pipeline
// ---------------------------------------------------------------------------

#[test]
fn from_wasm_bytes_auto_negotiation_pipeline() {
    let raw_wasm = genesis::build_echo_gene_wasm();
    let pheno = test_phenotype();

    let compiled = compile_to_ir(&raw_wasm, &pheno, None, None)
        .expect("compile should succeed");

    let auto_req = IrRequirements::from_wasm_bytes(&compiled.wasm_bytes)
        .expect("should extract requirements from compiled IR");

    assert_eq!(auto_req.ir_version, "0.2.0");
    assert!(auto_req.required_host_functions.contains(&"rotifer.log".into()));

    let local = LocalBinding::with_defaults().unwrap();
    let web3 = Web3MockBinding::with_defaults().unwrap();

    let local_result = local.negotiate(&auto_req);
    assert!(local_result.is_fully_compatible(), "local should fully support compiled gene");

    let web3_result = web3.negotiate(&auto_req);
    // The default constraints section has max_fuel 1_000_000 which exceeds
    // Web3's 500_000 ceiling, so negotiation should fail on resource budget.
    assert!(
        !web3_result.is_compatible(),
        "web3 should reject default-constraint gene (1M fuel > 500K ceiling)"
    );
}

// ---------------------------------------------------------------------------
// Bidirectional transfer symmetry
// ---------------------------------------------------------------------------

#[test]
fn transfer_ir_web3_to_local_accepted() {
    let local = LocalBinding::with_defaults().unwrap();
    let wasm = genesis::build_echo_gene_wasm();

    let request = IrTransferRequest {
        source_binding: "web3-mock".into(),
        target_binding: "local".into(),
        phenotype: test_phenotype(),
        ir_bytes: wasm,
        requirements: IrRequirements {
            required_host_functions: vec!["rotifer.log".into()],
            optional_host_functions: vec!["rotifer.ext.getBlockNumber".into()],
            min_memory_bytes: 4 * 1024 * 1024,
            min_resource_budget: 100_000,
            ir_version: "0.1.0".into(),
        },
    };

    let result = transfer_ir(&request, &local);

    match result {
        TransferResult::Accepted { negotiation } => {
            assert!(
                negotiation.is_compatible(),
                "local should accept web3 gene"
            );
            assert!(
                !negotiation.is_fully_compatible(),
                "should be partial — local lacks getBlockNumber"
            );
        }
        other => panic!("expected Accepted, got {other:?}"),
    }
}
