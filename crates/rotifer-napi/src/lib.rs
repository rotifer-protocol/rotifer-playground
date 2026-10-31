#[macro_use]
extern crate napi_derive;

use napi::bindgen_prelude::*;
use rotifer_core::arena::{ArenaEngine, ArenaEntry, LocalArena};
use rotifer_core::compiler::{self, CandidateFunction};
use rotifer_core::fitness;
use rotifer_core::l0::{L0Gate, AuditLog};
use rotifer_core::sandbox::{memory_calls, ConstraintSet, MemoryLink, MemoryOp, Sandbox, WasmtimeSandbox};
use rotifer_core::types::{Context, GeneResult, PermissionSet};

use rotifer_core::storage::{AgentStore, ArenaStore, GeneStore, SqliteStore};
use rotifer_core::types::agent::Agent;
use rotifer_core::types::gene::Gene;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

// P2P node bridge (libp2p) — exposes the real Node to the CLI (§3.1 phase 1).
// Kept at the crate root, not a submodule: the cdylib linker strips an
// unreferenced submodule's napi registration ctor, so the class must live here.
use rotifer_core::p2p::messages::{encode_announcement, local_announcement, ANNOUNCEMENTS_TOPIC};
use rotifer_core::p2p::node::Node as CoreNode;
use rotifer_core::p2p::NetworkConfig;
use std::time::{SystemTime, UNIX_EPOCH};

/// A gene announcement received from a peer, surfaced to the CLI. `publisher`
/// is the GossipSub-authenticated source PeerId (cannot be forged, §8.3);
/// `name` and `version` are display labels claimed by that publisher.
#[napi(object)]
pub struct ReceivedGeneAnnouncement {
    pub gene_id: String,
    pub name: String,
    pub domain: String,
    pub version: String,
    pub fidelity: String,
    pub ir_spec: String,
    pub publisher: String,
    /// Same as `publisher`; kept for callers written against the pre-v1 shape.
    pub source: Option<String>,
}

/// A live libp2p P2P node driven from the TS CLI, so `rotifer network` can run
/// a real node instead of the v0.5 stub. The Node owns its own tokio runtime
/// and keeps running after `start`, so these wrappers are plain sync calls.
#[napi]
pub struct P2pNode {
    inner: CoreNode,
}

#[napi]
impl P2pNode {
    /// Build a node listening on `listen_port`, dialing `bootstrap_peers`
    /// (multiaddr strings). Uses the persistent identity at
    /// `~/.rotifer/identity.pem`, so the `PeerId` is stable across runs.
    #[napi(constructor)]
    pub fn new(
        listen_host: String,
        listen_port: u32,
        bootstrap_peers: Vec<String>,
    ) -> Result<Self> {
        let config = NetworkConfig {
            node_id: uuid::Uuid::new_v4().to_string(),
            listen_host,
            listen_port: listen_port as u16,
            bootstrap_peers,
            enabled: true,
        };
        let inner = CoreNode::new(config)
            .map_err(|e| Error::from_reason(format!("create p2p node: {e}")))?;
        Ok(Self { inner })
    }

    /// Start the swarm. Blocks until the first listen address is ready (or the
    /// bind fails). Afterwards the node keeps running on its own runtime.
    #[napi]
    pub fn start(&mut self) -> Result<()> {
        self.inner
            .start()
            .map_err(|e| Error::from_reason(format!("start p2p node: {e}")))?;
        // Subscribe to the announcements topic on start so the node receives
        // gene announcements from peers — not only after it announces its own.
        self.inner
            .subscribe(ANNOUNCEMENTS_TOPIC)
            .map_err(|e| Error::from_reason(format!("subscribe announcements: {e}")))
    }

    /// The node's stable libp2p `PeerId`.
    #[napi]
    pub fn peer_id(&self) -> String {
        self.inner.local_peer_id().0
    }

    /// Active listen addresses (multiaddr strings); empty until started.
    #[napi]
    pub fn listen_addrs(&self) -> Vec<String> {
        self.inner.listen_addrs()
    }

    /// Peers discovered via Kademlia so far (`PeerId` strings).
    #[napi]
    pub fn discovered_peers(&self) -> Vec<String> {
        self.inner.discovered_peers()
    }

    /// Gene announcements accepted on the announcements topic (wire v1,
    /// validated before forwarding), newest per `(gene_id, publisher)`.
    #[napi]
    pub fn received_announcements(&self) -> Vec<ReceivedGeneAnnouncement> {
        self.inner
            .received_announcements()
            .into_iter()
            .map(|(a, publisher)| ReceivedGeneAnnouncement {
                gene_id: a.gene_id,
                name: a.name,
                domain: a.domain,
                version: a.version,
                fidelity: a.fidelity,
                ir_spec: a.ir_spec,
                source: Some(publisher.clone()),
                publisher,
            })
            .collect()
    }

    /// Announce the local gene `name` under `genes_root`: build its wire-v1
    /// announcement (v2 ID, display fields, IR spec version) and publish it.
    /// Returns the gene's v2 ID. Fails when the gene has no computable ID.
    #[napi]
    pub fn announce_local_gene(&self, genes_root: String, name: String) -> Result<String> {
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let announcement = local_announcement(std::path::Path::new(&genes_root), &name, now_ms)
            .map_err(|e| Error::from_reason(e.to_string()))?;
        let bytes = encode_announcement(&announcement);
        self.inner
            .subscribe(ANNOUNCEMENTS_TOPIC)
            .map_err(|e| Error::from_reason(format!("subscribe: {e}")))?;
        self.inner
            .publish(ANNOUNCEMENTS_TOPIC, &bytes)
            .map_err(|e| Error::from_reason(format!("publish announcement: {e}")))?;
        Ok(announcement.gene_id)
    }

    /// Stop the swarm and release the listen port.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        self.inner
            .stop()
            .map_err(|e| Error::from_reason(format!("stop p2p node: {e}")))
    }
}

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
    /// AgentMemory (§38), in the same database; events to `.rotifer/`.
    memory: Arc<rotifer_core::memory::MemoryStore>,
    /// The memory clock in ms since the epoch; `REAL_TIME` until a test sets it.
    #[cfg(feature = "test-clock")]
    test_clock: Arc<std::sync::atomic::AtomicI64>,
}

#[cfg(feature = "test-clock")]
const REAL_TIME: i64 = i64::MIN;

#[cfg(feature = "test-clock")]
fn system_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// `memoryContextJson` of executeGene / executeAlgebra: the agent a run
/// belongs to, and for executeGene the running gene's v2 id. executeAlgebra
/// takes each gene's id from its entry's `v2Id`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MemoryContextArg {
    agent_id: String,
    #[serde(default)]
    gene_id: Option<String>,
}

fn parse_memory_context(json: Option<String>) -> Result<Option<MemoryContextArg>> {
    json.map(|j| {
        serde_json::from_str::<MemoryContextArg>(&j)
            .map_err(|e| Error::from_reason(format!("MEMORY_INVALID_INPUT: invalid memoryContext JSON: {e}")))
    })
    .transpose()
}

/// Where the CLI finds the credentials a gene declares: the environment
/// variable of the same name, and nowhere else (no key file).
fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The declared credentials of a gene that gets network access; nothing for
/// one that does not, since it could not send them anywhere.
fn credentials_for(
    phenotype: &rotifer_core::types::gene::Phenotype,
    env: &dyn Fn(&str) -> Option<String>,
) -> std::result::Result<std::collections::HashMap<String, String>, Vec<String>> {
    if !PermissionSet::declared_by(phenotype).network_access {
        return Ok(std::collections::HashMap::new());
    }
    rotifer_core::sandbox::hybrid::resolve_credentials(phenotype, env)
}

/// Names the unset variables and says where to set them. Never includes a
/// value: there is none to include, and the caller prints this verbatim.
fn missing_credentials_message(missing: &[String]) -> String {
    let (noun, verb, it) = if missing.len() == 1 {
        ("environment variable", "is", "it")
    } else {
        ("environment variables", "are", "them")
    };
    format!(
        "missing credential: the {noun} {} {verb} not set. This gene declares {it} in \
         externalDependencies[].credentials and needs {it} to call its API. Set {it} in \
         the shell that runs rotifer and try again; the value is only substituted \
         into the request headers the gene sends, never printed or logged.",
        missing.join(", ")
    )
}

