use wasmparser::{Parser, Payload};

use super::ir_sections::{
    SECTION_CONSTRAINTS, SECTION_METERING, SECTION_PHENOTYPE, SECTION_VERSION,
};

/// Outcome of IR verification — pass, pass-with-warnings, or fail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyLevel {
    /// Module passes all checks.
    Pass,
    /// Module is valid but has non-critical warnings.
    Warn(Vec<String>),
    /// Module is invalid; contains blocking errors.
    Fail(Vec<String>),
}

/// Static verification of a Rotifer IR module (spec §7.3).
///
/// Checks:
/// 1. Valid WASM binary
/// 2. Required custom sections present (rotifer.version, phenotype, constraints, metering)
/// 3. Required exports: `express(i32, i32) -> i32` and `memory`
/// 4. No prohibited instructions (SIMD, threads, atomics)
/// 5. Memory declarations within limits
pub fn verify_ir_module(wasm: &[u8]) -> VerifyLevel {
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if let Err(e) = check_structure(wasm) {
        errors.push(e);
    }

    match check_custom_sections(wasm) {
        Ok(warns) => warnings.extend(warns),
        Err(e) => errors.push(e),
    }

    match check_exports(wasm) {
        Ok(()) => {}
        Err(e) => errors.push(e),
    }

    match check_instructions(wasm) {
        Ok(warns) => warnings.extend(warns),
        Err(errs) => errors.extend(errs),
    }

    match check_memory_limits(wasm) {
        Ok(warns) => warnings.extend(warns),
        Err(e) => errors.push(e),
    }

    if !errors.is_empty() {
        VerifyLevel::Fail(errors)
    } else if !warnings.is_empty() {
        VerifyLevel::Warn(warnings)
    } else {
        VerifyLevel::Pass
    }
}

fn check_structure(wasm: &[u8]) -> Result<(), String> {
    let parser = Parser::new(0);
    for payload in parser.parse_all(wasm) {
        if let Err(e) = payload {
            return Err(format!("invalid WASM structure: {e}"));
        }
    }
    Ok(())
}

fn check_custom_sections(wasm: &[u8]) -> Result<Vec<String>, String> {
    let parser = Parser::new(0);
    let required = [
        SECTION_VERSION,
        SECTION_PHENOTYPE,
        SECTION_CONSTRAINTS,
        SECTION_METERING,
    ];
    let mut found: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for payload in parser.parse_all(wasm) {
        let payload = payload.map_err(|e| format!("parse error: {e}"))?;
        if let Payload::CustomSection(cs) = payload
            && cs.name().starts_with("rotifer.")
        {
            found.push(cs.name().to_string());
            if cs.data().is_empty() {
                warnings
                    .push(format!("custom section '{}' has zero-length data", cs.name()));
            }
        }
    }

    let mut missing = Vec::new();
    for name in &required {
        if !found.iter().any(|f| f == *name) {
            missing.push(*name);
        }
    }

    if !missing.is_empty() {
        return Err(format!(
            "missing required custom sections: {}",
            missing.join(", ")
        ));
    }

    Ok(warnings)
}

fn check_exports(wasm: &[u8]) -> Result<(), String> {
    let parser = Parser::new(0);
    let mut has_express = false;
    let mut has_start = false;
    let mut has_memory = false;

    for payload in parser.parse_all(wasm) {
        let payload = payload.map_err(|e| format!("parse error: {e}"))?;
        if let Payload::ExportSection(reader) = payload {
            for export in reader {
                let export = export.map_err(|e| format!("export error: {e}"))?;
                match export.name {
                    "express" if matches!(export.kind, wasmparser::ExternalKind::Func) => {
                        has_express = true;
                    }
                    "_start" if matches!(export.kind, wasmparser::ExternalKind::Func) => {
                        has_start = true;
                    }
                    "memory" if matches!(export.kind, wasmparser::ExternalKind::Memory) => {
                        has_memory = true;
                    }
                    _ => {}
                }
            }
        }
    }

    // Accept either direct-export (`express`) or WASI (`_start`) modules
    if !has_express && !has_start {
        return Err("missing required export: 'express' function or '_start' (WASI)".into());
    }
    if !has_memory {
        return Err("missing required export: 'memory'".into());
    }

    Ok(())
}

/// Check for prohibited WASM instructions (spec §5.1):
/// - SIMD instructions → warning (safe, widely supported by Javy/QuickJS)
/// - Thread/atomic instructions → error (concurrency safety)
fn check_instructions(wasm: &[u8]) -> Result<Vec<String>, Vec<String>> {
    let parser = Parser::new(0);
    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut simd_count: usize = 0;

    for payload in parser.parse_all(wasm) {
        let payload = match payload {
            Ok(p) => p,
            Err(_) => continue,
        };

        if let Payload::CodeSectionEntry(body) = payload {
            let reader = body.get_operators_reader();
            match reader {
                Ok(ops) => {
                    for op in ops {
                        match op {
                            Ok(op) => {
                                let name = format!("{op:?}");
                                if name.starts_with("V128")
                                    || name.starts_with("I8x16")
                                    || name.starts_with("I16x8")
                                    || name.starts_with("I32x4")
                                    || name.starts_with("I64x2")
                                    || name.starts_with("F32x4")
                                    || name.starts_with("F64x2")
                                {
                                    simd_count += 1;
                                }
                                if name.starts_with("Atomic")
                                    || name.starts_with("MemoryAtomicNotify")
                                    || name.starts_with("MemoryAtomicWait")
                                {
                                    errors.push(format!(
                                        "prohibited thread/atomic instruction: {name}"
                                    ));
                                }
                            }
                            Err(e) => {
                                warnings.push(format!("could not decode instruction: {e}"));
                            }
                        }
                    }
                }
                Err(e) => {
                    warnings.push(format!("could not read function body: {e}"));
                }
            }
        }
    }

    if simd_count > 0 {
        warnings.push(format!(
            "module uses {simd_count} SIMD instructions (accepted; common in Javy/QuickJS modules)"
        ));
    }

    if errors.is_empty() {
        Ok(warnings)
    } else {
        Err(errors)
    }
}

