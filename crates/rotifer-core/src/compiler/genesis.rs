use wasm_encoder::{
    CodeSection, ExportKind, ExportSection, Function, FunctionSection, Instruction, MemorySection,
    MemoryType, Module, TypeSection, ValType,
};

/// Build a minimal "echo" WASM gene that copies input bytes to a fixed output
/// offset and returns the output pointer.
///
/// Memory layout:
///   [0 .. input_len)         — input data (written by host)
///   [65536 .. 65536+input_len) — output data (copied by gene)
///
/// The `express` function:
///   1. Copies input_len bytes from input_ptr to OUTPUT_BASE
///   2. Returns OUTPUT_BASE as i32
pub fn build_echo_gene_wasm() -> Vec<u8> {
    let mut module = Module::new();

    // Type section: (i32, i32) -> i32 for express, (i32) -> i32 for alloc
    let mut types = TypeSection::new();
    types
        .ty()
        .function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    types.ty().function(vec![ValType::I32], vec![ValType::I32]);
    module.section(&types);

    // Function section: two functions (express=type0, alloc=type1)
    let mut functions = FunctionSection::new();
    functions.function(0); // express
    functions.function(1); // alloc
    module.section(&functions);

    // Memory section: 2 pages (128 KB)
    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 2,
        maximum: Some(16),
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);

    // Export section
    let mut exports = ExportSection::new();
    exports.export("express", ExportKind::Func, 0);
    exports.export("alloc", ExportKind::Func, 1);
    exports.export("memory", ExportKind::Memory, 0);
    module.section(&exports);

    // Code section
    let mut code = CodeSection::new();

    // express(input_ptr: i32, input_len: i32) -> i32
    // Uses memory.copy to duplicate input to output area
    {
        let mut f = Function::new(vec![]);
        let output_base: i32 = 65536; // page 1

        // memory.copy(dst, src, len)
        f.instruction(&Instruction::I32Const(output_base)); // dst
        f.instruction(&Instruction::LocalGet(0)); // src = input_ptr
        f.instruction(&Instruction::LocalGet(1)); // len = input_len
        f.instruction(&Instruction::MemoryCopy {
            src_mem: 0,
            dst_mem: 0,
        });

        // Return output_base
        f.instruction(&Instruction::I32Const(output_base));
        f.instruction(&Instruction::End);
        code.function(&f);
    }

    // alloc(size: i32) -> i32  — bump allocator starting at page 0 offset 0
    {
        let mut f = Function::new(vec![]);
        // For simplicity, return 0 (input always starts at offset 0)
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::End);
        code.function(&f);
    }

    module.section(&code);

    module.finish()
}

/// Build a minimal JSON-passthrough gene that wraps input in a `{"result": <input>}` envelope.
/// This demonstrates a gene that does minimal transformation.
///
/// Since constructing JSON in raw WASM is complex, this gene:
/// 1. Writes a fixed prefix `{"result":` to output area
/// 2. Copies input bytes
/// 3. Writes closing `}`
/// 4. Returns pointer to output
pub fn build_wrap_gene_wasm() -> Vec<u8> {
    let mut module = Module::new();

    let mut types = TypeSection::new();
    types
        .ty()
        .function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    types.ty().function(vec![ValType::I32], vec![ValType::I32]);
    module.section(&types);

    let mut functions = FunctionSection::new();
    functions.function(0);
    functions.function(1);
    module.section(&functions);

    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 2,
        maximum: Some(16),
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);

    // Data section: store the prefix string at a known offset
    let prefix = b"{\"result\":";
    let suffix = b"}";

    let mut data = wasm_encoder::DataSection::new();
    // Prefix at offset 0x10000 (page 1)
    data.active(
        0,
        &wasm_encoder::ConstExpr::i32_const(0x10000),
        prefix.to_vec(),
    );
    // Suffix right after prefix space (we'll compute dynamically)
    module.section(&{
        let mut exports = ExportSection::new();
        exports.export("express", ExportKind::Func, 0);
        exports.export("alloc", ExportKind::Func, 1);
        exports.export("memory", ExportKind::Memory, 0);
        exports
    });

    let mut code = CodeSection::new();

    // express(input_ptr, input_len) -> i32
    {
        let mut f = Function::new(vec![
            (1, ValType::I32), // local: write_ptr
        ]);

        let out_base: i32 = 0x10000;
        let prefix_len = prefix.len() as i32;

        // write_ptr = out_base + prefix_len
        f.instruction(&Instruction::I32Const(out_base + prefix_len));
        f.instruction(&Instruction::LocalSet(2)); // write_ptr

        // memory.copy(write_ptr, input_ptr, input_len)
        f.instruction(&Instruction::LocalGet(2));
        f.instruction(&Instruction::LocalGet(0));
        f.instruction(&Instruction::LocalGet(1));
        f.instruction(&Instruction::MemoryCopy {
            src_mem: 0,
            dst_mem: 0,
        });

        // write suffix "}" at write_ptr + input_len
        f.instruction(&Instruction::LocalGet(2));
        f.instruction(&Instruction::LocalGet(1));
        f.instruction(&Instruction::I32Add);
        f.instruction(&Instruction::I32Const(suffix[0] as i32));
        f.instruction(&Instruction::I32Store8(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        }));

        // null terminator
        f.instruction(&Instruction::LocalGet(2));
        f.instruction(&Instruction::LocalGet(1));
        f.instruction(&Instruction::I32Add);
        f.instruction(&Instruction::I32Const(1));
        f.instruction(&Instruction::I32Add);
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Store8(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        }));

        // return out_base
        f.instruction(&Instruction::I32Const(out_base));
        f.instruction(&Instruction::End);
        code.function(&f);
    }

    // alloc(size) -> 0
    {
        let mut f = Function::new(vec![]);
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::End);
        code.function(&f);
    }

    module.section(&code);
    module.section(&data);

    module.finish()
}

