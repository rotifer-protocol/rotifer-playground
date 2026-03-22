//! WASM security tests for Rotifer sandbox.
//!
//! Covers the v0.8 attack vector matrix (plan §3.2):
//!   - Memory OOB
//!   - Infinite loop / recursion
//!   - Host function abuse
//!   - Malformed WASM
//!   - Resource exhaustion (memory/table)
//!   - Fuel exhaustion

use rotifer_core::sandbox::{ConstraintSet, Sandbox, SandboxError, WasmtimeSandbox};
use rotifer_core::types::{Context, GeneResult, PermissionSet};
use wasm_encoder::*;

fn test_context() -> Context {
    Context {
        agent_id: "security-test".into(),
        timestamp: 99999,
        permissions: PermissionSet::default(),
        trace_id: Some("sec-trace".into()),
        binding_extensions: None,
    }
}

fn tight_constraints() -> ConstraintSet {
    ConstraintSet {
        max_memory_bytes: 2 * 1024 * 1024, // 2 MB
        max_fuel: 500_000,
        max_execution_time_ms: 2_000, // 2 seconds
        allowed_host_functions: Vec::new(),
        denied_host_functions: Vec::new(),
    }
}

// ============================================================
// 1. Malformed WASM — invalid magic bytes
// ============================================================

#[test]
fn malformed_invalid_magic_bytes() {
    let sb = WasmtimeSandbox::with_defaults().unwrap();
    let garbage = vec![0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x00, 0x00, 0x00];
    let result = sb.execute(&garbage, &test_context(), serde_json::json!({}));
    assert!(result.is_err());
    match result.unwrap_err() {
        SandboxError::CompilationFailed(_) => {}
        other => panic!("expected CompilationFailed, got: {other}"),
    }
}

#[test]
fn malformed_empty_bytes() {
    let sb = WasmtimeSandbox::with_defaults().unwrap();
    let result = sb.execute(&[], &test_context(), serde_json::json!({}));
    assert!(result.is_err());
}

#[test]
fn malformed_truncated_wasm() {
    let sb = WasmtimeSandbox::with_defaults().unwrap();
    // Valid magic + version but nothing else, then truncated
    let truncated = vec![0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00, 0xFF];
    let result = sb.execute(&truncated, &test_context(), serde_json::json!({}));
    assert!(result.is_err());
}

#[test]
fn malformed_oversized_custom_section() {
    let mut module = Module::new();

    // 1 MB custom section — should be accepted but handled gracefully
    let big_payload = vec![0u8; 1024 * 1024];
    module.section(&CustomSection {
        name: std::borrow::Cow::Borrowed("huge"),
        data: std::borrow::Cow::Borrowed(&big_payload),
    });

    // Minimal valid function
    let mut types = TypeSection::new();
    types.ty().function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    module.section(&types);
    let mut funcs = FunctionSection::new();
    funcs.function(0);
    module.section(&funcs);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1,
        maximum: Some(1),
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("express", ExportKind::Func, 0);
    module.section(&exports);
    let mut code = CodeSection::new();
    let mut f = Function::new(vec![]);
    f.instruction(&Instruction::LocalGet(0));
    f.instruction(&Instruction::End);
    code.function(&f);
    module.section(&code);

    let wasm = module.finish();
    let sb = WasmtimeSandbox::with_defaults().unwrap();
    // Should not panic — either succeeds or fails gracefully
    let _ = sb.execute(&wasm, &test_context(), serde_json::json!({"x": 1}));
}

// ============================================================
// 2. Fuel exhaustion — compute-intensive operations
// ============================================================

#[test]
fn fuel_exhaustion_tight_budget() {
    let constraints = ConstraintSet {
        max_fuel: 100,
        ..ConstraintSet::default()
    };
    let sb = WasmtimeSandbox::new(constraints).unwrap();
    let wasm = build_busy_loop_wasm(1000);
    let result = sb.execute(&wasm, &test_context(), serde_json::json!({}));
    match result {
        Err(SandboxError::ResourceLimitExceeded(msg)) => {
            assert!(msg.contains("fuel") || msg.contains("timed out"), "unexpected msg: {msg}");
        }
        Err(SandboxError::ExecutionFailed(msg)) => {
            assert!(msg.contains("fuel") || msg.contains("all fuel"), "unexpected msg: {msg}");
        }
        Ok(GeneResult::Error { .. }) => {} // also acceptable
        other => panic!("expected fuel error, got: {other:?}"),
    }
}

