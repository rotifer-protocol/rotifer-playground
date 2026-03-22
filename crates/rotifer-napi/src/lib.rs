#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::*;
use rotifer_core::arena::{ArenaEngine, ArenaEntry, LocalArena};
use rotifer_core::compiler::{self, CandidateFunction};
use rotifer_core::fitness;
use rotifer_core::l0::{L0Gate, AuditLog};
use rotifer_core::sandbox::{ConstraintSet, WasmtimeSandbox};
use rotifer_core::types::{Context, GeneResult, PermissionSet};

use rotifer_core::storage::{AgentStore, ArenaStore, GeneStore, SqliteStore};
use rotifer_core::types::agent::Agent;
use rotifer_core::types::gene::Gene;
use std::path::PathBuf;
use std::sync::Mutex;

#[napi(object)]
pub struct CandidateFunctionView {
    pub name: String,
    pub file_path: String,
    pub line_number: u32,
    pub params: Vec<ParamInfoView>,
    pub return_type: Option<String>,
    pub language: String,
}

#[napi(object)]
pub struct ParamInfoView {
    pub name: String,
    pub type_hint: Option<String>,
}

#[napi(object)]
pub struct GeneView {
    pub id: String,
    pub domain: String,
    pub version: String,
    pub fidelity: String,
    pub author: String,
}

#[napi(object)]
pub struct ArenaEntryView {
    pub gene_id: String,
    pub domain: String,
    pub fitness: f64,
    pub safety_score: f64,
    pub rank: u32,
}

#[napi(object)]
pub struct AgentView {
    pub id: String,
    pub name: String,
    pub state: String,
    pub genome_count: u32,
}

#[napi(object)]
pub struct FitnessView {
    pub value: f64,
    pub safety_score: f64,
    pub success_rate: f64,
    pub latency_score: f64,
    pub resource_efficiency: f64,
    pub passes_admission: bool,
}

#[napi(object)]
pub struct TestReport {
    pub gene_id: String,
    pub passed: u32,
    pub failed: u32,
    pub total: u32,
    pub fitness: FitnessView,
}

#[napi(object)]
pub struct CompileResultView {
    pub ir_hash: String,
    pub total_size: i64,
    pub code_section_size: i64,
    pub wasm_available: bool,
}

#[napi(object)]
pub struct ExecutionResultView {
    pub success: bool,
    pub output: serde_json::Value,
    pub error_message: Option<String>,
    pub fuel_consumed: i64,
    pub memory_peak_kb: i64,
    pub duration_ms: i64,
    pub sandbox_type: String,
}

#[napi(object)]
pub struct L0CheckResultView {
    pub passed: bool,
    pub violations: Vec<String>,
    pub checks_performed: u32,
}

#[napi(object)]
pub struct AlgebraResultView {
    pub success: bool,
    pub output: serde_json::Value,
    pub error_message: Option<String>,
    pub steps_executed: u32,
    pub total_fuel_consumed: i64,
    pub total_duration_ms: i64,
}

#[napi]
pub struct PlaygroundBinding {
    project_dir: PathBuf,
    store: SqliteStore,
    arena: Mutex<LocalArena>,
}