/// Helper: build a gene that wraps input JSON inside a fixed envelope.
///
/// Output layout: `prefix + input_bytes + suffix + \0`
/// All stored starting at 0x10000 (page 1).
fn build_envelope_gene(prefix: &[u8], suffix: &[u8]) -> Vec<u8> {
    let mut module = Module::new();

    let mut types = TypeSection::new();
    types
        .ty()
        .function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
    types.ty().function(vec![ValType::I32], vec![ValType::I32]);
    module.section(&types);

    let mut functions = FunctionSection::new();
    functions.function(0); // express
    functions.function(1); // alloc
    module.section(&functions);

    let mut memories = MemorySection::new();
    memories.memory(MemoryType {
        minimum: 2,
        maximum: Some(16),
        memory64: false,
        shared: false,
        page_size_log2: None,
    });
    module.section(&memories);

    let mut data = wasm_encoder::DataSection::new();
    data.active(
        0,
        &wasm_encoder::ConstExpr::i32_const(0x10000),
        prefix.to_vec(),
    );

    let mut exports = ExportSection::new();
    exports.export("express", ExportKind::Func, 0);
    exports.export("alloc", ExportKind::Func, 1);
    exports.export("memory", ExportKind::Memory, 0);
    module.section(&exports);

    let mut code = CodeSection::new();

    // express(input_ptr, input_len) -> i32
    {
        let mut f = Function::new(vec![
            (1, ValType::I32), // local: write_ptr
        ]);

        let out_base: i32 = 0x10000;
        let prefix_len = prefix.len() as i32;

        // write_ptr = out_base + prefix_len
        f.instruction(&Instruction::I32Const(out_base + prefix_len));
        f.instruction(&Instruction::LocalSet(2));

        // memory.copy(write_ptr, input_ptr, input_len)
        f.instruction(&Instruction::LocalGet(2));
        f.instruction(&Instruction::LocalGet(0));
        f.instruction(&Instruction::LocalGet(1));
        f.instruction(&Instruction::MemoryCopy {
            src_mem: 0,
            dst_mem: 0,
        });

        // write suffix bytes at write_ptr + input_len
        for (i, &byte) in suffix.iter().enumerate() {
            f.instruction(&Instruction::LocalGet(2));
            f.instruction(&Instruction::LocalGet(1));
            f.instruction(&Instruction::I32Add);
            if i > 0 {
                f.instruction(&Instruction::I32Const(i as i32));
                f.instruction(&Instruction::I32Add);
            }
            f.instruction(&Instruction::I32Const(byte as i32));
            f.instruction(&Instruction::I32Store8(wasm_encoder::MemArg {
                offset: 0,
                align: 0,
                memory_index: 0,
            }));
        }

        // null terminator after suffix
        f.instruction(&Instruction::LocalGet(2));
        f.instruction(&Instruction::LocalGet(1));
        f.instruction(&Instruction::I32Add);
        f.instruction(&Instruction::I32Const(suffix.len() as i32));
        f.instruction(&Instruction::I32Add);
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::I32Store8(wasm_encoder::MemArg {
            offset: 0,
            align: 0,
            memory_index: 0,
        }));

        f.instruction(&Instruction::I32Const(out_base));
        f.instruction(&Instruction::End);
        code.function(&f);
    }

    // alloc(size) -> 0
    {
        let mut f = Function::new(vec![]);
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::End);
        code.function(&f);
    }

    module.section(&code);
    module.section(&data);

    module.finish()
}