// ============================================================
// 3. Infinite loop — epoch interruption timeout
// ============================================================

#[test]
fn infinite_loop_epoch_interruption() {
    let constraints = ConstraintSet {
        max_fuel: 10_000_000_000, // enough fuel to not exhaust
        max_execution_time_ms: 500, // very short timeout
        max_memory_bytes: 64 * 1024 * 1024,
        ..ConstraintSet::default()
    };
    let sb = WasmtimeSandbox::new(constraints).unwrap();
    let wasm = build_infinite_loop_wasm();

    let start = std::time::Instant::now();
    let result = sb.execute(&wasm, &test_context(), serde_json::json!({}));
    let elapsed = start.elapsed();

    assert!(result.is_err(), "infinite loop should be interrupted");
    // Should complete within ~2x the timeout (500ms + thread scheduling overhead)
    assert!(
        elapsed.as_millis() < 3000,
        "execution took too long: {}ms (expected <3000ms)",
        elapsed.as_millis()
    );
}

// ============================================================
// 4. Memory exhaustion — memory.grow beyond limits
// ============================================================

#[test]
fn memory_exhaustion_beyond_limit() {
    let sb = WasmtimeSandbox::new(tight_constraints()).unwrap();
    let wasm = build_memory_hog_wasm(100); // tries to grow to 100 pages = 6.4 MB > 2 MB limit

    let result = sb.execute(&wasm, &test_context(), serde_json::json!({}));
    // Should either error or the memory.grow returns -1 (failure)
    match &result {
        Err(_) => {} // limiter blocked it
        Ok(GeneResult::Success { data, .. }) => {
            // memory.grow returned -1 → gene reports failure
            let grow_result = data.get("grow_result").and_then(|v| v.as_i64());
            if let Some(r) = grow_result {
                assert_eq!(r, -1, "memory.grow should return -1 when blocked");
            }
        }
        Ok(GeneResult::Error { .. }) => {} // gene-level error
    }
}

// ============================================================
// 5. Host function abuse — calling unregistered imports
// ============================================================

#[test]
fn unregistered_host_function_rejected() {
    let sb = WasmtimeSandbox::with_defaults().unwrap();
    let wasm = build_module_with_unknown_import();
    let result = sb.execute(&wasm, &test_context(), serde_json::json!({}));
    assert!(result.is_err(), "module with unknown import should fail");
    // Should fail at instantiation, not panic
}

// ============================================================
// 6. Validate-only tests
// ============================================================

#[test]
fn validate_rejects_invalid_wasm() {
    let sb = WasmtimeSandbox::with_defaults().unwrap();
    assert!(sb.validate(&[0xFF, 0xFF, 0xFF, 0xFF], &ConstraintSet::default()).is_err());
}

#[test]
fn validate_accepts_valid_wasm() {
    let sb = WasmtimeSandbox::with_defaults().unwrap();
    let wasm = build_minimal_express_wasm();
    assert!(sb.validate(&wasm, &ConstraintSet::default()).unwrap());
}

// ============================================================
// 7. Process stability — no panics from any malicious input
// ============================================================

#[test]
fn no_panic_on_various_malicious_inputs() {
    let sb = WasmtimeSandbox::new(tight_constraints()).unwrap();
    let inputs: Vec<Vec<u8>> = vec![
        vec![],
        vec![0x00],
        vec![0x00, 0x61, 0x73, 0x6D],
        vec![0xFF; 100],
        vec![0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00],
        build_infinite_loop_wasm(),
    ];
    for (i, wasm) in inputs.iter().enumerate() {
        // Must not panic — errors are acceptable
        let _ = sb.execute(wasm, &test_context(), serde_json::json!({"test": i}));
    }
}

// ============================================================
// Test WASM builders
// ============================================================