impl PlaygroundBinding {
    /// [`Self::new`] with the environment supplied by `env`; it decides
    /// whether memory telemetry is written.
    fn open(project_dir: String, env: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let project_path = PathBuf::from(&project_dir);
        let db_path = project_path.join(".rotifer").join("playground.db");

        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::from_reason(format!("failed to create db dir: {e}")))?;
        }

        let store = SqliteStore::new(&db_path)
            .map_err(|e| Error::from_reason(format!("failed to init storage: {e}")))?;
        let memory = rotifer_core::memory::MemoryStore::open(
            &db_path,
            Arc::new(rotifer_core::memory::JsonlSink::from_env(&project_path.join(".rotifer"), env)),
        )
        .map_err(|e| Error::from_reason(format!("failed to init agent memory: {e}")))?;
        #[cfg(feature = "test-clock")]
        let test_clock = Arc::new(std::sync::atomic::AtomicI64::new(REAL_TIME));
        #[cfg(feature = "test-clock")]
        let memory = {
            let clock = test_clock.clone();
            memory.with_clock(move || match clock.load(std::sync::atomic::Ordering::SeqCst) {
                REAL_TIME => system_ms(),
                ms => ms,
            })
        };

        Ok(Self {
            project_dir: project_path,
            store,
            arena: Mutex::new(LocalArena::new()),
            memory: Arc::new(memory),
            #[cfg(feature = "test-clock")]
            test_clock,
        })
    }
}

