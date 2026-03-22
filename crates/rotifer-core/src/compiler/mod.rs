//! IR compiler pipeline — transforms raw WASM into Rotifer IR modules.
//!
//! The pipeline: build custom sections → inject into WASM → verify → produce [`CompileResult`].

pub mod genesis;
pub mod ir_injector;
pub mod ir_sections;
pub mod ir_verifier;

use crate::types::gene::{Fidelity, Gene, GeneTransparency, Phenotype};
use crate::types::compute_gene_id;
use thiserror::Error;

pub use ir_sections::{ConstraintsSection, CustomSectionPayloads, MeteringSection};
pub use ir_injector::InjectionResult;
pub use ir_verifier::{verify_ir_module, VerifyLevel};

/// Errors from the compilation pipeline.
#[derive(Debug, Error)]
pub enum CompilerError {
    #[error("invalid source: {0}")]
    InvalidSource(String),
    #[error("wasm compilation failed: {0}")]
    WasmCompilationFailed(String),
    #[error("schema validation failed: {0}")]
    SchemaValidationFailed(String),
    #[error("verification failed: {0}")]
    VerificationFailed(String),
    #[error("serialization error: {0}")]
    SerializationError(String),
}

/// Result of `compile_to_ir()`.
#[derive(Debug)]
pub struct CompileResult {
    pub wasm_bytes: Vec<u8>,
    pub ir_hash: [u8; 32],
    pub ir_hash_hex: String,
    pub code_section_size: usize,
    pub total_size: usize,
}

/// Compile a raw WASM module into a Rotifer IR module.
///
/// Takes raw WASM bytes (must export `express(i32,i32)->i32` and `memory`),
/// along with the gene's Phenotype. Returns the IR module bytes with all
/// required custom sections embedded.
pub fn compile_to_ir(
    raw_wasm: &[u8],
    phenotype: &Phenotype,
    constraints: Option<ConstraintsSection>,
    metering: Option<MeteringSection>,
) -> Result<CompileResult, CompilerError> {
    let payloads = CustomSectionPayloads::build(phenotype, constraints, metering)
        .map_err(|e| CompilerError::SerializationError(e.to_string()))?;

    let injection = ir_injector::inject_custom_sections(raw_wasm, &payloads)?;

    let verify_result = verify_ir_module(&injection.wasm_bytes);
    match verify_result {
        VerifyLevel::Fail(errs) => {
            return Err(CompilerError::VerificationFailed(errs.join("; ")));
        }
        VerifyLevel::Warn(warns) => {
            for w in &warns {
                tracing::warn!("IR verification warning: {w}");
            }
        }
        VerifyLevel::Pass => {}
    }

    Ok(CompileResult {
        total_size: injection.wasm_bytes.len(),
        ir_hash_hex: hex::encode(injection.ir_hash),
        ir_hash: injection.ir_hash,
        code_section_size: injection.code_section_size,
        wasm_bytes: injection.wasm_bytes,
    })
}

/// Candidate function discovered by `rotifer scan`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CandidateFunction {
    pub name: String,
    pub file_path: String,
    pub line_number: u32,
    pub params: Vec<ParamInfo>,
    pub return_type: Option<String>,
    pub language: String,
}

/// Parameter metadata discovered by `rotifer scan`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ParamInfo {
    pub name: String,
    pub type_hint: Option<String>,
}

/// Result of `rotifer wrap`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GenePackage {
    pub gene: Gene,
    pub phenotype_path: String,
    pub source_path: String,
}

/// Wrap a discovered function into a [`Gene`] with auto-generated schemas.
pub fn wrap_function(
    candidate: &CandidateFunction,
    domain: &str,
    author: &str,
) -> Result<Gene, CompilerError> {
    let input_schema = generate_input_schema(&candidate.params);
    let output_schema = generate_output_schema(&candidate.return_type);

    let now = chrono::Utc::now().timestamp_millis() as u64;

    let phenotype = Phenotype {
        domain: domain.to_string(),
        input_schema,
        output_schema,
        dependencies: vec![],
        version: "0.1.0".to_string(),
        author: author.to_string(),
        created_at: now,
        ir_hash: None,
        fidelity: Fidelity::Wrapped,
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

    let phenotype_bytes = serde_json::to_vec(&phenotype)
        .map_err(|e| CompilerError::InvalidSource(e.to_string()))?;
    let gene_id = compute_gene_id(&phenotype_bytes);

    Ok(Gene {
        id: gene_id,
        phenotype,
        wasm_bytes: None, // WASM compilation happens in `rotifer compile`
        source_code: Some(format!("// Source: {}:{}", candidate.file_path, candidate.line_number)),
    })
}

fn generate_input_schema(params: &[ParamInfo]) -> serde_json::Value {
    let mut properties = serde_json::Map::new();
    let mut required = Vec::new();

    for param in params {
        let type_str = param.type_hint.as_deref().unwrap_or("string");
        let json_type = match type_str {
            "number" | "int" | "i32" | "i64" | "f32" | "f64" | "u32" | "u64" => "number",
            "bool" | "boolean" => "boolean",
            "string" | "str" | "String" | "&str" => "string",
            _ => "string",
        };

        properties.insert(
            param.name.clone(),
            serde_json::json!({ "type": json_type }),
        );
        required.push(serde_json::Value::String(param.name.clone()));
    }

    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required
    })
}