#[napi]
impl PlaygroundBinding {
    #[napi(constructor)]
    pub fn new(project_dir: String) -> Result<Self> {
        let project_path = PathBuf::from(&project_dir);
        let db_path = project_path.join(".rotifer").join("playground.db");

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::from_reason(format!("failed to create db dir: {e}")))?;
        }

        let store = SqliteStore::new(&db_path)
            .map_err(|e| Error::from_reason(format!("failed to init storage: {e}")))?;

        Ok(Self {
            project_dir: project_path,
            store,
            arena: Mutex::new(LocalArena::new()),
        })
    }

    #[napi]
    pub fn scan_functions(&self, source_path: String) -> Result<Vec<CandidateFunctionView>> {
        let path = self.project_dir.join(&source_path);
        let content = std::fs::read_to_string(&path)
            .map_err(|e| Error::from_reason(format!("failed to read {source_path}: {e}")))?;

        let candidates = scan_source_file(&content, &source_path);

        Ok(candidates
            .into_iter()
            .map(|c| CandidateFunctionView {
                name: c.name,
                file_path: c.file_path,
                line_number: c.line_number,
                params: c
                    .params
                    .into_iter()
                    .map(|p| ParamInfoView {
                        name: p.name,
                        type_hint: p.type_hint,
                    })
                    .collect(),
                return_type: c.return_type,
                language: c.language,
            })
            .collect())
    }

    #[napi]
    pub fn wrap_gene(&self, name: String, domain: String, file_path: String) -> Result<GeneView> {
        let candidate = CandidateFunction {
            name: name.clone(),
            file_path,
            line_number: 0,
            params: vec![],
            return_type: None,
            language: "typescript".to_string(),
        };

        let gene = compiler::wrap_function(&candidate, &domain, "local-dev")
            .map_err(|e| Error::from_reason(format!("wrap failed: {e}")))?;

        self.store
            .save_gene(&gene)
            .map_err(|e| Error::from_reason(format!("save failed: {e}")))?;

        Ok(gene_to_view(&gene))
    }

    #[napi]
    pub fn list_genes(&self, domain: Option<String>) -> Result<Vec<GeneView>> {
        let genes = self
            .store
            .list_genes(domain.as_deref())
            .map_err(|e| Error::from_reason(format!("list failed: {e}")))?;

        Ok(genes.iter().map(gene_to_view).collect())
    }

    #[napi]
    pub fn arena_submit(&self, gene_id: String) -> Result<ArenaEntryView> {
        let id = hex_to_gene_id(&gene_id)?;
        let gene = self
            .store
            .get_gene(&id)
            .map_err(|e| Error::from_reason(format!("storage error: {e}")))?
            .ok_or_else(|| Error::from_reason(format!("gene not found: {gene_id}")))?;

        let eval_results = vec![
            fitness::EvaluationResult {
                success: true,
                latency_ms: 100,
                resource_cost: 500.0,
                coverage: None,
                robustness: None,
            },
            fitness::EvaluationResult {
                success: true,
                latency_ms: 120,
                resource_cost: 600.0,
                coverage: None,
                robustness: None,
            },
        ];
        let score = fitness::compute_fitness(&eval_results);

        let mut arena = self.arena.lock().unwrap();
        let entry = arena
            .submit(&gene, score)
            .map_err(|e| Error::from_reason(format!("arena error: {e}")))?;

        self.store
            .save_entry(&entry)
            .map_err(|e| Error::from_reason(format!("save arena entry failed: {e}")))?;

        Ok(arena_entry_to_view(&entry))
    }

    #[napi]
    pub fn arena_list(&self, domain: Option<String>) -> Result<Vec<ArenaEntryView>> {
        let arena = self.arena.lock().unwrap();
        let entries = match domain {
            Some(d) => arena.rank(&d),
            None => arena.all_entries().into_iter().cloned().collect(),
        };

        Ok(entries.iter().map(arena_entry_to_view).collect())
    }

    #[napi]
    pub fn agent_create(&self, name: String, genome: Vec<String>) -> Result<AgentView> {
        let mut agent = Agent::new(name);

        for gene_hex in &genome {
            let id = hex_to_gene_id(gene_hex)?;
            agent.genome.push(id);
        }

        agent.activate();

        self.store
            .save_agent(&agent)
            .map_err(|e| Error::from_reason(format!("save agent failed: {e}")))?;

        Ok(agent_to_view(&agent))
    }

    #[napi]
    pub fn compile_gene(&self, wasm_bytes: Buffer, phenotype_json: String) -> Result<CompileResultView> {
        let phenotype: rotifer_core::types::gene::Phenotype = serde_json::from_str(&phenotype_json)
            .map_err(|e| Error::from_reason(format!("invalid phenotype JSON: {e}")))?;

        let result = compiler::compile_to_ir(&wasm_bytes, &phenotype, None, None)
            .map_err(|e| Error::from_reason(format!("compilation failed: {e}")))?;

        Ok(CompileResultView {
            ir_hash: result.ir_hash_hex,
            total_size: result.total_size as i64,
            code_section_size: result.code_section_size as i64,
            wasm_available: true,
        })
    }

    #[napi]
    pub fn compile_gene_to_file(
        &self,
        wasm_bytes: Buffer,
        phenotype_json: String,
        output_path: String,
    ) -> Result<CompileResultView> {
        let phenotype: rotifer_core::types::gene::Phenotype = serde_json::from_str(&phenotype_json)
            .map_err(|e| Error::from_reason(format!("invalid phenotype JSON: {e}")))?;

        let result = compiler::compile_to_ir(&wasm_bytes, &phenotype, None, None)
            .map_err(|e| Error::from_reason(format!("compilation failed: {e}")))?;

        std::fs::write(&output_path, &result.wasm_bytes)
            .map_err(|e| Error::from_reason(format!("failed to write output: {e}")))?;

        Ok(CompileResultView {
            ir_hash: result.ir_hash_hex,
            total_size: result.total_size as i64,
            code_section_size: result.code_section_size as i64,
            wasm_available: true,
        })
    }

    #[napi]
    pub fn build_echo_gene_wasm(&self) -> Buffer {
        let wasm = compiler::genesis::build_echo_gene_wasm();
        Buffer::from(wasm)
    }

    #[napi]
    pub fn build_search_gene_wasm(&self) -> Buffer {
        let wasm = compiler::genesis::build_search_gene_wasm();
        Buffer::from(wasm)
    }

    #[napi]
    pub fn build_summarize_gene_wasm(&self) -> Buffer {
        let wasm = compiler::genesis::build_summarize_gene_wasm();
        Buffer::from(wasm)
    }

    #[napi]
    pub fn build_translate_gene_wasm(&self) -> Buffer {
        let wasm = compiler::genesis::build_translate_gene_wasm();
        Buffer::from(wasm)
    }

    #[napi]
    pub fn verify_ir_module(&self, wasm_bytes: Buffer) -> Result<String> {
        let result = compiler::verify_ir_module(&wasm_bytes);
        match result {
            compiler::VerifyLevel::Pass => Ok("PASS".to_string()),
            compiler::VerifyLevel::Warn(warns) => Ok(format!("WARN: {}", warns.join("; "))),
            compiler::VerifyLevel::Fail(errs) => Ok(format!("FAIL: {}", errs.join("; "))),
        }
    }

    #[napi]
    pub fn agent_list(&self) -> Result<Vec<AgentView>> {
        let agents = self
            .store
            .list_agents()
            .map_err(|e| Error::from_reason(format!("list agents failed: {e}")))?;

        Ok(agents.iter().map(agent_to_view).collect())
    }

    /// Execute a gene's WASM bytes in the sandbox with L0 gate enforcement.
    #[napi]
    pub fn execute_gene(
        &self,
        wasm_bytes: Buffer,
        input_json: String,
        phenotype_json: String,
        constraints_json: Option<String>,
    ) -> Result<ExecutionResultView> {
        let input: serde_json::Value = serde_json::from_str(&input_json)
            .map_err(|e| Error::from_reason(format!("invalid input JSON: {e}")))?;

        let phenotype: rotifer_core::types::gene::Phenotype =
            serde_json::from_str(&phenotype_json)
                .map_err(|e| Error::from_reason(format!("invalid phenotype JSON: {e}")))?;

        let constraints = if let Some(cj) = constraints_json {
            serde_json::from_str::<ConstraintSet>(&cj)
                .unwrap_or_default()
        } else {
            ConstraintSet::default()
        };

        let context = Context {
            agent_id: "cli".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            permissions: PermissionSet::default(),
            trace_id: Some(uuid::Uuid::new_v4().to_string()),
            binding_extensions: None,
        };

        let sandbox = WasmtimeSandbox::new(constraints)
            .map_err(|e| Error::from_reason(format!("sandbox init failed: {e}")))?;

        let max_mem_kb = (sandbox.constraints().max_memory_bytes / 1024) as i64;
        let gene_id_short = context.trace_id.as_deref().unwrap_or("unknown");
        let audit_path = self.project_dir.join("audit.jsonl");
        let audit = AuditLog::new(&audit_path).ok();

        // L0 pre-check for audit logging
        let l0_result = L0Gate::check(&phenotype, &context.permissions, sandbox.constraints());
        if let Some(ref a) = audit {
            let _ = a.log_l0_check(gene_id_short, &phenotype.domain, &l0_result);
        }

        // L0 gate + sandbox execution via execute_gated()
        let result = sandbox.execute_gated(&wasm_bytes, &context, input, &phenotype);

        let view = match result {
            Ok(GeneResult::Success { data, metadata }) => {
                let fuel = metadata.resource_cost as i64;
                let duration = metadata.duration_ms as i64;
                let mem_estimate_kb = (max_mem_kb as f64
                    * (fuel as f64 / sandbox.constraints().max_fuel as f64).min(1.0))
                    as i64;

                if let Some(ref a) = audit {
                    let _ = a.log_execution(
                        gene_id_short,
                        &phenotype.domain,
                        "wasm",
                        fuel as u64,
                        mem_estimate_kb.max(1) as u64,
                        duration as u64,
                        true,
                    );
                }

                ExecutionResultView {
                    success: true,
                    output: data,
                    error_message: None,
                    fuel_consumed: fuel,
                    memory_peak_kb: mem_estimate_kb.max(1),
                    duration_ms: duration,
                    sandbox_type: "wasm".to_string(),
                }
            }
            Ok(GeneResult::Error {
                message, code, ..
            }) => {
                if let Some(ref a) = audit {
                    let _ = a.log_execution(
                        gene_id_short, &phenotype.domain,
                        "wasm", 0, 0, 0, false,
                    );
                }
                ExecutionResultView {
                    success: false,
                    output: serde_json::Value::Null,
                    error_message: Some(format!("{code}: {message}")),
                    fuel_consumed: 0,
                    memory_peak_kb: 0,
                    duration_ms: 0,
                    sandbox_type: "wasm".to_string(),
                }
            }
            Err(e) => {
                let err_msg = e.to_string();
                let sandbox_type = if err_msg.contains("L0 gate blocked") {
                    "blocked"
                } else {
                    "wasm"
                };
                if let Some(ref a) = audit {
                    let _ = a.log_execution(
                        gene_id_short, &phenotype.domain,
                        sandbox_type, 0, 0, 0, false,
                    );
                }
                ExecutionResultView {
                    success: false,
                    output: serde_json::Value::Null,
                    error_message: Some(err_msg),
                    fuel_consumed: 0,
                    memory_peak_kb: 0,
                    duration_ms: 0,
                    sandbox_type: sandbox_type.to_string(),
                }
            }
        };

        Ok(view)
    }

    /// Run L0 gate pre-execution checks without executing the gene.
    #[napi]
    pub fn l0_check(
        &self,
        phenotype_json: String,
        permissions_json: Option<String>,
        constraints_json: Option<String>,
    ) -> Result<L0CheckResultView> {
        let phenotype: rotifer_core::types::gene::Phenotype =
            serde_json::from_str(&phenotype_json)
                .map_err(|e| Error::from_reason(format!("invalid phenotype JSON: {e}")))?;

        let permissions = if let Some(pj) = permissions_json {
            serde_json::from_str::<PermissionSet>(&pj).unwrap_or_default()
        } else {
            PermissionSet::default()
        };

        let constraints = if let Some(cj) = constraints_json {
            serde_json::from_str::<ConstraintSet>(&cj).unwrap_or_default()
        } else {
            ConstraintSet::default()
        };

        let result = L0Gate::check(&phenotype, &permissions, &constraints);

        Ok(L0CheckResultView {
            passed: result.passed,
            violations: result.violations.iter().map(|v| v.to_string()).collect(),
            checks_performed: result.checks_performed,
        })
    }

    /// Execute a gene composition algebra expression via the Rust AlgebraExecutor.
    ///
    /// `gene_entries_json` maps hex-encoded gene IDs to `{ "wasm": [bytes], "phenotype": {...} }`.
    #[napi]
    pub fn execute_algebra(
        &self,
        algebra_json: String,
        gene_entries_json: String,
        input_json: String,
    ) -> Result<AlgebraResultView> {
        use rotifer_core::algebra::{AlgebraExpr, AlgebraExecutor};
        use std::collections::HashMap;

        let expr: AlgebraExpr = serde_json::from_str(&algebra_json)
            .map_err(|e| Error::from_reason(format!("invalid algebra JSON: {e}")))?;

        let input: serde_json::Value = serde_json::from_str(&input_json)
            .map_err(|e| Error::from_reason(format!("invalid input JSON: {e}")))?;

        #[derive(serde::Deserialize)]
        struct GeneEntry {
            wasm: Vec<u8>,
            phenotype: rotifer_core::types::gene::Phenotype,
        }

        let raw_map: HashMap<String, GeneEntry> = serde_json::from_str(&gene_entries_json)
            .map_err(|e| Error::from_reason(format!("invalid gene entries JSON: {e}")))?;

        let mut gene_store: HashMap<rotifer_core::types::GeneId, Gene> = HashMap::new();
        for (hex_id, entry) in raw_map {
            let id = hex_to_gene_id(&hex_id)?;
            gene_store.insert(id, Gene {
                id,
                phenotype: entry.phenotype,
                wasm_bytes: Some(entry.wasm),
                source_code: None,
            });
        }

        let constraints = ConstraintSet::default();
        let sandbox = WasmtimeSandbox::new(constraints)
            .map_err(|e| Error::from_reason(format!("sandbox init failed: {e}")))?;

        let context = Context {
            agent_id: "cli-algebra".to_string(),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            permissions: PermissionSet::default(),
            trace_id: Some(uuid::Uuid::new_v4().to_string()),
            binding_extensions: None,
        };

        let start = std::time::Instant::now();
        let executor = AlgebraExecutor::new(&sandbox, &gene_store);

        match executor.execute(&expr, &context, input) {
            Ok(result) => {
                let duration = start.elapsed().as_millis() as i64;
                match result {
                    GeneResult::Success { data, metadata } => Ok(AlgebraResultView {
                        success: true,
                        output: data,
                        error_message: None,
                        steps_executed: 1,
                        total_fuel_consumed: metadata.resource_cost as i64,
                        total_duration_ms: duration,
                    }),
                    GeneResult::Error { message, .. } => Ok(AlgebraResultView {
                        success: false,
                        output: serde_json::Value::Null,
                        error_message: Some(message),
                        steps_executed: 0,
                        total_fuel_consumed: 0,
                        total_duration_ms: duration,
                    }),
                }
            }
            Err(e) => {
                let duration = start.elapsed().as_millis() as i64;
                Ok(AlgebraResultView {
                    success: false,
                    output: serde_json::Value::Null,
                    error_message: Some(e.to_string()),
                    steps_executed: 0,
                    total_fuel_consumed: 0,
                    total_duration_ms: duration,
                })
            }
        }
    }
}