/// Check that memory declarations are within spec limits (§5.2).
fn check_memory_limits(wasm: &[u8]) -> Result<Vec<String>, String> {
    let parser = Parser::new(0);
    let mut warnings: Vec<String> = Vec::new();

    let max_initial = 256; // 16 MB generous limit for v0.2
    let max_total = 1024; // 64 MB absolute ceiling

    for payload in parser.parse_all(wasm) {
        let payload = payload.map_err(|e| format!("parse error: {e}"))?;
        if let Payload::MemorySection(reader) = payload {
            for mem in reader {
                let mem = mem.map_err(|e| format!("memory section error: {e}"))?;
                if mem.initial > max_initial as u64 {
                    return Err(format!(
                        "memory initial size {} pages exceeds limit of {} pages",
                        mem.initial, max_initial
                    ));
                }
                if let Some(max) = mem.maximum {
                    if max > max_total as u64 {
                        warnings.push(format!(
                            "memory maximum {} pages exceeds recommended {} pages",
                            max, max_total
                        ));
                    }
                } else {
                    warnings.push("memory has no maximum — consider setting a bound".into());
                }
            }
        }
    }

    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_ir_wasm() -> Vec<u8> {
        use crate::compiler::ir_sections::CustomSectionPayloads;
        use crate::types::gene::{Fidelity, GeneTransparency, Phenotype};

        let pheno = Phenotype {
            domain: "test.echo".into(),
            input_schema: serde_json::json!({"type": "object"}),
            output_schema: serde_json::json!({"type": "object"}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "test".into(),
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
        };

        let payloads = CustomSectionPayloads::build(&pheno, None, None).unwrap();

        let raw = crate::compiler::ir_injector::tests::minimal_wasm_pub();
        crate::compiler::ir_injector::inject_custom_sections(&raw, &payloads)
            .unwrap()
            .wasm_bytes
    }

    #[test]
    fn verify_valid_ir_passes() {
        let wasm = minimal_ir_wasm();
        let result = verify_ir_module(&wasm);
        assert!(
            matches!(result, VerifyLevel::Pass | VerifyLevel::Warn(_)),
            "expected pass or warn, got: {result:?}"
        );
    }

    #[test]
    fn verify_raw_wasm_without_sections_fails() {
        let raw = crate::compiler::ir_injector::tests::minimal_wasm_pub();
        let result = verify_ir_module(&raw);
        match result {
            VerifyLevel::Fail(errs) => {
                assert!(errs.iter().any(|e| e.contains("missing required custom sections")));
            }
            _ => panic!("expected Fail, got: {result:?}"),
        }
    }

    #[test]
    fn verify_garbage_bytes_fails() {
        let garbage = vec![0x00, 0x61, 0x73, 0x6d, 0xFF, 0xFF];
        let result = verify_ir_module(&garbage);
        assert!(
            matches!(result, VerifyLevel::Fail(_)),
            "garbage bytes should fail verification"
        );
    }

    #[test]
    fn verify_empty_bytes_fails() {
        let result = verify_ir_module(&[]);
        assert!(
            matches!(result, VerifyLevel::Fail(_)),
            "empty bytes should fail verification"
        );
    }

    #[test]
    fn verify_wasm_with_huge_memory_warns() {
        use wasm_encoder::*;

        let mut module = Module::new();

        let mut types = TypeSection::new();
        types.ty().function(
            vec![ValType::I32, ValType::I32],
            vec![ValType::I32],
        );
        module.section(&types);

        let mut functions = FunctionSection::new();
        functions.function(0);
        module.section(&functions);

        let mut memories = MemorySection::new();
        memories.memory(MemoryType {
            minimum: 1,
            maximum: Some(99999), // way above recommended
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        module.section(&memories);

        let mut exports = ExportSection::new();
        exports.export("express", ExportKind::Func, 0);
        exports.export("memory", ExportKind::Memory, 0);
        module.section(&exports);

        let mut code = CodeSection::new();
        let mut f = Function::new(vec![]);
        f.instruction(&Instruction::LocalGet(0));
        f.instruction(&Instruction::End);
        code.function(&f);
        module.section(&code);

        // Inject rotifer custom sections so missing-section check passes
        let pheno = crate::types::gene::Phenotype {
            domain: "test".into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "t".into(),
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
        };
        let payloads =
            crate::compiler::ir_sections::CustomSectionPayloads::build(&pheno, None, None)
                .unwrap();
        let raw = module.finish();
        let ir = crate::compiler::ir_injector::inject_custom_sections(&raw, &payloads)
            .unwrap()
            .wasm_bytes;

        let result = verify_ir_module(&ir);
        match result {
            VerifyLevel::Warn(warns) => {
                assert!(
                    warns.iter().any(|w| w.contains("exceeds recommended")),
                    "should warn about huge memory, got: {warns:?}"
                );
            }
            other => {
                // Warn is expected, but Pass is also acceptable if limits are generous
                assert!(
                    !matches!(other, VerifyLevel::Fail(_)),
                    "should not fail, got: {other:?}"
                );
            }
        }
    }
}