/// Build a "search" genesis gene.
///
/// Takes any JSON input and returns it wrapped as:
/// `{"results":<input>,"total":1}`
pub fn build_search_gene_wasm() -> Vec<u8> {
    build_envelope_gene(b"{\"results\":", b",\"total\":1}")
}

/// Build a "summarize" genesis gene.
///
/// Takes any JSON input and returns it wrapped as:
/// `{"summary":<input>,"ratio":0.5}`
pub fn build_summarize_gene_wasm() -> Vec<u8> {
    build_envelope_gene(b"{\"summary\":", b",\"ratio\":0.5}")
}

/// Build a "translate" genesis gene.
///
/// Takes any JSON input and returns it wrapped as:
/// `{"translated":<input>,"lang":"en"}`
pub fn build_translate_gene_wasm() -> Vec<u8> {
    build_envelope_gene(b"{\"translated\":", b",\"lang\":\"en\"}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compiler::compile_to_ir;
    use crate::sandbox::Sandbox;
    use crate::types::gene::{Fidelity, GeneTransparency, Phenotype};

    fn echo_phenotype() -> Phenotype {
        Phenotype {
            domain: "system.echo".into(),
            input_schema: serde_json::json!({"type": "object"}),
            output_schema: serde_json::json!({"type": "object"}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "rotifer-genesis".into(),
            created_at: 1000,
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

    #[test]
    fn echo_gene_is_valid_wasm() {
        let wasm = build_echo_gene_wasm();
        let engine = wasmtime::Engine::default();
        wasmtime::Module::validate(&engine, &wasm).expect("echo gene should be valid WASM");
    }

    #[test]
    fn echo_gene_compiles_to_ir() {
        let wasm = build_echo_gene_wasm();
        let pheno = echo_phenotype();
        let result = compile_to_ir(&wasm, &pheno, None, None).unwrap();
        assert!(result.total_size > wasm.len());
        assert!(!result.ir_hash_hex.is_empty());
        assert_eq!(result.ir_hash_hex.len(), 64); // SHA-256 hex
    }

    #[test]
    fn wrap_gene_is_valid_wasm() {
        let wasm = build_wrap_gene_wasm();
        let engine = wasmtime::Engine::default();
        wasmtime::Module::validate(&engine, &wasm).expect("wrap gene should be valid WASM");
    }

    #[test]
    fn echo_gene_executes_in_sandbox() {
        use crate::sandbox::{ConstraintSet, WasmtimeSandbox};
        use crate::types::{Context, GeneResult, PermissionSet, ResourceLimits};

        let wasm = build_echo_gene_wasm();
        let sandbox = WasmtimeSandbox::new(ConstraintSet::default()).unwrap();

        let ctx = Context {
            agent_id: "test-agent".into(),
            timestamp: 1000,
            permissions: PermissionSet {
                allowed_domains: None,
                resource_limits: ResourceLimits::default(),
                network_access: false,
                file_system_access: None,
            },
            trace_id: None,
            binding_extensions: None,
        };

        let input = serde_json::json!({"hello": "world"});
        let result = sandbox.execute(&wasm, &ctx, input.clone()).unwrap();

        match result {
            GeneResult::Success { data, .. } => {
                assert_eq!(data, input, "echo gene should return input unchanged");
            }
            GeneResult::Error { message, .. } => {
                panic!("echo gene failed: {message}");
            }
        }
    }

    fn test_ctx() -> crate::types::Context {
        use crate::types::{Context, PermissionSet};
        Context {
            agent_id: "test".into(),
            timestamp: 1000,
            permissions: PermissionSet::default(),
            trace_id: None,
            binding_extensions: None,
        }
    }

    fn gene_phenotype(domain: &str) -> Phenotype {
        Phenotype {
            domain: domain.into(),
            input_schema: serde_json::json!({"type": "object"}),
            output_schema: serde_json::json!({"type": "object"}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "rotifer-genesis".into(),
            created_at: 1000,
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

    // ── Search gene tests ──

    #[test]
    fn search_gene_is_valid_wasm() {
        let wasm = build_search_gene_wasm();
        let engine = wasmtime::Engine::default();
        wasmtime::Module::validate(&engine, &wasm).expect("search gene should be valid WASM");
    }

    #[test]
    fn search_gene_compiles_to_ir() {
        let wasm = build_search_gene_wasm();
        let pheno = gene_phenotype("search.web");
        let result = compile_to_ir(&wasm, &pheno, None, None).unwrap();
        assert!(result.total_size > wasm.len());
        assert_eq!(result.ir_hash_hex.len(), 64);
    }

    #[test]
    fn search_gene_executes_in_sandbox() {
        use crate::sandbox::{ConstraintSet, WasmtimeSandbox};
        use crate::types::GeneResult;

        let wasm = build_search_gene_wasm();
        let sandbox = WasmtimeSandbox::new(ConstraintSet::default()).unwrap();
        let input = serde_json::json!({"query": "rotifer"});
        let result = sandbox.execute(&wasm, &test_ctx(), input).unwrap();

        match result {
            GeneResult::Success { data, .. } => {
                assert!(data.get("results").is_some(), "should have 'results' field");
                assert_eq!(data.get("total").and_then(|v| v.as_i64()), Some(1));
            }
            GeneResult::Error { message, .. } => panic!("search gene failed: {message}"),
        }
    }

    // ── Summarize gene tests ──

    #[test]
    fn summarize_gene_is_valid_wasm() {
        let wasm = build_summarize_gene_wasm();
        let engine = wasmtime::Engine::default();
        wasmtime::Module::validate(&engine, &wasm).expect("summarize gene should be valid WASM");
    }

    #[test]
    fn summarize_gene_compiles_to_ir() {
        let wasm = build_summarize_gene_wasm();
        let pheno = gene_phenotype("text.summarize");
        let result = compile_to_ir(&wasm, &pheno, None, None).unwrap();
        assert!(result.total_size > wasm.len());
        assert_eq!(result.ir_hash_hex.len(), 64);
    }

    #[test]
    fn summarize_gene_executes_in_sandbox() {
        use crate::sandbox::{ConstraintSet, WasmtimeSandbox};
        use crate::types::GeneResult;

        let wasm = build_summarize_gene_wasm();
        let sandbox = WasmtimeSandbox::new(ConstraintSet::default()).unwrap();
        let input = serde_json::json!({"text": "Hello world, this is a long document."});
        let result = sandbox.execute(&wasm, &test_ctx(), input).unwrap();

        match result {
            GeneResult::Success { data, .. } => {
                assert!(data.get("summary").is_some(), "should have 'summary' field");
                assert_eq!(data.get("ratio").and_then(|v| v.as_f64()), Some(0.5));
            }
            GeneResult::Error { message, .. } => panic!("summarize gene failed: {message}"),
        }
    }

    // ── Translate gene tests ──

    #[test]
    fn translate_gene_is_valid_wasm() {
        let wasm = build_translate_gene_wasm();
        let engine = wasmtime::Engine::default();
        wasmtime::Module::validate(&engine, &wasm).expect("translate gene should be valid WASM");
    }

    #[test]
    fn translate_gene_compiles_to_ir() {
        let wasm = build_translate_gene_wasm();
        let pheno = gene_phenotype("text.translate");
        let result = compile_to_ir(&wasm, &pheno, None, None).unwrap();
        assert!(result.total_size > wasm.len());
        assert_eq!(result.ir_hash_hex.len(), 64);
    }

    #[test]
    fn translate_gene_executes_in_sandbox() {
        use crate::sandbox::{ConstraintSet, WasmtimeSandbox};
        use crate::types::GeneResult;

        let wasm = build_translate_gene_wasm();
        let sandbox = WasmtimeSandbox::new(ConstraintSet::default()).unwrap();
        let input = serde_json::json!({"text": "Hello", "target": "zh"});
        let result = sandbox.execute(&wasm, &test_ctx(), input).unwrap();

        match result {
            GeneResult::Success { data, .. } => {
                assert!(data.get("translated").is_some(), "should have 'translated' field");
                assert_eq!(data.get("lang").and_then(|v| v.as_str()), Some("en"));
            }
            GeneResult::Error { message, .. } => panic!("translate gene failed: {message}"),
        }
    }
}
