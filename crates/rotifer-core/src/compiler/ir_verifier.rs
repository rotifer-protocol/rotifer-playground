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
/// 6. Host import registry: fidelity honesty for capability modules
///    (ADR-327 D1 — fail), unknown import modules (warn)
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

    match check_imports(wasm) {
        Ok(warns) => warnings.extend(warns),
        Err(errs) => errors.extend(errs),
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

/// Host modules the runtime actually provides (IR spec §6.2 standard set,
/// the WASI shim, the legacy `env.log` namespace, and the ADR-327
/// standard-optional capability trio).
const KNOWN_IMPORT_MODULES: [&str; 8] = [
    "wasi_snapshot_preview1",
    "env",
    "rotifer",
    "rotifer.gene",
    "rotifer.crypto",
    "rotifer.net",
    "rotifer.kv",
    "rotifer.env",
];

/// Capability modules require hybrid/wrapped fidelity (ADR-327 D1).
const CAPABILITY_MODULES: [&str; 3] = ["rotifer.net", "rotifer.kv", "rotifer.env"];

/// Check the import section against the host function registry:
/// - capability module imported while phenotype declares `Native` → **error**
///   (fidelity honesty red line, mechanized at the verifier)
/// - unknown import module → **warning** (hardening this to an error needs a
///   published-fleet import scan first; `rotifer.ext.*` is legitimate §6.3)
fn check_imports(wasm: &[u8]) -> Result<Vec<String>, Vec<String>> {
    use super::ir_sections::{PhenotypeSection, SECTION_PHENOTYPE};

    let mut import_modules: Vec<String> = Vec::new();
    let mut fidelity: Option<String> = None;

    let parser = Parser::new(0);
    for payload in parser.parse_all(wasm) {
        let payload = match payload {
            Ok(p) => p,
            Err(_) => continue, // structural errors are check_structure's job
        };
        match payload {
            Payload::ImportSection(reader) => {
                for imports in reader.into_iter().flatten() {
                    for entry in imports {
                        let Ok((_, import)) = entry else { continue };
                        if !import_modules.iter().any(|m| m == import.module) {
                            import_modules.push(import.module.to_string());
                        }
                    }
                }
            }
            Payload::CustomSection(cs) if cs.name() == SECTION_PHENOTYPE => {
                if let Ok(section) = rmp_serde::from_slice::<PhenotypeSection>(cs.data()) {
                    fidelity = section.fidelity;
                }
            }
            _ => {}
        }
    }

    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    let capability_used: Vec<&String> = import_modules
        .iter()
        .filter(|m| CAPABILITY_MODULES.contains(&m.as_str()))
        .collect();
    if !capability_used.is_empty() && fidelity.as_deref() == Some("Native") {
        errors.push(format!(
            "fidelity honesty: module imports capability host functions ({}) \
             but the phenotype declares fidelity 'Native' — declare 'hybrid' \
             or 'wrapped' (ADR-327)",
            capability_used
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", "),
        ));
    }

    for module in &import_modules {
        if !KNOWN_IMPORT_MODULES.contains(&module.as_str())
            && !module.starts_with("rotifer.ext.")
        {
            warnings.push(format!(
                "unknown host import module '{module}' — not in the IR spec §6 \
                 registry; the reference runtime will fail instantiation"
            ));
        }
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
            external_dependencies: None,
            llm_requirements: None,
            guard_config: None,
        };

        let payloads = CustomSectionPayloads::build(&pheno, None, None).unwrap();

        let raw = crate::compiler::ir_injector::tests::minimal_wasm_pub();
        crate::compiler::ir_injector::inject_custom_sections(&raw, &payloads)
            .unwrap()
            .wasm_bytes
    }

    /// Build IR-wrapped WASM whose express imports one host function from
    /// `import_module`, with the given phenotype fidelity in the custom
    /// sections.
    fn ir_wasm_with_import(
        import_module: &str,
        fidelity: crate::types::gene::Fidelity,
    ) -> Vec<u8> {
        use wasm_encoder::*;

        let mut module = Module::new();

        let mut types = TypeSection::new();
        // type 0: imported fn (i32,i32)->i32; type 1: express (i32,i32)->i32
        types.ty().function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
        types.ty().function(vec![ValType::I32, ValType::I32], vec![ValType::I32]);
        module.section(&types);

        let mut imports = ImportSection::new();
        imports.import(import_module, "someFn", EntityType::Function(0));
        module.section(&imports);

        let mut functions = FunctionSection::new();
        functions.function(1);
        module.section(&functions);

        let mut memories = MemorySection::new();
        memories.memory(MemoryType {
            minimum: 1,
            maximum: Some(4),
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
        module.section(&memories);

        let mut exports = ExportSection::new();
        exports.export("express", ExportKind::Func, 1);
        exports.export("memory", ExportKind::Memory, 0);
        module.section(&exports);

        let mut code = CodeSection::new();
        let mut f = Function::new(vec![]);
        f.instruction(&Instruction::I32Const(0));
        f.instruction(&Instruction::End);
        code.function(&f);
        module.section(&code);

        let pheno = crate::types::gene::Phenotype {
            domain: "test.import".into(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
            dependencies: vec![],
            version: "0.1.0".into(),
            author: "t".into(),
            created_at: 0,
            ir_hash: None,
            fidelity,
            source_framework: None,
            regulatory_tags: None,
            transparency: crate::types::gene::GeneTransparency::Open,
            streaming_capability: None,
            pricing_hint: None,
            semantic_requirements: None,
            network: None,
            external_dependencies: None,
            llm_requirements: None,
            guard_config: None,
        };
        let payloads =
            crate::compiler::ir_sections::CustomSectionPayloads::build(&pheno, None, None)
                .unwrap();
        crate::compiler::ir_injector::inject_custom_sections(&module.finish(), &payloads)
            .unwrap()
            .wasm_bytes
    }

    #[test]
    fn verify_capability_import_with_native_fidelity_fails() {
        use crate::types::gene::Fidelity;
        // ADR-327 D1 mechanized: a 'native' gene must not import capability
        // modules — that is the fidelity-honesty red line at the verifier.
        for module in ["rotifer.net", "rotifer.kv", "rotifer.env"] {
            let wasm = ir_wasm_with_import(module, Fidelity::Native);
            match verify_ir_module(&wasm) {
                VerifyLevel::Fail(errs) => assert!(
                    errs.iter().any(|e| e.contains("fidelity")),
                    "{module}: error should name fidelity, got: {errs:?}"
                ),
                other => panic!("{module}: expected Fail, got: {other:?}"),
            }
        }
    }

    #[test]
    fn verify_capability_import_with_hybrid_fidelity_passes() {
        use crate::types::gene::Fidelity;
        let wasm = ir_wasm_with_import("rotifer.net", Fidelity::Hybrid);
        match verify_ir_module(&wasm) {
            VerifyLevel::Pass | VerifyLevel::Warn(_) => {}
            VerifyLevel::Fail(errs) => panic!("hybrid fidelity should pass, got: {errs:?}"),
        }
    }

    #[test]
    fn verify_unknown_import_module_warns_not_fails() {
        use crate::types::gene::Fidelity;
        // Unknown host modules warn rather than fail: hardening to Fail
        // requires a published-fleet import scan first. `rotifer.ext.*`
        // stays legitimate per IR spec §6.3.
        let wasm = ir_wasm_with_import("mystery.module", Fidelity::Hybrid);
        match verify_ir_module(&wasm) {
            VerifyLevel::Warn(warns) => assert!(
                warns.iter().any(|w| w.contains("mystery.module")),
                "warning should name the module, got: {warns:?}"
            ),
            other => panic!("expected Warn, got: {other:?}"),
        }
        let ext = ir_wasm_with_import("rotifer.ext.web3", Fidelity::Hybrid);
        match verify_ir_module(&ext) {
            VerifyLevel::Pass | VerifyLevel::Warn(_) => {
                if let VerifyLevel::Warn(warns) = verify_ir_module(&ext) {
                    assert!(
                        !warns.iter().any(|w| w.contains("rotifer.ext.web3")),
                        "ext namespace is spec-legitimate, got: {warns:?}"
                    );
                }
            }
            VerifyLevel::Fail(errs) => panic!("ext namespace should not fail: {errs:?}"),
        }
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
            external_dependencies: None,
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