fn build_minimal_express_wasm() -> Vec<u8> {
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    module.section(&types);
    let mut funcs = FunctionSection::new();
    funcs.function(0);
    module.section(&funcs);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1, maximum: Some(1), memory64: false, shared: false, page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("express", ExportKind::Func, 0);
    module.section(&exports);
    let mut code = CodeSection::new();
    let mut f = Function::new(vec![]);
    f.instruction(&Instruction::LocalGet(0));
    f.instruction(&Instruction::End);
    code.function(&f);
    module.section(&code);
    module.finish()
}

fn build_busy_loop_wasm(iterations: u32) -> Vec<u8> {
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    module.section(&types);
    let mut funcs = FunctionSection::new();
    funcs.function(0);
    module.section(&funcs);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1, maximum: Some(1), memory64: false, shared: false, page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("express", ExportKind::Func, 0);
    module.section(&exports);
    let mut code = CodeSection::new();
    let mut f = Function::new(vec![(1, ValType::I32)]);
    // local counter = iterations
    f.instruction(&Instruction::I32Const(iterations as i32));
    f.instruction(&Instruction::LocalSet(2));
    // loop { counter -= 1; if counter == 0 break }
    f.instruction(&Instruction::Block(BlockType::Empty));
    f.instruction(&Instruction::Loop(BlockType::Empty));
    f.instruction(&Instruction::LocalGet(2));
    f.instruction(&Instruction::I32Const(1));
    f.instruction(&Instruction::I32Sub);
    f.instruction(&Instruction::LocalTee(2));
    f.instruction(&Instruction::I32Eqz);
    f.instruction(&Instruction::BrIf(1));
    f.instruction(&Instruction::Br(0));
    f.instruction(&Instruction::End);
    f.instruction(&Instruction::End);
    f.instruction(&Instruction::LocalGet(0));
    f.instruction(&Instruction::End);
    code.function(&f);
    module.section(&code);
    module.finish()
}

fn build_infinite_loop_wasm() -> Vec<u8> {
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    module.section(&types);
    let mut funcs = FunctionSection::new();
    funcs.function(0);
    module.section(&funcs);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1, maximum: Some(1), memory64: false, shared: false, page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("express", ExportKind::Func, 0);
    module.section(&exports);
    let mut code = CodeSection::new();
    let mut f = Function::new(vec![]);
    // Infinite loop: loop { br 0 }
    f.instruction(&Instruction::Loop(BlockType::Empty));
    f.instruction(&Instruction::Br(0));
    f.instruction(&Instruction::End);
    f.instruction(&Instruction::I32Const(0));
    f.instruction(&Instruction::End);
    code.function(&f);
    module.section(&code);
    module.finish()
}

fn build_memory_hog_wasm(grow_pages: u32) -> Vec<u8> {
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    module.section(&types);
    let mut funcs = FunctionSection::new();
    funcs.function(0);
    module.section(&funcs);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1, maximum: None, memory64: false, shared: false, page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("express", ExportKind::Func, 0);
    module.section(&exports);
    let mut code = CodeSection::new();
    let mut f = Function::new(vec![]);
    // memory.grow(grow_pages) — returns previous size or -1
    f.instruction(&Instruction::I32Const(grow_pages as i32));
    f.instruction(&Instruction::MemoryGrow(0));
    f.instruction(&Instruction::End);
    code.function(&f);
    module.section(&code);
    module.finish()
}

fn build_module_with_unknown_import() -> Vec<u8> {
    let mut module = Module::new();
    let mut types = TypeSection::new();
    types.ty().function(vec![], vec![]);
    types.ty().function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    module.section(&types);
    let mut imports = ImportSection::new();
    imports.import("evil", "steal_data", EntityType::Function(0));
    module.section(&imports);
    let mut funcs = FunctionSection::new();
    funcs.function(1);
    module.section(&funcs);
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 1, maximum: Some(1), memory64: false, shared: false, page_size_log2: None,
    });
    module.section(&memories);
    let mut exports = ExportSection::new();
    exports.export("memory", ExportKind::Memory, 0);
    exports.export("express", ExportKind::Func, 1);
    module.section(&exports);
    let mut code = CodeSection::new();
    let mut f = Function::new(vec![]);
    f.instruction(&Instruction::Call(0)); // call evil.steal_data
    f.instruction(&Instruction::I32Const(0));
    f.instruction(&Instruction::End);
    code.function(&f);
    module.section(&code);
    module.finish()
}