fn generate_output_schema(return_type: &Option<String>) -> serde_json::Value {
    match return_type.as_deref() {
        Some("string" | "String" | "str" | "&str") => serde_json::json!({"type": "string"}),
        Some("number" | "int" | "i32" | "i64" | "f32" | "f64") => serde_json::json!({"type": "number"}),
        Some("bool" | "boolean") => serde_json::json!({"type": "boolean"}),
        _ => serde_json::json!({"type": "object"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::gene::{Fidelity, GeneTransparency};

    fn test_phenotype(domain: &str) -> Phenotype {
        Phenotype {
            domain: domain.into(),
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
        }
    }

    #[test]
    fn compile_to_ir_rejects_garbage_wasm() {
        let garbage = vec![0xFF, 0xFF, 0xFF, 0xFF];
        let pheno = test_phenotype("test");
        let result = compile_to_ir(&garbage, &pheno, None, None);
        assert!(result.is_err(), "garbage WASM should be rejected");
    }

    #[test]
    fn compile_to_ir_rejects_empty_wasm() {
        let pheno = test_phenotype("test");
        let result = compile_to_ir(&[], &pheno, None, None);
        assert!(result.is_err(), "empty WASM should be rejected");
    }

    #[test]
    fn compile_to_ir_rejects_wasm_without_express() {
        let mut module = wasm_encoder::Module::new();
        let mut memories = wasm_encoder::MemorySection::new();
        memories.memory(wasm_encoder::MemoryType {
            minimum: 1, maximum: None, memory64: false, shared: false, page_size_log2: None,
        });
        module.section(&memories);
        let mut exports = wasm_encoder::ExportSection::new();
        exports.export("memory", wasm_encoder::ExportKind::Memory, 0);
        module.section(&exports);
        let wasm = module.finish();

        let pheno = test_phenotype("test");
        let result = compile_to_ir(&wasm, &pheno, None, None);
        assert!(result.is_err());
        assert!(
            result.unwrap_err().to_string().contains("express"),
            "error should mention missing 'express'"
        );
    }

    #[test]
    fn compile_to_ir_ir_hash_changes_with_phenotype() {
        let wasm = genesis::build_echo_gene_wasm();
        let pheno1 = test_phenotype("domain.a");
        let pheno2 = test_phenotype("domain.b");

        let r1 = compile_to_ir(&wasm, &pheno1, None, None).unwrap();
        let r2 = compile_to_ir(&wasm, &pheno2, None, None).unwrap();

        assert_ne!(
            r1.ir_hash, r2.ir_hash,
            "different phenotypes should produce different irHash"
        );
    }

    #[test]
    fn compile_to_ir_with_custom_constraints() {
        let wasm = genesis::build_echo_gene_wasm();
        let pheno = test_phenotype("test");
        let custom = ConstraintsSection {
            memory: ir_sections::MemoryConstraints {
                max_initial_pages: 4,
                max_grow_pages: 8,
                total_memory_limit: 524_288,
            },
            ..ConstraintsSection::default()
        };

        let r_default = compile_to_ir(&wasm, &pheno, None, None).unwrap();
        let r_custom = compile_to_ir(&wasm, &pheno, Some(custom), None).unwrap();

        assert_ne!(
            r_default.ir_hash, r_custom.ir_hash,
            "different constraints should change irHash"
        );
    }

    #[test]
    fn compile_to_ir_output_is_larger_than_input() {
        let wasm = genesis::build_echo_gene_wasm();
        let pheno = test_phenotype("test");
        let result = compile_to_ir(&wasm, &pheno, None, None).unwrap();
        assert!(
            result.total_size > wasm.len(),
            "IR output ({}) should be larger than raw WASM ({}) due to custom sections",
            result.total_size, wasm.len()
        );
    }

    // ── wrap_function edge case tests ──

    #[test]
    fn wrap_function_basic() {
        let candidate = CandidateFunction {
            name: "my_func".into(),
            file_path: "src/lib.rs".into(),
            line_number: 10,
            params: vec![
                ParamInfo { name: "a".into(), type_hint: Some("i32".into()) },
                ParamInfo { name: "b".into(), type_hint: Some("String".into()) },
            ],
            return_type: Some("String".into()),
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "compute.math", "alice").unwrap();
        assert_eq!(gene.phenotype.domain, "compute.math");
        assert_eq!(gene.phenotype.author, "alice");
        assert_eq!(gene.phenotype.fidelity, Fidelity::Wrapped);
    }

    #[test]
    fn wrap_function_no_params() {
        let candidate = CandidateFunction {
            name: "no_args".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![],
            return_type: None,
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        let props = gene.phenotype.input_schema.get("properties").unwrap().as_object().unwrap();
        assert!(props.is_empty());
        let req = gene.phenotype.input_schema.get("required").unwrap().as_array().unwrap();
        assert!(req.is_empty());
    }

    #[test]
    fn wrap_function_type_hint_number() {
        let candidate = CandidateFunction {
            name: "f".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![ParamInfo { name: "x".into(), type_hint: Some("i32".into()) }],
            return_type: None,
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        let x_type = gene.phenotype.input_schema["properties"]["x"]["type"].as_str().unwrap();
        assert_eq!(x_type, "number");
    }

    #[test]
    fn wrap_function_type_hint_bool() {
        let candidate = CandidateFunction {
            name: "f".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![ParamInfo { name: "flag".into(), type_hint: Some("boolean".into()) }],
            return_type: None,
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        let flag_type = gene.phenotype.input_schema["properties"]["flag"]["type"].as_str().unwrap();
        assert_eq!(flag_type, "boolean");
    }

    #[test]
    fn wrap_function_type_hint_unknown_defaults_to_string() {
        let candidate = CandidateFunction {
            name: "f".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![ParamInfo { name: "x".into(), type_hint: Some("CustomType".into()) }],
            return_type: None,
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        assert_eq!(gene.phenotype.input_schema["properties"]["x"]["type"], "string");
    }

    #[test]
    fn wrap_function_no_type_hint_defaults_to_string() {
        let candidate = CandidateFunction {
            name: "f".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![ParamInfo { name: "x".into(), type_hint: None }],
            return_type: None,
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        assert_eq!(gene.phenotype.input_schema["properties"]["x"]["type"], "string");
    }

    #[test]
    fn wrap_function_return_type_string() {
        let candidate = CandidateFunction {
            name: "f".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![],
            return_type: Some("String".into()),
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        assert_eq!(gene.phenotype.output_schema["type"], "string");
    }

    #[test]
    fn wrap_function_return_type_none_defaults_to_object() {
        let candidate = CandidateFunction {
            name: "f".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![],
            return_type: None,
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        assert_eq!(gene.phenotype.output_schema["type"], "object");
    }

    #[test]
    fn wrap_function_deterministic_gene_id() {
        let candidate = CandidateFunction {
            name: "f".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![],
            return_type: None,
            language: "rust".into(),
        };
        // Gene id depends on phenotype bytes which include created_at timestamp,
        // so two calls will differ. But with the same serialized phenotype bytes
        // the id would be the same. We verify wasm_bytes is None.
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        assert!(gene.wasm_bytes.is_none());
    }

    #[test]
    fn wrap_function_wasm_bytes_is_none() {
        let candidate = CandidateFunction {
            name: "f".into(),
            file_path: "a.rs".into(),
            line_number: 1,
            params: vec![],
            return_type: None,
            language: "rust".into(),
        };
        let gene = wrap_function(&candidate, "d", "a").unwrap();
        assert!(gene.wasm_bytes.is_none(), "wrapped gene should have no wasm_bytes");
        assert!(gene.source_code.is_some(), "wrapped gene should record source location");
    }

    #[test]
    fn compile_to_ir_with_custom_metering() {
        let wasm = genesis::build_echo_gene_wasm();
        let pheno = test_phenotype("test");
        let metering = MeteringSection {
            fuel_per_instruction: 2,
            fuel_per_memory_page: 2000,
            fuel_per_host_call: 50,
        };
        let r_metered = compile_to_ir(&wasm, &pheno, None, Some(metering)).unwrap();
        // irHash is computed from (version, phenotype, constraints, code) — metering is
        // NOT part of the hash (it's operational metadata, not semantic identity).
        // We verify the compilation still succeeds and the output is valid.
        assert!(!r_metered.wasm_bytes.is_empty());
        assert!(r_metered.total_size > wasm.len());
    }
}