fn gene_to_view(gene: &Gene) -> GeneView {
    GeneView {
        id: hex::encode(gene.id),
        domain: gene.phenotype.domain.clone(),
        version: gene.phenotype.version.clone(),
        fidelity: format!("{:?}", gene.phenotype.fidelity),
        author: gene.phenotype.author.clone(),
    }
}

fn arena_entry_to_view(entry: &ArenaEntry) -> ArenaEntryView {
    ArenaEntryView {
        gene_id: hex::encode(entry.gene_id),
        domain: entry.domain.clone(),
        fitness: entry.fitness.value,
        safety_score: entry.fitness.safety_score,
        rank: entry.rank,
    }
}

fn agent_to_view(agent: &Agent) -> AgentView {
    AgentView {
        id: agent.id.clone(),
        name: agent.name.clone(),
        state: format!("{:?}", agent.state),
        genome_count: agent.genome.len() as u32,
    }
}

fn hex_to_gene_id(hex_str: &str) -> Result<[u8; 32]> {
    let bytes = hex::decode(hex_str)
        .map_err(|e| Error::from_reason(format!("invalid gene id hex: {e}")))?;
    if bytes.len() != 32 {
        return Err(Error::from_reason("gene id must be 32 bytes"));
    }
    let mut id = [0u8; 32];
    id.copy_from_slice(&bytes);
    Ok(id)
}

