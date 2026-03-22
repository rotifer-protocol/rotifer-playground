use wasmparser::{Parser, Payload};
use wasm_encoder::Module;

use super::ir_sections::{
    CustomSectionPayloads, SECTION_CONSTRAINTS, SECTION_METERING, SECTION_PHENOTYPE,
    SECTION_VERSION,
};
use super::CompilerError;

/// Result of injecting Rotifer custom sections into a WASM module.
#[derive(Debug)]
pub struct InjectionResult {
    pub wasm_bytes: Vec<u8>,
    pub ir_hash: [u8; 32],
    pub code_section_size: usize,
}

/// Validate that the input WASM has the required exports, then produce a new
/// WASM binary with Rotifer custom sections appended.
pub fn inject_custom_sections(
    raw_wasm: &[u8],
    payloads: &CustomSectionPayloads,
) -> Result<InjectionResult, CompilerError> {
    validate_wasm_exports(raw_wasm)?;

    let code_section = extract_code_section(raw_wasm)?;
    let ir_hash = payloads.compute_ir_hash(&code_section);

    let output = append_sections(raw_wasm, payloads)?;

    Ok(InjectionResult {
        wasm_bytes: output,
        ir_hash,
        code_section_size: code_section.len(),
    })
}

/// Check that the WASM module exports the required interface.
///
/// Accepts two modes:
/// - **Direct**: `express(i32, i32) -> i32` + `memory`
/// - **WASI**: `_start() -> ()` + `memory` (Javy-compiled TypeScript genes)
fn validate_wasm_exports(wasm: &[u8]) -> Result<(), CompilerError> {
    let parser = Parser::new(0);
    let mut has_express = false;
    let mut has_start = false;
    let mut has_memory = false;

    let mut func_types: Vec<wasmparser::FuncType> = Vec::new();
    let mut func_type_indices: Vec<u32> = Vec::new();
    let mut import_func_count: u32 = 0;

    for payload in parser.parse_all(wasm) {
        let payload = payload.map_err(|e| {
            CompilerError::WasmCompilationFailed(format!("invalid WASM: {e}"))
        })?;

        match payload {
            Payload::TypeSection(reader) => {
                for ty in reader.into_iter_err_on_gc_types() {
                    let ty = ty.map_err(|e| {
                        CompilerError::WasmCompilationFailed(format!("type section: {e}"))
                    })?;
                    func_types.push(ty);
                }
            }
            Payload::ImportSection(reader) => {
                for import in reader {
                    let import = import.map_err(|e| {
                        CompilerError::WasmCompilationFailed(format!("import section: {e}"))
                    })?;
                    if matches!(import.ty, wasmparser::TypeRef::Func(_)) {
                        import_func_count += 1;
                    }
                }
            }
            Payload::FunctionSection(reader) => {
                for idx in reader {
                    let idx = idx.map_err(|e| {
                        CompilerError::WasmCompilationFailed(format!("function section: {e}"))
                    })?;
                    func_type_indices.push(idx);
                }
            }
            Payload::ExportSection(reader) => {
                for export in reader {
                    let export = export.map_err(|e| {
                        CompilerError::WasmCompilationFailed(format!("export section: {e}"))
                    })?;

                    match export.name {
                        "express" => {
                            if let wasmparser::ExternalKind::Func = export.kind {
                                let func_idx = export.index;
                                if func_idx >= import_func_count {
                                    let local_idx = (func_idx - import_func_count) as usize;
                                    if let Some(&type_idx) = func_type_indices.get(local_idx)
                                        && let Some(ft) = func_types.get(type_idx as usize)
                                    {
                                        let params_ok = ft.params().len() == 2
                                            && ft.params().iter().all(|p| {
                                                *p == wasmparser::ValType::I32
                                            });
                                        let results_ok = ft.results().len() == 1
                                            && ft.results()[0] == wasmparser::ValType::I32;
                                        if params_ok && results_ok {
                                            has_express = true;
                                        }
                                    }
                                }
                            }
                        }
                        "_start" => {
                            if let wasmparser::ExternalKind::Func = export.kind {
                                has_start = true;
                            }
                        }
                        "memory" => {
                            if let wasmparser::ExternalKind::Memory = export.kind {
                                has_memory = true;
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    if !has_memory {
        return Err(CompilerError::WasmCompilationFailed(
            "WASM module must export 'memory' (linear memory)".into(),
        ));
    }
    if !has_express && !has_start {
        return Err(CompilerError::WasmCompilationFailed(
            "WASM module must export 'express(i32, i32) -> i32' or '_start' (WASI)".into(),
        ));
    }

    Ok(())
}

/// Extract the raw bytes of the Code section for irHash computation.
fn extract_code_section(wasm: &[u8]) -> Result<Vec<u8>, CompilerError> {
    let parser = Parser::new(0);

    for payload in parser.parse_all(wasm) {
        let payload = payload.map_err(|e| {
            CompilerError::WasmCompilationFailed(format!("parse error: {e}"))
        })?;

        if let Payload::CodeSectionStart { range, .. } = payload {
            return Ok(wasm[range.start..range.end].to_vec());
        }
    }

    Err(CompilerError::WasmCompilationFailed(
        "WASM module has no Code section".into(),
    ))
}

/// Re-encode the WASM module with custom sections appended after all standard sections.
fn append_sections(
    raw_wasm: &[u8],
    payloads: &CustomSectionPayloads,
) -> Result<Vec<u8>, CompilerError> {
    let mut module = Module::new();

    let parser = Parser::new(0);
    for payload in parser.parse_all(raw_wasm) {
        let payload = payload.map_err(|e| {
            CompilerError::WasmCompilationFailed(format!("parse error: {e}"))
        })?;

        match &payload {
            Payload::Version { .. } => {}
            Payload::End(_) => {}
            _ => {
                if let Some((id, range)) = payload.as_section() {
                    module.section(&wasm_encoder::RawSection {
                        id,
                        data: &raw_wasm[range],
                    });
                }
            }
        }
    }

    module.section(&wasm_encoder::CustomSection {
        name: std::borrow::Cow::Borrowed(SECTION_VERSION),
        data: std::borrow::Cow::Borrowed(&payloads.version),
    });
    module.section(&wasm_encoder::CustomSection {
        name: std::borrow::Cow::Borrowed(SECTION_PHENOTYPE),
        data: std::borrow::Cow::Borrowed(&payloads.phenotype),
    });
    module.section(&wasm_encoder::CustomSection {
        name: std::borrow::Cow::Borrowed(SECTION_CONSTRAINTS),
        data: std::borrow::Cow::Borrowed(&payloads.constraints),
    });
    module.section(&wasm_encoder::CustomSection {
        name: std::borrow::Cow::Borrowed(SECTION_METERING),
        data: std::borrow::Cow::Borrowed(&payloads.metering),
    });

    Ok(module.finish())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::compiler::ir_sections::CustomSectionPayloads;
    use crate::types::gene::{Fidelity, GeneTransparency, Phenotype};

    /// Public helper for other test modules.
    pub fn minimal_wasm_pub() -> Vec<u8> {
        minimal_wasm()
    }

    fn test_phenotype() -> Phenotype {
        Phenotype {
            domain: "test.echo".into(),
            input_schema: serde_json::json!({"type": "object"}),
            output_schema: serde_json::json!({"type": "object"}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "test-author".into(),
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
            llm_requirements: None,
            guard_config: None,
        }
    }

    fn minimal_wasm() -> Vec<u8> {
        let mut module = wasm_encoder::Module::new();

        let mut types = wasm_encoder::TypeSection::new();
        types.ty().function(
            vec![wasm_encoder::ValType::I32, wasm_encoder::ValType::I32],
            vec![wasm_encoder::ValType::I32],
        );
        module.section(&types);

        let mut functions = wasm_encoder::FunctionSection::new();
        functions.function(0);
        module.section(&functions);

        let mut memories = wasm_encoder::MemorySection::new();
        memories.memory(wasm_encoder::MemoryType {
            minimum: 1,
            maximum: Some(16),
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        module.section(&memories);

        let mut exports = wasm_encoder::ExportSection::new();
        exports.export("express", wasm_encoder::ExportKind::Func, 0);
        exports.export("memory", wasm_encoder::ExportKind::Memory, 0);
        module.section(&exports);

        let mut code = wasm_encoder::CodeSection::new();
        let mut f = wasm_encoder::Function::new(vec![]);
        f.instruction(&wasm_encoder::Instruction::LocalGet(0));
        f.instruction(&wasm_encoder::Instruction::End);
        code.function(&f);
        module.section(&code);

        module.finish()
    }

    #[test]
    fn validate_minimal_wasm_passes() {
        let wasm = minimal_wasm();
        assert!(validate_wasm_exports(&wasm).is_ok());
    }

    #[test]
    fn validate_missing_express_fails() {
        let mut module = wasm_encoder::Module::new();
        let mut memories = wasm_encoder::MemorySection::new();
        memories.memory(wasm_encoder::MemoryType {
            minimum: 1,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        module.section(&memories);
        let mut exports = wasm_encoder::ExportSection::new();
        exports.export("memory", wasm_encoder::ExportKind::Memory, 0);
        module.section(&exports);
        let wasm = module.finish();

        let err = validate_wasm_exports(&wasm).unwrap_err();
        assert!(err.to_string().contains("express"));
    }

    #[test]
    fn validate_missing_memory_fails() {
        let mut module = wasm_encoder::Module::new();

        let mut types = wasm_encoder::TypeSection::new();
        types.ty().function(
            vec![wasm_encoder::ValType::I32, wasm_encoder::ValType::I32],
            vec![wasm_encoder::ValType::I32],
        );
        module.section(&types);

        let mut functions = wasm_encoder::FunctionSection::new();
        functions.function(0);
        module.section(&functions);

        let mut exports = wasm_encoder::ExportSection::new();
        exports.export("express", wasm_encoder::ExportKind::Func, 0);
        module.section(&exports);

        let mut code = wasm_encoder::CodeSection::new();
        let mut f = wasm_encoder::Function::new(vec![]);
        f.instruction(&wasm_encoder::Instruction::LocalGet(0));
        f.instruction(&wasm_encoder::Instruction::End);
        code.function(&f);
        module.section(&code);

        let wasm = module.finish();
        let err = validate_wasm_exports(&wasm).unwrap_err();
        assert!(err.to_string().contains("memory"));
    }

    #[test]
    fn inject_produces_valid_wasm_with_custom_sections() {
        let wasm = minimal_wasm();
        let pheno = test_phenotype();
        let payloads = CustomSectionPayloads::build(&pheno, None, None).unwrap();

        let result = inject_custom_sections(&wasm, &payloads).unwrap();

        assert!(result.wasm_bytes.len() > wasm.len());
        assert!(result.code_section_size > 0);

        let parser = Parser::new(0);
        let mut found_sections: Vec<String> = Vec::new();
        for payload in parser.parse_all(&result.wasm_bytes) {
            let payload = payload.unwrap();
            if let Payload::CustomSection(cs) = payload
                && cs.name().starts_with("rotifer.")
            {
                found_sections.push(cs.name().to_string());
            }
        }

        assert!(found_sections.contains(&"rotifer.version".to_string()));
        assert!(found_sections.contains(&"rotifer.phenotype".to_string()));
        assert!(found_sections.contains(&"rotifer.constraints".to_string()));
        assert!(found_sections.contains(&"rotifer.metering".to_string()));
    }

    #[test]
    fn ir_hash_is_deterministic() {
        let wasm = minimal_wasm();
        let pheno = test_phenotype();
        let payloads = CustomSectionPayloads::build(&pheno, None, None).unwrap();

        let r1 = inject_custom_sections(&wasm, &payloads).unwrap();
        let r2 = inject_custom_sections(&wasm, &payloads).unwrap();
        assert_eq!(r1.ir_hash, r2.ir_hash);
    }
}