/// Test-only clock for AgentMemory, so cross-binding tests can reach an
/// expiry without waiting days. Compiled only with the
/// `test-clock` feature; a release build has neither method.
#[cfg(feature = "test-clock")]
#[napi]
impl PlaygroundBinding {
    /// Memory's clock is now `epoch_ms` (ms since the Unix epoch) until set
    /// again. Nothing else in the binding uses it.
    #[napi]
    pub fn memory_test_set_clock(&self, epoch_ms: f64) -> Result<()> {
        if !epoch_ms.is_finite() || epoch_ms.fract() != 0.0 || epoch_ms < 0.0 || epoch_ms > i64::MAX as f64 {
            return Err(Error::from_reason(format!("epochMs {epoch_ms} is not a whole number of ms")));
        }
        self.test_clock.store(epoch_ms as i64, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    /// Move memory's clock by `ms` (from real time, if it was not set).
    #[napi]
    pub fn memory_test_advance_clock(&self, ms: f64) -> Result<()> {
        if !ms.is_finite() || ms.fract() != 0.0 || ms.abs() > i64::MAX as f64 {
            return Err(Error::from_reason(format!("ms {ms} is not a whole number of ms")));
        }
        let now = match self.test_clock.load(std::sync::atomic::Ordering::SeqCst) {
            REAL_TIME => system_ms(),
            t => t,
        };
        self.test_clock.store(now.saturating_add(ms as i64), std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}

#[napi]
impl PlaygroundBinding {
    #[napi(constructor)]
    pub fn new(project_dir: String) -> Result<Self> {
        Self::open(project_dir, |name| std::env::var(name).ok())
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
    /// Credentials the gene declares are read from the environment variables
    /// of the same name.
    #[napi]
    ///
    /// `memoryContextJson` (`{"agentId", "geneId"}`) links the run to that
    /// agent's AgentMemory, acting as the gene with that v2 id; without it the
    /// gene's memory calls are denied.
    pub fn execute_gene(
        &self,
        wasm_bytes: Buffer,
        input_json: String,
        phenotype_json: String,
        constraints_json: Option<String>,
        memory_context_json: Option<String>,
    ) -> Result<ExecutionResultView> {
        let memory = parse_memory_context(memory_context_json)?;
        self.execute_gene_inner(wasm_bytes, input_json, phenotype_json, constraints_json, &process_env, memory)
    }

    /// `execute_gene` with the credential lookup injected (tests pass a map).
    pub fn execute_gene_with_env(
        &self,
        wasm_bytes: Buffer,
        input_json: String,
        phenotype_json: String,
        constraints_json: Option<String>,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<ExecutionResultView> {
        self.execute_gene_inner(wasm_bytes, input_json, phenotype_json, constraints_json, env, None)
    }

    fn execute_gene_inner(
        &self,
        wasm_bytes: Buffer,
        input_json: String,
        phenotype_json: String,
        constraints_json: Option<String>,
        env: &dyn Fn(&str) -> Option<String>,
        memory: Option<MemoryContextArg>,
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
            agent_id: memory.as_ref().map_or_else(|| "cli".to_string(), |m| m.agent_id.clone()),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            // The CLI has no deployer policy of its own: a gene gets what its
            // phenotype declares, and nothing it does not (v0.9.3 §3.5).
            permissions: PermissionSet::declared_by(&phenotype),
            trace_id: Some(uuid::Uuid::new_v4().to_string()),
            binding_extensions: memory.as_ref().and_then(|m| m.gene_id.as_ref()).map(|id| {
                std::collections::HashMap::from([(
                    rotifer_core::sandbox::CALLER_GENE_ID_EXTENSION.to_string(),
                    serde_json::Value::String(id.clone()),
                )])
            }),
        };

        // Network permission is decided first: a gene that gets none is never
        // asked for a key (spec gate order: fidelity, network, credentials).
        let secrets = match credentials_for(&phenotype, env) {
            Ok(secrets) => secrets,
            Err(missing) => {
                return Ok(ExecutionResultView {
                    success: false,
                    output: serde_json::Value::Null,
                    error_message: Some(missing_credentials_message(&missing)),
                    fuel_consumed: 0,
                    memory_peak_kb: 0,
                    duration_ms: 0,
                    sandbox_type: "blocked".to_string(),
                });
            }
        };

        let mut sandbox = WasmtimeSandbox::new(constraints)
            .map_err(|e| Error::from_reason(format!("sandbox init failed: {e}")))?;
        sandbox.set_hybrid_env(std::collections::HashMap::new(), secrets);
        // Without a memoryContext the gene runs outside any agent; the store
        // is attached only to record its "no agent context" denials.
        if memory.is_some() {
            sandbox.set_memory_store(self.memory.clone());
        } else {
            sandbox.set_memory_store_without_agent(self.memory.clone());
        }

        let max_mem_kb = (sandbox.constraints().max_memory_bytes / 1024) as i64;
        let gene_id_short = context.trace_id.as_deref().unwrap_or("unknown");
        let audit_dir = self.project_dir.join(".rotifer");
        let _ = std::fs::create_dir_all(&audit_dir);
        let audit_path = audit_dir.join("audit.jsonl");
        let audit = AuditLog::new(&audit_path).ok();

        // L0 pre-check for audit logging
        let l0_result = L0Gate::check(&phenotype, &context.permissions, sandbox.constraints());
        if let Some(ref a) = audit {
            let _ = a.log_l0_check(gene_id_short, &phenotype.domain, &l0_result);
        }

        // L0 gate + sandbox execution via execute_gated()
        let started = std::time::Instant::now();
        let result = sandbox.execute_gated(&wasm_bytes, &context, input, &phenotype);
        // A run that fails still ran: a gene stopped at its time limit ran for
        // the whole limit, and reporting 0 hid that (#455).
        let elapsed_ms = started.elapsed().as_millis() as i64;

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
                    duration_ms: elapsed_ms,
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
                    duration_ms: elapsed_ms,
                    sandbox_type: sandbox_type.to_string(),
                }
            }
        };

        Ok(view)
    }

    // ── AgentMemory (spec §38, v0.9.4) ─────────────────────────────────────
    // Entries, filters and errors are the AgentMemory wire JSON. Errors are
    // thrown with the error code first: "MEMORY_ACCESS_DENIED: …".

    /// Create an agent's memory with a quota in bytes (default 10 MB). Throws
    /// MEMORY_INVALID_INPUT if it already exists or the quota is not a
    /// positive whole number.
    #[napi]
    pub fn memory_create(&self, agent_id: String, quota_bytes: Option<f64>) -> Result<serde_json::Value> {
        let quota = match quota_bytes {
            Some(q) => quota_from_js(q)?,
            None => rotifer_core::memory::DEFAULT_QUOTA_BYTES,
        };
        let memory = self.memory.create_memory(&agent_id, quota).map_err(memory_error)?;
        serde_json::to_value(memory).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// Change an agent's quota; a lower one evicts at the next write.
    #[napi]
    pub fn memory_set_quota(&self, agent_id: String, quota_bytes: f64) -> Result<()> {
        self.memory.set_quota(&agent_id, quota_from_js(quota_bytes)?).map_err(memory_error)
    }

    /// The whole AgentMemory, every entry: the deployer's view.
    #[napi]
    pub fn memory_get(&self, agent_id: String) -> Result<serde_json::Value> {
        let memory = self.memory.get_memory(&agent_id).map_err(memory_error)?;
        serde_json::to_value(memory).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// §38.4 export for a MigrationBundle: CACHE left out unless asked.
    #[napi]
    pub fn memory_export(&self, agent_id: String, include_cache: Option<bool>) -> Result<serde_json::Value> {
        let memory = self.memory.export(&agent_id, include_cache.unwrap_or(false)).map_err(memory_error)?;
        serde_json::to_value(memory).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// §38.4 import: the counterpart of memoryExport. `bundleJson` is an
    /// AgentMemory as memoryExport returns it; `optionsJson` is
    /// `{"includeCache"?: bool, "creatorDomains"?: {"<v2 id>": "<domain>"}}`.
    /// Keeps createdBy and both policies even when the creator gene is not in
    /// the target agent; drops CACHE unless asked; obeys the target's quota
    /// and never overwrites a key (all-or-nothing). Returns the target's
    /// AgentMemory.
    #[napi]
    pub fn memory_import(
        &self,
        agent_id: String,
        bundle_json: String,
        options_json: Option<String>,
    ) -> Result<serde_json::Value> {
        #[derive(serde::Deserialize, Default)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Options {
            #[serde(default)]
            include_cache: bool,
            #[serde(default)]
            creator_domains: std::collections::HashMap<String, String>,
        }
        let bundle: rotifer_core::memory::AgentMemory = serde_json::from_str(&bundle_json)
            .map_err(|e| Error::from_reason(format!("MEMORY_INVALID_INPUT: invalid bundle JSON: {e}")))?;
        let options: Options = match options_json {
            Some(j) => serde_json::from_str(&j)
                .map_err(|e| Error::from_reason(format!("MEMORY_INVALID_INPUT: invalid import options JSON: {e}")))?,
            None => Options::default(),
        };
        let memory = self
            .memory
            .import(
                &agent_id,
                &bundle,
                &rotifer_core::memory::ImportOptions {
                    include_cache: options.include_cache,
                    creator_domains: options.creator_domains,
                },
            )
            .map_err(memory_error)?;
        serde_json::to_value(memory).map_err(|e| Error::from_reason(e.to_string()))
    }

    /// readMemory as the gene `callerGeneId` (a v2 id) of domain
    /// `callerDomain`. Request `{key, category?}`; the entry or null.
    #[napi]
    pub fn memory_read(
        &self,
        agent_id: String,
        caller_gene_id: String,
        caller_domain: String,
        request_json: String,
    ) -> Result<serde_json::Value> {
        self.memory_call(MemoryOp::Read, agent_id, caller_gene_id, caller_domain, request_json)
    }

    /// writeMemory. Request `{key, value (base64), category, accessPolicy?,
    /// retentionPolicy?}`; the entry as stored.
    #[napi]
    pub fn memory_write(
        &self,
        agent_id: String,
        caller_gene_id: String,
        caller_domain: String,
        request_json: String,
    ) -> Result<serde_json::Value> {
        self.memory_call(MemoryOp::Write, agent_id, caller_gene_id, caller_domain, request_json)
    }

    /// queryMemory. Request: a MemoryFilter; the readable matching entries.
    #[napi]
    pub fn memory_query(
        &self,
        agent_id: String,
        caller_gene_id: String,
        caller_domain: String,
        request_json: String,
    ) -> Result<serde_json::Value> {
        self.memory_call(MemoryOp::Query, agent_id, caller_gene_id, caller_domain, request_json)
    }

    /// deleteMemory. Request `{key}`; null. A missing key is MEMORY_NOT_FOUND.
    #[napi]
    pub fn memory_delete(
        &self,
        agent_id: String,
        caller_gene_id: String,
        caller_domain: String,
        request_json: String,
    ) -> Result<serde_json::Value> {
        self.memory_call(MemoryOp::Delete, agent_id, caller_gene_id, caller_domain, request_json)
    }

    /// The agent's DataPolicy retention in days (§30.2 `maxRetentionDays`),
    /// or null for unlimited (the default). Entries without their own
    /// retentionPolicy expire by it; the SDK passes it from
    /// the agent's DataPolicy. Throws MEMORY_INVALID_INPUT unless an integer
    /// 1..2147483647 or null, MEMORY_NOT_FOUND when the agent has no memory.
    #[napi]
    pub fn memory_set_data_policy_retention(&self, agent_id: String, days: Option<f64>) -> Result<()> {
        let days = match days {
            None => None,
            Some(d) if d.is_finite() && d.fract() == 0.0 && (1.0..=i32::MAX as f64).contains(&d) => Some(d as u32),
            Some(d) => {
                return Err(Error::from_reason(format!(
                    "MEMORY_INVALID_INPUT: maxRetentionDays {d} is not an integer from 1 to 2147483647"
                )))
            }
        };
        self.memory.set_retention_days(&agent_id, days).map_err(memory_error)
    }

    /// `rotifer agent memory delete <agent> (--key K | --category C)`: the
    /// deployer removes entries whatever their access scopes. `selectorJson`
    /// is `{"key": K}` or `{"category": C}` (UPPERCASE), exactly one. Returns
    /// how many entries were removed; each is an audit line with
    /// `actor: "deployer"`.
    #[napi]
    pub fn memory_admin_delete(&self, agent_id: String, selector_json: String) -> Result<f64> {
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Selector {
            key: Option<String>,
            category: Option<rotifer_core::memory::MemoryCategory>,
        }
        let invalid = |why: String| Error::from_reason(format!("MEMORY_INVALID_INPUT: {why}"));
        let selector: Selector = serde_json::from_str(&selector_json)
            .map_err(|e| invalid(format!("selector is not {{key}} or {{category}}: {e}")))?;
        let target = match (&selector.key, selector.category) {
            (Some(k), None) => rotifer_core::memory::AdminDelete::Key(k),
            (None, Some(c)) => rotifer_core::memory::AdminDelete::Category(c),
            _ => return Err(invalid("the selector needs exactly one of key or category".into())),
        };
        self.memory.admin_delete(&agent_id, target).map(|n| n as f64).map_err(memory_error)
    }

    /// The four gene calls go through the same body as the WASM host
    /// functions, so request validation and error codes cannot drift apart.
    fn memory_call(
        &self,
        op: MemoryOp,
        agent_id: String,
        caller_gene_id: String,
        caller_domain: String,
        request_json: String,
    ) -> Result<serde_json::Value> {
        let caller = rotifer_core::gene_id::is_valid(&caller_gene_id)
            .then_some(rotifer_core::memory::CallerGene { gene_id: caller_gene_id, domain: caller_domain });
        let agent_id = (!agent_id.is_empty()).then_some(agent_id);
        let link = MemoryLink { store: self.memory.clone(), agent_id, caller };
        let r = memory_calls::handle(Some(&link), op, request_json.as_bytes(), usize::MAX);
        if r.code < 0 {
            let message = serde_json::from_slice::<serde_json::Value>(&r.out)
                .ok()
                .and_then(|v| v["__rotifer_error"]["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("{} failed with code {}", op.host_name(), r.code));
            return Err(Error::from_reason(message));
        }
        if r.out.is_empty() {
            return Ok(serde_json::Value::Null);
        }
        serde_json::from_slice(&r.out).map_err(|e| Error::from_reason(e.to_string()))
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
            // Same set execute_gene runs the gene with.
            PermissionSet::declared_by(&phenotype)
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
    /// `constraints_json` sets the sandbox limits applied to every gene, as in
    /// `execute_gene`; omitted, `ConstraintSet::default()` applies.
    #[napi]
    pub fn execute_algebra(
        &self,
        algebra_json: String,
        gene_entries_json: String,
        input_json: String,
        constraints_json: Option<String>,
        memory_context_json: Option<String>,
    ) -> Result<AlgebraResultView> {
        let memory = parse_memory_context(memory_context_json)?;
        self.execute_algebra_inner(algebra_json, gene_entries_json, input_json, constraints_json, &process_env, memory)
    }

    /// `execute_algebra` with the credential lookup injected (tests pass a map).
    pub fn execute_algebra_with_env(
        &self,
        algebra_json: String,
        gene_entries_json: String,
        input_json: String,
        constraints_json: Option<String>,
        env: &dyn Fn(&str) -> Option<String>,
    ) -> Result<AlgebraResultView> {
        self.execute_algebra_inner(algebra_json, gene_entries_json, input_json, constraints_json, env, None)
    }

    fn execute_algebra_inner(
        &self,
        algebra_json: String,
        gene_entries_json: String,
        input_json: String,
        constraints_json: Option<String>,
        env: &dyn Fn(&str) -> Option<String>,
        memory: Option<MemoryContextArg>,
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
            /// v2 gene ID of this gene, reported as `geneId` when it fails
            /// inside a TryCatch (spec §15.2). Optional; ignored if malformed.
            #[serde(default, rename = "v2Id")]
            v2_id: Option<String>,
        }

        let raw_map: HashMap<String, GeneEntry> = serde_json::from_str(&gene_entries_json)
            .map_err(|e| Error::from_reason(format!("invalid gene entries JSON: {e}")))?;

        let mut gene_store: HashMap<rotifer_core::types::GeneId, Gene> = HashMap::new();
        let mut gene_ids: HashMap<rotifer_core::types::GeneId, String> = HashMap::new();
        // Every gene's credentials are loaded once; the sandbox hands each
        // gene only the names it declares itself.
        let mut secrets: HashMap<String, String> = HashMap::new();
        let mut missing: Vec<String> = Vec::new();
        for (hex_id, entry) in raw_map {
            match credentials_for(&entry.phenotype, env) {
                Ok(found) => secrets.extend(found),
                Err(names) => missing.extend(names),
            }
            let id = hex_to_gene_id(&hex_id)?;
            if let Some(v2) = entry.v2_id.filter(|v| rotifer_core::gene_id::is_valid(v)) {
                gene_ids.insert(id, v2);
            }
            gene_store.insert(id, Gene {
                id,
                phenotype: entry.phenotype,
                wasm_bytes: Some(entry.wasm),
                source_code: None,
            });
        }

        let constraints = if let Some(cj) = constraints_json {
            serde_json::from_str::<ConstraintSet>(&cj)
                .unwrap_or_default()
        } else {
            ConstraintSet::default()
        };
        if !missing.is_empty() {
            missing.sort();
            missing.dedup();
            return Ok(AlgebraResultView {
                success: false,
                output: serde_json::Value::Null,
                error_message: Some(missing_credentials_message(&missing)),
                steps_executed: 0,
                total_fuel_consumed: 0,
                total_duration_ms: 0,
            });
        }
        let mut sandbox = WasmtimeSandbox::new(constraints)
            .map_err(|e| Error::from_reason(format!("sandbox init failed: {e}")))?;
        sandbox.set_hybrid_env(HashMap::new(), secrets);
        if memory.is_some() {
            sandbox.set_memory_store(self.memory.clone());
        } else {
            sandbox.set_memory_store_without_agent(self.memory.clone());
        }

        let context = Context {
            agent_id: memory.as_ref().map_or_else(|| "cli-algebra".to_string(), |m| m.agent_id.clone()),
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            permissions: PermissionSet::default(),
            trace_id: Some(uuid::Uuid::new_v4().to_string()),
            binding_extensions: None,
        };

        let start = std::time::Instant::now();
        // Each gene runs with what its own phenotype declares; the context's
        // permission set is not used (v0.9.3 §3.5).
        let executor = AlgebraExecutor::new(&sandbox, &gene_store)
            .with_gene_ids(gene_ids)
            .with_declared_permissions();

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

fn memory_error(e: rotifer_core::memory::MemoryError) -> Error {
    Error::from_reason(e.to_string())
}

/// A JS number as a quota in bytes: a positive whole number.
fn quota_from_js(q: f64) -> Result<u64> {
    if !q.is_finite() || q < 1.0 || q.fract() != 0.0 || q > i64::MAX as f64 {
        return Err(Error::from_reason(format!(
            "MEMORY_INVALID_INPUT: quota {q} is not a positive whole number of bytes"
        )));
    }
    Ok(q as u64)
}

/// Gene ID v2 of the gene `name` under `genes_root` (docs/gene-id-v2.md),
/// resolving local dependencies to their sibling genes' IDs. Throws with the
/// reason when the ID is not computable.
#[napi]
pub fn gene_id_v2(genes_root: String, name: String) -> Result<String> {
    rotifer_core::gene_id::gene_id_in_workspace(std::path::Path::new(&genes_root), &name)
        .map_err(|e| Error::from_reason(e.to_string()))
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

#[cfg(test)]
mod permission_tests {
    //! The CLI runs every gene through `execute_gene` or `execute_algebra`.
    //! Each must hand the sandbox the permissions the gene's phenotype
    //! declares: a Hybrid gene with a `network` block may call
    //! `rotifer.net.fetch`, a gene without one is refused with -2
    //! (ERR_PERMISSION_DENIED). The CLI cannot reach a loopback server, so
    //! the declaring gene fetches a `.invalid` host (RFC 2606, never
    //! resolves): being let through shows up as a network-layer failure
    //! rather than -2.
    use super::*;

    const HOST: &str = "rotifer-permission-test.invalid";
    const DATA: i32 = 1024;
    const OUT: i32 = 16384;
    const OUT_CAP: i32 = 65536;
    /// `DEFAULT_SANDBOX_CONSTRAINTS_JSON` in src/utils/sandbox-defaults.ts.
    const CLI_CONSTRAINTS: &str = r#"{"max_fuel":500000000,"max_memory_bytes":268435456,"max_execution_time_ms":60000,"allowed_host_functions":[],"denied_host_functions":[]}"#;

    /// `express(i32, i32) -> i32` that fetches the envelope in its data
    /// segment and returns the host's result code when it is negative.
    fn fetch_gene() -> Vec<u8> {
        fetch_gene_with(&format!(r#"{{"method":"GET","url":"https://{HOST}/"}}"#))
    }

    fn fetch_gene_with(envelope: &str) -> Vec<u8> {
        use wasm_encoder::*;
        let mut module = Module::new();
        let mut types = TypeSection::new();
        types.ty().function(vec![ValType::I32; 4], vec![ValType::I32]);
        types.ty().function(vec![ValType::I32; 2], vec![ValType::I32]);
        module.section(&types);
        let mut imports = ImportSection::new();
        imports.import("rotifer.net", "fetch", EntityType::Function(0));
        module.section(&imports);
        let mut functions = FunctionSection::new();
        functions.function(1);
        module.section(&functions);
        let mut memories = MemorySection::new();
        memories.memory(MemoryType { minimum: 4, maximum: Some(16), memory64: false, shared: false, page_size_log2: None });
        module.section(&memories);
        let mut exports = ExportSection::new();
        exports.export("express", ExportKind::Func, 1);
        exports.export("memory", ExportKind::Memory, 0);
        module.section(&exports);
        let mut code = CodeSection::new();
        let mut f = Function::new(vec![(1, ValType::I32)]);
        for ins in [
            Instruction::I32Const(DATA),
            Instruction::I32Const(envelope.len() as i32),
            Instruction::I32Const(OUT),
            Instruction::I32Const(OUT_CAP),
            Instruction::Call(0),
            Instruction::LocalSet(2),
            Instruction::LocalGet(2),
            Instruction::I32Const(0),
            Instruction::I32LtS,
            Instruction::If(BlockType::Empty),
            Instruction::LocalGet(2),
            Instruction::Return,
            Instruction::End,
            Instruction::I32Const(OUT),
            Instruction::End,
        ] {
            f.instruction(&ins);
        }
        code.function(&f);
        module.section(&code);
        let mut data = DataSection::new();
        data.active(0, &ConstExpr::i32_const(DATA), envelope.bytes());
        module.section(&data);
        module.finish()
    }

    fn phenotype(declares_network: bool) -> serde_json::Value {
        phenotype_of("Hybrid", declares_network)
    }

    fn phenotype_of(fidelity: &str, declares_network: bool) -> serde_json::Value {
        let mut p = serde_json::json!({
            "domain": "test.permissions",
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
            "version": "0.1.0",
            "fidelity": fidelity,
            "externalDependencies": [
                {"apiType": "rest", "semanticTag": "permission-test", "domains": [HOST]}
            ],
        });
        if declares_network {
            p["network"] = serde_json::json!({"allowedDomains": [HOST], "maxTimeoutMs": 5000});
        }
        p
    }

    fn binding() -> PlaygroundBinding {
        binding_in().0
    }

    fn binding_in() -> (PlaygroundBinding, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("rotifer-napi-perm-{}", uuid::Uuid::new_v4()));
        (PlaygroundBinding::new(dir.to_string_lossy().into_owned()).unwrap(), dir)
    }

    fn guest_code(message: &str) -> i32 {
        let tail = message
            .split("error code: ")
            .nth(1)
            .unwrap_or_else(|| panic!("no guest error code in: {message}"));
        tail.trim_start()
            .chars()
            .take_while(|c| *c == '-' || c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or_else(|_| panic!("unparseable guest error code in: {message}"))
    }

    /// -5 (ERR_NETWORK) when the lookup fails outright, -4 (ERR_TIMEOUT) if
    /// the resolver is slow: either way the request was let through.
    fn assert_let_through(code: i32) {
        assert!(code == -5 || code == -4, "expected a network-layer failure (-5 / -4), got {code}");
    }

    fn run_gene(declares_network: bool) -> ExecutionResultView {
        run_gene_with(phenotype(declares_network))
    }

    fn run_gene_with(phenotype: serde_json::Value) -> ExecutionResultView {
        binding()
            .execute_gene(
                Buffer::from(fetch_gene()),
                "{}".into(),
                phenotype.to_string(),
                Some(CLI_CONSTRAINTS.into()),
                None,
            )
            .unwrap()
    }

    fn run_algebra(declares_network: bool) -> AlgebraResultView {
        run_algebra_with(phenotype(declares_network))
    }

    fn run_algebra_with(phenotype: serde_json::Value) -> AlgebraResultView {
        let id = [7u8; 32];
        let entries = serde_json::json!({
            hex::encode(id): {"wasm": fetch_gene(), "phenotype": phenotype}
        });
        let expr = serde_json::json!({"Seq": [{"Gene": id}]});
        binding()
            .execute_algebra(expr.to_string(), entries.to_string(), "{}".into(), Some(CLI_CONSTRAINTS.into()), None)
            .unwrap()
    }

    /// `express(i32, i32) -> i32` that never returns.
    fn spinning_gene() -> Vec<u8> {
        use wasm_encoder::*;
        let mut module = Module::new();
        let mut types = TypeSection::new();
        types.ty().function(vec![ValType::I32; 2], vec![ValType::I32]);
        module.section(&types);
        let mut functions = FunctionSection::new();
        functions.function(0);
        module.section(&functions);
        let mut memories = MemorySection::new();
        memories.memory(MemoryType { minimum: 1, maximum: None, memory64: false, shared: false, page_size_log2: None });
        module.section(&memories);
        let mut exports = ExportSection::new();
        exports.export("express", ExportKind::Func, 0);
        exports.export("memory", ExportKind::Memory, 0);
        module.section(&exports);
        let mut code = CodeSection::new();
        let mut body = Function::new(vec![]);
        body.instruction(&Instruction::Loop(BlockType::Empty));
        body.instruction(&Instruction::Br(0));
        body.instruction(&Instruction::End);
        body.instruction(&Instruction::I32Const(0));
        body.instruction(&Instruction::End);
        code.function(&body);
        module.section(&code);
        module.finish()
    }

    /// Fuel enough to outlast the wall-clock limit, so the limit is what stops
    /// it. 30 s, not less: a gene's declared time budget is a fixed 30 s
    /// (ResourceLimits::default), and L0 refuses a run whose limit is below
    /// it before anything executes — a budget rejection, not the running
    /// interruption #455 is about. The two tests run in parallel.
    const DEADLINE: &str = r#"{"max_fuel":9000000000000000000,"max_memory_bytes":268435456,"max_execution_time_ms":30000,"allowed_host_functions":[],"denied_host_functions":[]}"#;

    fn native_phenotype() -> serde_json::Value {
        serde_json::json!({
            "domain": "test.deadline",
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"},
            "version": "0.1.0",
            "fidelity": "Native",
        })
    }

    /// #455: a gene stopped by its time limit says so, and says how long it ran.
    #[test]
    fn a_gene_past_its_time_limit_reports_a_timeout_and_its_duration() {
        let r = binding()
            .execute_gene(
                Buffer::from(spinning_gene()),
                "{}".into(),
                native_phenotype().to_string(),
                Some(DEADLINE.into()),
                None,
            )
            .unwrap();
        assert!(!r.success);
        let message = r.error_message.as_deref().unwrap();
        assert!(message.contains(rotifer_core::sandbox::TIMEOUT_MESSAGE_PREFIX), "not a timeout: {message}");
        assert!(r.duration_ms >= 29_000, "ran ~30 s, reported {} ms", r.duration_ms);
    }

    /// #455: a Try handler learns the primary timed out, not that it failed.
    #[test]
    fn a_try_handler_receives_timeout_for_a_primary_past_its_limit() {
        let spin = [1u8; 32];
        let echo = [2u8; 32];
        let entries = serde_json::json!({
            hex::encode(spin): {"wasm": spinning_gene(), "phenotype": native_phenotype()},
            hex::encode(echo): {"wasm": rotifer_core::compiler::genesis::build_echo_gene_wasm(), "phenotype": native_phenotype()},
        });
        let expr = serde_json::json!({"Try": {"primary": {"Gene": spin}, "fallback": {"Gene": echo}}});
        let r = binding()
            .execute_algebra(expr.to_string(), entries.to_string(), "{}".into(), Some(DEADLINE.into()), None)
            .unwrap();
        assert!(r.success, "the handler should have run: {:?}", r.error_message);
        assert_eq!(r.output["error"]["errorCode"], "TIMEOUT", "handler input: {}", r.output);
    }

    #[test]
    fn execute_gene_lets_a_gene_that_declares_network_fetch() {
        let r = run_gene(true);
        assert!(!r.success);
        assert_let_through(guest_code(r.error_message.as_deref().unwrap()));
    }

    #[test]
    fn execute_gene_refuses_a_gene_that_declares_no_network() {
        let r = run_gene(false);
        assert!(!r.success);
        assert_eq!(guest_code(r.error_message.as_deref().unwrap()), -2);
    }

    #[test]
    fn execute_algebra_lets_a_gene_that_declares_network_fetch() {
        let r = run_algebra(true);
        assert!(!r.success);
        assert_let_through(guest_code(r.error_message.as_deref().unwrap()));
    }

    #[test]
    fn execute_algebra_refuses_a_gene_that_declares_no_network() {
        let r = run_algebra(false);
        assert!(!r.success);
        assert_eq!(guest_code(r.error_message.as_deref().unwrap()), -2);
    }

    /// The case only the permission gate decides. A gene with no `network`
    /// block is refused by the sandbox whatever permissions it gets, so the
    /// tests above would stay green if the bridge granted network to every
    /// gene. A Wrapped gene that writes a `network` block has a policy the
    /// sandbox would honour; only `declared_by` (network for Hybrid genes
    /// alone) keeps it off the network.
    #[test]
    fn a_wrapped_gene_with_a_network_block_is_refused_on_both_paths() {
        let wrapped = phenotype_of("Wrapped", true);

        let r = run_gene_with(wrapped.clone());
        assert!(!r.success);
        assert_eq!(guest_code(r.error_message.as_deref().unwrap()), -2, "execute_gene");

        let r = run_algebra_with(wrapped);
        assert!(!r.success);
        assert_eq!(guest_code(r.error_message.as_deref().unwrap()), -2, "execute_algebra");
    }

    #[test]
    fn l0_check_without_explicit_permissions_uses_the_declared_ones() {
        // The declared set carries an explicit (empty) filesystem list, so
        // the gate checks it instead of skipping it.
        let declared = binding().l0_check(phenotype(true).to_string(), None, None).unwrap();
        let explicit_default = binding()
            .l0_check(phenotype(true).to_string(), Some(serde_json::to_string(&PermissionSet::default()).unwrap()), None)
            .unwrap();
        assert!(declared.passed);
        assert_eq!(declared.checks_performed, explicit_default.checks_performed + 1);
    }

    // ── Credentials (T-93) ──────────────────────────────────────────────
    // A gene names the secrets it needs in `externalDependencies[].credentials`.
    // The CLI reads each declared name from the environment variable of the
    // same name and nothing else; the value reaches the gene only through
    // host-side `${env:NAME}` header substitution (ADR-327 D3). A declared
    // name that is unset stops the run before the gene executes.

    const SENTINEL: &str = "t93-sentinel-value-never-printed";

    /// Fetches HOST with `Authorization: Bearer ${env:<uses>}`.
    fn bearer_gene(uses: &str) -> Vec<u8> {
        fetch_gene_with(&format!(
            r#"{{"method":"GET","url":"https://{HOST}/","headers":{{"Authorization":"Bearer ${{env:{uses}}}"}}}}"#
        ))
    }

    fn declaring(credentials: &[&str]) -> serde_json::Value {
        let mut p = phenotype(true);
        p["externalDependencies"][0]["credentials"] = serde_json::json!(credentials);
        p
    }

    fn env_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| pairs.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }

    fn assert_no_sentinel(dir: &std::path::Path, texts: &[&str]) {
        for t in texts {
            assert!(!t.contains(SENTINEL), "credential value leaked into: {t}");
        }
        let audit = std::fs::read_to_string(dir.join(".rotifer").join("audit.jsonl")).unwrap_or_default();
        assert!(!audit.contains(SENTINEL), "credential value leaked into audit.jsonl");
    }

    #[test]
    fn a_declared_credential_that_is_unset_stops_the_run_before_the_gene_executes() {
        let (b, _) = binding_in();
        let r = b
            .execute_gene_with_env(
                Buffer::from(bearer_gene("T93_KEY")),
                "{}".into(),
                declaring(&["T93_KEY"]).to_string(),
                Some(CLI_CONSTRAINTS.into()),
                &env_of(&[]),
            )
            .unwrap();
        assert!(!r.success);
        let msg = r.error_message.unwrap();
        assert!(msg.contains("T93_KEY"), "names the variable: {msg}");
        assert!(msg.contains("environment variable"), "says where to set it: {msg}");
        assert!(!msg.contains("error code:"), "the gene must not have run: {msg}");
        assert_eq!(r.fuel_consumed, 0);
    }

    #[test]
    fn an_empty_value_counts_as_unset() {
        let (b, _) = binding_in();
        let r = b
            .execute_gene_with_env(
                Buffer::from(bearer_gene("T93_KEY")),
                "{}".into(),
                declaring(&["T93_KEY"]).to_string(),
                Some(CLI_CONSTRAINTS.into()),
                &env_of(&[("T93_KEY", "")]),
            )
            .unwrap();
        assert!(!r.success);
        assert!(r.error_message.unwrap().contains("T93_KEY"));
    }

    #[test]
    fn a_declared_credential_that_is_set_is_substituted_into_the_header() {
        let (b, dir) = binding_in();
        let r = b
            .execute_gene_with_env(
                Buffer::from(bearer_gene("T93_KEY")),
                "{}".into(),
                declaring(&["T93_KEY"]).to_string(),
                Some(CLI_CONSTRAINTS.into()),
                &env_of(&[("T93_KEY", SENTINEL)]),
            )
            .unwrap();
        assert!(!r.success);
        let msg = r.error_message.unwrap();
        // Substitution succeeded (an unresolved name would be -2); the
        // request then failed at the network layer on the .invalid host.
        assert_let_through(guest_code(&msg));
        assert_no_sentinel(&dir, &[&msg, &r.output.to_string()]);
    }

    #[test]
    fn a_name_the_gene_did_not_declare_is_never_read() {
        // The variable is set, but the gene declares nothing.
        let (b, _) = binding_in();
        let r = b
            .execute_gene_with_env(
                Buffer::from(bearer_gene("T93_KEY")),
                "{}".into(),
                phenotype(true).to_string(),
                Some(CLI_CONSTRAINTS.into()),
                &env_of(&[("T93_KEY", SENTINEL)]),
            )
            .unwrap();
        assert!(!r.success);
        assert_eq!(guest_code(r.error_message.as_deref().unwrap()), -2);
    }

    /// Spec gate order: network permission is decided before credentials.
    /// A gene that gets no network (here Wrapped, so `declared_by` grants
    /// none) is never asked for a key: it fails the way it would without
    /// one declared, with -2 from its fetch, on both paths.
    #[test]
    fn a_gene_without_network_permission_is_not_asked_for_credentials() {
        let mut wrapped = phenotype_of("Wrapped", true);
        wrapped["externalDependencies"][0]["credentials"] = serde_json::json!(["T93_KEY"]);

        let r = binding()
            .execute_gene_with_env(
                Buffer::from(bearer_gene("T93_KEY")),
                "{}".into(),
                wrapped.to_string(),
                Some(CLI_CONSTRAINTS.into()),
                &env_of(&[]),
            )
            .unwrap();
        assert_eq!(guest_code(r.error_message.as_deref().unwrap()), -2, "execute_gene");

        let id = [12u8; 32];
        let entries = serde_json::json!({
            hex::encode(id): {"wasm": bearer_gene("T93_KEY"), "phenotype": wrapped}
        });
        let (r, _) = algebra_with_env(entries, id, &env_of(&[]));
        assert_eq!(guest_code(r.error_message.as_deref().unwrap()), -2, "execute_algebra");
    }

    #[test]
    fn execute_gene_reads_the_process_environment() {
        // PATH is set wherever these tests run; declaring it proves the
        // public entry point looks names up in the real environment.
        let r = binding()
            .execute_gene(
                Buffer::from(bearer_gene("PATH")),
                "{}".into(),
                declaring(&["PATH"]).to_string(),
                Some(CLI_CONSTRAINTS.into()),
                None,
            )
            .unwrap();
        assert!(!r.success);
        assert_let_through(guest_code(r.error_message.as_deref().unwrap()));
    }

    fn algebra_with_env(
        entries: serde_json::Value,
        run: [u8; 32],
        env: &dyn Fn(&str) -> Option<String>,
    ) -> (AlgebraResultView, std::path::PathBuf) {
        let (b, dir) = binding_in();
        let expr = serde_json::json!({"Seq": [{"Gene": run}]});
        let r = b
            .execute_algebra_with_env(expr.to_string(), entries.to_string(), "{}".into(), Some(CLI_CONSTRAINTS.into()), env)
            .unwrap();
        (r, dir)
    }

    #[test]
    fn execute_algebra_stops_on_an_unset_declared_credential() {
        let id = [8u8; 32];
        let entries = serde_json::json!({
            hex::encode(id): {"wasm": bearer_gene("T93_KEY"), "phenotype": declaring(&["T93_KEY"])}
        });
        let (r, _) = algebra_with_env(entries, id, &env_of(&[]));
        assert!(!r.success);
        let msg = r.error_message.unwrap();
        assert!(msg.contains("T93_KEY") && msg.contains("environment variable"), "{msg}");
        assert!(!msg.contains("error code:"), "the gene must not have run: {msg}");
    }

    #[test]
    fn execute_algebra_substitutes_a_declared_credential() {
        let id = [9u8; 32];
        let entries = serde_json::json!({
            hex::encode(id): {"wasm": bearer_gene("T93_KEY"), "phenotype": declaring(&["T93_KEY"])}
        });
        let (r, dir) = algebra_with_env(entries, id, &env_of(&[("T93_KEY", SENTINEL)]));
        assert!(!r.success);
        let msg = r.error_message.unwrap();
        assert_let_through(guest_code(&msg));
        assert_no_sentinel(&dir, &[&msg, &r.output.to_string()]);
    }

    /// In a composition every declared credential is loaded once, so the
    /// sandbox must still hand each gene only the names it declares itself:
    /// a gene that borrows another gene's key gets -2.
    #[test]
    fn in_algebra_a_gene_cannot_use_another_genes_credential() {
        let owner = [10u8; 32];
        let borrower = [11u8; 32];
        let entries = serde_json::json!({
            hex::encode(owner): {"wasm": bearer_gene("T93_KEY"), "phenotype": declaring(&["T93_KEY"])},
            hex::encode(borrower): {"wasm": bearer_gene("T93_KEY"), "phenotype": phenotype(true)},
        });
        let (r, _) = algebra_with_env(entries, borrower, &env_of(&[("T93_KEY", SENTINEL)]));
        assert!(!r.success);
        assert_eq!(guest_code(r.error_message.as_deref().unwrap()), -2);
    }
}

#[cfg(test)]
mod memory_tests {
    //! AgentMemory through the binding the CLI calls.

    use super::*;

    const AGENT: &str = "agent-napi";

    fn v2(n: u8) -> String {
        format!("v2:{}", hex::encode([n; 32]))
    }

    /// A binding in a fresh project directory with telemetry on, whatever
    /// this machine's DO_NOT_TRACK / ROTIFER_TELEMETRY say.
    fn binding_in() -> (PlaygroundBinding, std::path::PathBuf) {
        binding_with_env(&[])
    }

    fn binding_with_env(vars: &[(&str, &str)]) -> (PlaygroundBinding, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("rotifer-napi-mem-{}", uuid::Uuid::new_v4()));
        let vars: Vec<(String, String)> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let b = PlaygroundBinding::open(dir.to_string_lossy().into_owned(), move |name| {
            vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
        })
        .unwrap();
        (b, dir)
    }

    fn native(domain: &str) -> serde_json::Value {
        serde_json::json!({
            "domain": domain,
            "inputSchema": {"type": "object"},
            "outputSchema": {},
            "version": "0.1.0",
            "fidelity": "Native",
        })
    }

    /// `express` makes one host call with `request` and returns its response
    /// buffer (zeroed memory, so NUL-terminated). Import 0 is readMemory,
    /// 1 writeMemory.
    fn guest(import: u32, request: &str) -> Vec<u8> {
        use wasm_encoder::*;
        let mut module = Module::new();
        let mut types = TypeSection::new();
        types.ty().function(vec![ValType::I32; 4], vec![ValType::I32]);
        types.ty().function(vec![ValType::I32; 2], vec![ValType::I32]);
        module.section(&types);
        let mut imports = ImportSection::new();
        imports.import("rotifer", "readMemory", EntityType::Function(0));
        imports.import("rotifer", "writeMemory", EntityType::Function(0));
        module.section(&imports);
        let mut functions = FunctionSection::new();
        functions.function(1);
        module.section(&functions);
        let mut memories = MemorySection::new();
        memories.memory(MemoryType { minimum: 1, maximum: None, memory64: false, shared: false, page_size_log2: None });
        module.section(&memories);
        let mut exports = ExportSection::new();
        exports.export("express", ExportKind::Func, 2);
        exports.export("memory", ExportKind::Memory, 0);
        module.section(&exports);
        let mut code = CodeSection::new();
        let mut body = Function::new(vec![]);
        body.instruction(&Instruction::I32Const(8192));
        body.instruction(&Instruction::I32Const(request.len() as i32));
        body.instruction(&Instruction::I32Const(16384));
        body.instruction(&Instruction::I32Const(16384));
        body.instruction(&Instruction::Call(import));
        body.instruction(&Instruction::Drop);
        body.instruction(&Instruction::I32Const(16384));
        body.instruction(&Instruction::End);
        code.function(&body);
        module.section(&code);
        let mut data = DataSection::new();
        data.active(0, &ConstExpr::i32_const(8192), request.bytes());
        module.section(&data);
        module.finish()
    }

    const WRITE_LANG: &str = r#"{"key":"lang","value":"emgtQ04=","category":"PREFERENCE"}"#;
    const READ_LANG: &str = r#"{"key":"lang"}"#;

    /// The constraints the CLI passes (`DEFAULT_SANDBOX_CONSTRAINTS_JSON`,
    /// 5e8 fuel). Without them the binding falls back to 1e6, which cannot
    /// pay for one memory call.
    fn cli_constraints() -> Option<String> {
        Some(serde_json::to_string(&ConstraintSet { max_fuel: 500_000_000, ..Default::default() }).unwrap())
    }

    fn ctx(agent: &str, gene: Option<&str>) -> Option<String> {
        Some(match gene {
            Some(g) => serde_json::json!({"agentId": agent, "geneId": g}).to_string(),
            None => serde_json::json!({"agentId": agent}).to_string(),
        })
    }

    #[test]
    fn create_get_set_quota_and_export() {
        let (b, dir) = binding_in();
        let m = b.memory_create(AGENT.into(), None).unwrap();
        assert_eq!(m["quota"], 10 * 1024 * 1024);
        assert_eq!(m["agentId"], AGENT);
        assert!(b.memory_create(AGENT.into(), Some(10.0)).unwrap_err().reason.starts_with("MEMORY_INVALID_INPUT: "));
        for bad in [0.0, -1.0, 1.5, f64::NAN] {
            assert!(b.memory_create("other".into(), Some(bad)).is_err(), "{bad}");
        }
        b.memory_set_quota(AGENT.into(), 4096.0).unwrap();
        assert_eq!(b.memory_get(AGENT.into()).unwrap()["quota"], 4096);
        assert!(b.memory_get("nobody".into()).unwrap_err().reason.starts_with("MEMORY_NOT_FOUND: "));

        b.memory_write(AGENT.into(), v2(1), "text.x".into(), WRITE_LANG.into()).unwrap();
        b.memory_write(AGENT.into(), v2(1), "text.x".into(), r#"{"key":"tmp","value":"","category":"CACHE"}"#.into())
            .unwrap();
        assert_eq!(b.memory_export(AGENT.into(), None).unwrap()["entries"].as_array().unwrap().len(), 1);
        assert_eq!(b.memory_export(AGENT.into(), Some(true)).unwrap()["entries"].as_array().unwrap().len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_four_gene_calls_and_their_errors() {
        let (b, dir) = binding_in();
        let w = b.memory_write(AGENT.into(), v2(1), "text.x".into(), WRITE_LANG.into()).unwrap();
        assert_eq!(w["createdBy"], v2(1));
        let r = b.memory_read(AGENT.into(), v2(2), "text.x".into(), READ_LANG.into()).unwrap();
        assert_eq!(r["lastAccessedBy"], v2(2));
        assert_eq!(b.memory_read(AGENT.into(), v2(2), "text.x".into(), r#"{"key":"nope"}"#.into()).unwrap(), serde_json::Value::Null);
        let q = b.memory_query(AGENT.into(), v2(2), "text.x".into(), "{}".into()).unwrap();
        assert_eq!(q.as_array().unwrap().len(), 1);

        let denied = b.memory_read(AGENT.into(), v2(3), "search.web".into(), READ_LANG.into()).unwrap_err();
        assert!(denied.reason.starts_with("MEMORY_ACCESS_DENIED: "), "{}", denied.reason);
        let anonymous = b.memory_read(AGENT.into(), "not-v2".into(), "text.x".into(), READ_LANG.into()).unwrap_err();
        assert!(anonymous.reason.starts_with("MEMORY_ACCESS_DENIED: "));
        let invalid = b.memory_write(AGENT.into(), v2(1), "text.x".into(), "{".into()).unwrap_err();
        assert!(invalid.reason.starts_with("MEMORY_INVALID_INPUT: "));

        assert_eq!(b.memory_delete(AGENT.into(), v2(1), "text.x".into(), READ_LANG.into()).unwrap(), serde_json::Value::Null);
        let gone = b.memory_delete(AGENT.into(), v2(1), "text.x".into(), READ_LANG.into()).unwrap_err();
        assert!(gone.reason.starts_with("MEMORY_NOT_FOUND: "));

        // Lifecycle lines and the denial event land in the project's .rotifer/.
        let audit = std::fs::read_to_string(dir.join(".rotifer").join("audit.jsonl")).unwrap();
        assert!(audit.lines().any(|l| l.contains("\"action\":\"delete\"")));
        let telemetry = std::fs::read_to_string(dir.join(".rotifer").join("telemetry.jsonl")).unwrap();
        assert!(telemetry.contains("MEMORY_ACCESS_DENIED"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn execute_gene_links_memory_only_with_a_memory_context() {
        let (b, dir) = binding_in();
        let run = |context: Option<String>| {
            b.execute_gene(
                Buffer::from(guest(1, WRITE_LANG)),
                "{}".into(),
                native("text.x").to_string(),
                cli_constraints(),
                context,
            )
            .unwrap()
        };

        // An old-style call (no memoryContext) still runs the gene; its
        // memory call is denied with "no agent context".
        let without = run(None);
        assert!(!without.success);
        assert!(without.error_message.unwrap().contains("MEMORY_ACCESS_DENIED: no agent context"));
        assert!(b.memory_get(AGENT.into()).is_err());

        let with = run(ctx(AGENT, Some(&v2(7))));
        assert!(with.success, "{:?}", with.error_message);
        assert_eq!(with.output["createdBy"], v2(7));
        assert_eq!(b.memory_get(AGENT.into()).unwrap()["entries"][0]["createdBy"], v2(7));

        let bad = b.execute_gene(Buffer::from(guest(0, READ_LANG)), "{}".into(), native("text.x").to_string(), None, Some("{".into()));
        match bad {
            Err(e) => assert!(e.reason.starts_with("MEMORY_INVALID_INPUT: "), "{}", e.reason),
            Ok(_) => panic!("a malformed memoryContext was accepted"),
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn execute_algebra_runs_each_gene_as_its_v2_id() {
        let (b, dir) = binding_in();
        let writer = [1u8; 32];
        let reader = [2u8; 32];
        let entries = serde_json::json!({
            hex::encode(writer): {"wasm": guest(1, WRITE_LANG), "phenotype": native("text.x"), "v2Id": v2(1)},
            hex::encode(reader): {"wasm": guest(0, READ_LANG), "phenotype": native("text.x"), "v2Id": v2(2)},
        });
        let expr = serde_json::json!({"Seq": [{"Gene": writer}, {"Gene": reader}]});
        let r = b
            .execute_algebra(expr.to_string(), entries.to_string(), "{}".into(), cli_constraints(), ctx(AGENT, None))
            .unwrap();
        assert!(r.success, "{:?}", r.error_message);
        assert_eq!(r.output["createdBy"], v2(1));
        assert_eq!(r.output["lastAccessedBy"], v2(2));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn memory_survives_a_new_binding_on_the_same_project() {
        let (b, dir) = binding_in();
        b.memory_write(AGENT.into(), v2(1), "text.x".into(), WRITE_LANG.into()).unwrap();
        drop(b);
        let again = PlaygroundBinding::new(dir.to_string_lossy().into_owned()).unwrap();
        let r = again.memory_read(AGENT.into(), v2(1), "text.x".into(), READ_LANG.into()).unwrap();
        assert_eq!(r["value"], "emgtQ04=");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn export_then_import_round_trips_through_json() {
        let (b, dir) = binding_in();
        b.memory_create(AGENT.into(), Some(4096.0)).unwrap();
        b.memory_write(AGENT.into(), v2(1), "text.x".into(), WRITE_LANG.into()).unwrap();
        b.memory_write(
            AGENT.into(),
            v2(1),
            "text.x".into(),
            r#"{"key":"tmp","value":"AA==","category":"CACHE"}"#.into(),
        )
        .unwrap();
        let bundle = b.memory_export(AGENT.into(), None).unwrap();

        let (target, target_dir) = binding_in();
        let options = serde_json::json!({"creatorDomains": {v2(1): "text.x"}}).to_string();
        let imported = target.memory_import("agent-new".into(), bundle.to_string(), Some(options)).unwrap();
        assert_eq!(imported["agentId"], "agent-new");
        assert_eq!(imported["quota"], 4096);
        let entries = imported["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 1, "CACHE is dropped");
        let (got, want) = (&entries[0], &bundle["entries"][0]);
        for field in ["category", "key", "value", "createdBy", "lastAccessedBy", "createdAt", "updatedAt", "accessPolicy", "retentionPolicy"] {
            assert_eq!(got[field], want[field], "{field}");
        }
        assert_ne!(got["entryId"], want["entryId"]);
        // The creator (absent from the new agent) keeps SAME_DOMAIN access via its mapped domain.
        let r = target.memory_read("agent-new".into(), v2(2), "text.x".into(), READ_LANG.into()).unwrap();
        assert_eq!(r["value"], "emgtQ04=");

        let refused = target.memory_import("agent-new".into(), bundle.to_string(), None).unwrap_err();
        assert!(refused.reason.starts_with("MEMORY_INVALID_INPUT: "), "{}", refused.reason);
        let bad = target.memory_import("x".into(), "{}".into(), None).unwrap_err();
        assert!(bad.reason.starts_with("MEMORY_INVALID_INPUT: "));
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(target_dir).unwrap();
    }

    #[test]
    fn size_limits_hold_through_the_binding() {
        use base64::Engine as _;
        let (b, dir) = binding_in();
        b.memory_create(AGENT.into(), Some(20.0 * 1024.0 * 1024.0)).unwrap();
        let write = |key: &str, n: usize| {
            b.memory_write(
                AGENT.into(),
                v2(1),
                "text.x".into(),
                format!(
                    r#"{{"key":"{key}","value":"{}","category":"CACHE"}}"#,
                    base64::engine::general_purpose::STANDARD.encode(vec![5u8; n])
                ),
            )
        };
        const MIB: usize = 1024 * 1024;
        write("at", MIB).unwrap();
        let over = write("over", MIB + 1).unwrap_err();
        assert!(over.reason.starts_with("MEMORY_INVALID_INPUT: "), "{}", over.reason);
        for i in 0..4 {
            write(&format!("big{i}"), MIB).unwrap();
        }
        let big = b.memory_query(AGENT.into(), v2(1), "text.x".into(), "{}".into()).unwrap_err();
        assert!(
            big.reason.starts_with("MEMORY_INVALID_INPUT: ")
                && big.reason.contains("result too large; lower limit or narrow the filter"),
            "{}",
            big.reason
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_binding_honours_the_telemetry_opt_out_but_always_audits() {
        // DO_NOT_TRACK and ROTIFER_TELEMETRY, as the CLI reads them.
        for (vars, telemetry) in [(&[][..], true), (&[("ROTIFER_TELEMETRY", "0")][..], false), (&[("DO_NOT_TRACK", "1")][..], false)] {
            let (b, dir) = binding_with_env(vars);
            b.memory_write(AGENT.into(), v2(1), "text.x".into(), WRITE_LANG.into()).unwrap();
            assert!(b.memory_read(AGENT.into(), v2(3), "search.web".into(), READ_LANG.into()).is_err());
            let rotifer = dir.join(".rotifer");
            let audit = std::fs::read_to_string(rotifer.join("audit.jsonl")).unwrap();
            assert!(audit.contains("\"action\":\"access_denied\""), "{vars:?}");
            assert_eq!(rotifer.join("telemetry.jsonl").exists(), telemetry, "{vars:?}");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn the_deployer_deletes_through_the_binding() {
        // `rotifer agent memory delete <agent> (--key K | --category C)`.
        let (b, dir) = binding_in();
        b.memory_write(AGENT.into(), v2(1), "text.x".into(), WRITE_LANG.into()).unwrap();
        b.memory_write(AGENT.into(), v2(1), "text.x".into(), r#"{"key":"tmp","value":"","category":"CACHE"}"#.into())
            .unwrap();
        assert_eq!(b.memory_admin_delete(AGENT.into(), r#"{"key":"lang"}"#.into()).unwrap(), 1.0);
        assert_eq!(b.memory_admin_delete(AGENT.into(), r#"{"category":"CACHE"}"#.into()).unwrap(), 1.0);
        assert_eq!(b.memory_get(AGENT.into()).unwrap()["entries"].as_array().unwrap().len(), 0);
        for bad in ["{}", r#"{"key":"k","category":"CACHE"}"#, r#"{"category":"cache"}"#, r#"{"keyPrefix":"k"}"#, r#"{"key":""}"#, "[]", "not json"] {
            let err = b.memory_admin_delete(AGENT.into(), bad.into()).unwrap_err();
            assert!(err.reason.starts_with("MEMORY_INVALID_INPUT: "), "{bad}: {}", err.reason);
        }
        let gone = b.memory_admin_delete(AGENT.into(), r#"{"key":"lang"}"#.into()).unwrap_err();
        assert!(gone.reason.starts_with("MEMORY_NOT_FOUND: "), "{}", gone.reason);
        let audit = std::fs::read_to_string(dir.join(".rotifer").join("audit.jsonl")).unwrap();
        assert_eq!(audit.lines().filter(|l| l.contains("\"actor\":\"deployer\"")).count(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn denials_are_recorded_through_the_binding() {
        // Inside an agent a denial is audit + telemetry, a gene
        // with no usable v2 id included. Outside any agent (no
        // memoryContext) it is telemetry only: no agent to audit it under.
        let (b, dir) = binding_in();
        let rotifer = dir.join(".rotifer");
        b.memory_read(AGENT.into(), "not-v2".into(), "text.x".into(), READ_LANG.into()).unwrap_err();
        let audit = std::fs::read_to_string(rotifer.join("audit.jsonl")).unwrap();
        let line: serde_json::Value = serde_json::from_str(audit.lines().last().unwrap()).unwrap();
        assert_eq!((line["action"].as_str(), line["agentId"].as_str()), (Some("access_denied"), Some(AGENT)));
        assert!(line["geneId"].is_null());

        let audit_before = std::fs::read_to_string(rotifer.join("audit.jsonl")).unwrap();
        let telemetry_before = std::fs::read_to_string(rotifer.join("telemetry.jsonl")).unwrap().lines().count();
        let run = b
            .execute_gene(Buffer::from(guest(1, WRITE_LANG)), "{}".into(), native("text.x").to_string(), cli_constraints(), None)
            .unwrap();
        assert!(run.error_message.unwrap().contains("MEMORY_ACCESS_DENIED: no agent context"));
        let telemetry = std::fs::read_to_string(rotifer.join("telemetry.jsonl")).unwrap();
        assert_eq!(telemetry.lines().count(), telemetry_before + 1);
        let event: serde_json::Value = serde_json::from_str(telemetry.lines().last().unwrap()).unwrap();
        assert!(event["metadata"]["agentId"].is_null());
        let audit_after = std::fs::read_to_string(rotifer.join("audit.jsonl")).unwrap();
        assert!(
            !audit_after[audit_before.len()..].contains("agent_memory"),
            "a run outside an agent wrote a memory audit line"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_data_policy_retention_is_set_through_the_binding() {
        // Entries without their own retentionPolicy expire by
        // it. Expiry itself is tested in rotifer-core with an injected clock.
        let (b, dir) = binding_in();
        assert!(b.memory_set_data_policy_retention(AGENT.into(), Some(1.0)).unwrap_err().reason.starts_with("MEMORY_NOT_FOUND: "));
        b.memory_create(AGENT.into(), None).unwrap();
        b.memory_set_data_policy_retention(AGENT.into(), Some(30.0)).unwrap();
        b.memory_set_data_policy_retention(AGENT.into(), None).unwrap();
        for bad in [0.0, -1.0, 1.5, 2147483648.0, f64::NAN] {
            let err = b.memory_set_data_policy_retention(AGENT.into(), Some(bad)).unwrap_err();
            assert!(err.reason.starts_with("MEMORY_INVALID_INPUT: "), "{bad}: {}", err.reason);
        }
        let audit = std::fs::read_to_string(dir.join(".rotifer").join("audit.jsonl")).unwrap();
        assert_eq!(audit.lines().filter(|l| l.contains("\"action\":\"retention_changed\"")).count(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(feature = "test-clock")]
    #[test]
    fn the_test_clock_reaches_an_expiry_through_the_binding() {
        // `cargo test -p rotifer-napi --features test-clock`.
        let (b, dir) = binding_in();
        b.memory_test_set_clock(1_761_800_000_000.0).unwrap();
        let day = r#"{"maxRetentionDays":1,"autoDeleteOnTermination":false,"anonymizationSupported":false}"#;
        b.memory_write(AGENT.into(), v2(1), "text.x".into(), format!(r#"{{"key":"lang","value":"","category":"CONTEXT","retentionPolicy":{day}}}"#))
            .unwrap();
        b.memory_test_advance_clock(86_400_000.0 - 1000.0).unwrap();
        assert!(!b.memory_read(AGENT.into(), v2(1), "text.x".into(), READ_LANG.into()).unwrap().is_null());
        b.memory_test_advance_clock(1000.0).unwrap();
        assert!(b.memory_read(AGENT.into(), v2(1), "text.x".into(), READ_LANG.into()).unwrap().is_null());
        let audit = std::fs::read_to_string(dir.join(".rotifer").join("audit.jsonl")).unwrap();
        assert_eq!(audit.lines().filter(|l| l.contains("\"action\":\"expired\"")).count(), 1);
        for bad in [f64::NAN, 1.5, -1.0] {
            assert!(b.memory_test_set_clock(bad).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn retention_policy_is_validated_strictly_through_the_binding() {
        // The §30.2 shape exactly, on write and on import.
        let (b, dir) = binding_in();
        let write = |retention: &str| {
            b.memory_write(
                AGENT.into(),
                v2(1),
                "text.x".into(),
                format!(r#"{{"key":"k","value":"","category":"CONTEXT","retentionPolicy":{retention}}}"#),
            )
        };
        let full = r#"{"maxRetentionDays":7,"autoDeleteOnTermination":true,"anonymizationSupported":false}"#;
        assert_eq!(write(full).unwrap()["retentionPolicy"]["maxRetentionDays"], 7);
        for bad in [r#"{"maxRetentionDays":7}"#, r#"{"maxRetentionDays":0,"autoDeleteOnTermination":true,"anonymizationSupported":false}"#] {
            let err = write(bad).unwrap_err();
            assert!(err.reason.starts_with("MEMORY_INVALID_INPUT: "), "{bad}: {}", err.reason);
        }

        let mut bundle = b.memory_export(AGENT.into(), None).unwrap();
        bundle["entries"][0]["retentionPolicy"] = serde_json::json!({"maxRetentionDays": 7});
        let err = b.memory_import("agent-new".into(), bundle.to_string(), None).unwrap_err();
        assert!(err.reason.starts_with("MEMORY_INVALID_INPUT: "), "{}", err.reason);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