fn scan_source_file(content: &str, file_path: &str) -> Vec<CandidateFunction> {
    let mut candidates = Vec::new();

    let is_ts = file_path.ends_with(".ts") || file_path.ends_with(".js");
    let is_rs = file_path.ends_with(".rs");

    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();

        if is_ts
            && let Some(name) = extract_ts_function(trimmed)
        {
            candidates.push(CandidateFunction {
                name,
                file_path: file_path.to_string(),
                line_number: (i + 1) as u32,
                params: vec![],
                return_type: None,
                language: "typescript".to_string(),
            });
        }

        if is_rs
            && let Some(name) = extract_rs_function(trimmed)
        {
            candidates.push(CandidateFunction {
                name,
                file_path: file_path.to_string(),
                line_number: (i + 1) as u32,
                params: vec![],
                return_type: None,
                language: "rust".to_string(),
            });
        }
    }

    candidates
}

fn extract_ts_function(line: &str) -> Option<String> {
    let patterns = [
        "export function ",
        "export async function ",
        "export const ",
    ];

    for pattern in &patterns {
        if let Some(rest) = line.strip_prefix(pattern) {
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}

fn extract_rs_function(line: &str) -> Option<String> {
    let patterns = ["pub fn ", "pub async fn ", "fn "];

    for pattern in &patterns {
        if let Some(rest) = line.strip_prefix(pattern) {
            let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if !name.is_empty() {
                return Some(name);
            }
        }
    }
    None
}
