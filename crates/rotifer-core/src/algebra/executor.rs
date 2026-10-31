use std::collections::HashMap;

use super::{AlgebraExpr, MergeStrategy};
use crate::sandbox::{Sandbox, SandboxError, FUEL_EXHAUSTED_MESSAGE, TIMEOUT_MESSAGE_PREFIX};
use crate::types::gene::Gene;
use crate::types::{Context, ErrorCode, ExecutionMetadata, GeneId, GeneResult, PermissionSet};

/// An evaluation result plus the gene a failure came from (see `eval`).
type Evaluated = Result<(GeneResult, Option<GeneId>), (SandboxError, Option<GeneId>)>;

/// The `errorCode` a TryCatch handler receives for a sandbox-level failure.
/// Fuel exhaustion is `FUEL_EXHAUSTED` (spec §34 E-FUEL-EXHAUSTED); the rest
/// use the §4 `ErrorCode` names. None of them is collapsed into
/// `INTERNAL_ERROR`.
pub fn sandbox_error_code(err: &SandboxError) -> &'static str {
    match err {
        SandboxError::ResourceLimitExceeded(m) if m == FUEL_EXHAUSTED_MESSAGE => "FUEL_EXHAUSTED",
        SandboxError::ResourceLimitExceeded(m) if m.starts_with(TIMEOUT_MESSAGE_PREFIX) => "TIMEOUT",
        SandboxError::ResourceLimitExceeded(_) => "RESOURCE_EXHAUSTED",
        SandboxError::ConstraintViolation(_) => "SANDBOX_VIOLATION",
        SandboxError::ExecutionFailed(_)
        | SandboxError::CompilationFailed(_)
        | SandboxError::InvalidWasm(_) => "EXECUTION_FAILURE",
    }
}

/// Evaluates [`AlgebraExpr`] trees by dispatching genes to a [`Sandbox`].
///
/// `Par` branches run with true thread-level parallelism via `std::thread::scope`.
pub struct AlgebraExecutor<'a> {
    sandbox: &'a dyn Sandbox,
    gene_store: &'a HashMap<GeneId, Gene>,
    /// v2 gene ID (`v2:` + 64 hex) of each gene in `gene_store`, keyed by the
    /// store's own ID. Reported as `geneId` in the `GeneError` a TryCatch
    /// handler receives; a gene missing here is reported with `geneId: null`.
    gene_ids: HashMap<GeneId, String>,
    /// Run each gene with the permissions its own phenotype declares
    /// (`PermissionSet::declared_by`) instead of the caller's context.
    declared_permissions: bool,
}

impl<'a> AlgebraExecutor<'a> {
    /// Create an executor bound to a sandbox and a gene lookup table.
    pub fn new(sandbox: &'a dyn Sandbox, gene_store: &'a HashMap<GeneId, Gene>) -> Self {
        Self {
            sandbox,
            gene_store,
            gene_ids: HashMap::new(),
            declared_permissions: false,
        }
    }

    /// Supply the v2 ID of the genes in the store. The store's keys are
    /// whatever the caller chose (the CLI uses a hash of the gene's local
    /// name); §15.2 `GeneError.geneId` must name the gene that actually ran.
    pub fn with_gene_ids(mut self, gene_ids: HashMap<GeneId, String>) -> Self {
        self.gene_ids = gene_ids;
        self
    }

    /// Give every gene the permissions its own phenotype declares, and no
    /// others, in place of the caller's `context.permissions`. Genes in one
    /// composition declare different things — a Hybrid gene may reach the
    /// network while the Native gene beside it may not — so one shared
    /// permission set cannot be right for all of them. For a binding with
    /// no deployer policy of its own (the CLI).
    pub fn with_declared_permissions(mut self) -> Self {
        self.declared_permissions = true;
        self
    }

    /// Recursively evaluate an algebra expression tree.
    pub fn execute(
        &self,
        expr: &AlgebraExpr,
        context: &Context,
        input: serde_json::Value,
    ) -> Result<GeneResult, SandboxError> {
        self.eval(expr, context, input)
            .map(|(result, _)| result)
            .map_err(|(err, _)| err)
    }

    /// `execute`, also reporting which gene a failure came from: `Some(id)`
    /// when a gene returned an error or failed in the sandbox, `None` on
    /// success or when the failure is the composition's own (Par Majority).
    fn eval(&self, expr: &AlgebraExpr, context: &Context, input: serde_json::Value) -> Evaluated {
        match expr {
            AlgebraExpr::Gene(id) => self.eval_gene(id, context, input),

            AlgebraExpr::Seq(steps) => self.execute_seq(steps, context, input),

            AlgebraExpr::Par {
                branches,
                merge,
                deadline,
            } => self.execute_par(branches, merge, deadline, context, input),

            AlgebraExpr::Cond {
                predicate,
                then_branch,
                else_branch,
            } => {
                if predicate.evaluate(&input) {
                    self.eval(then_branch, context, input)
                } else {
                    self.eval(else_branch, context, input)
                }
            }

            // §34 E-TRYCATCH: the handler receives
            // `{ error: GeneError, original_input }`, GeneError per §15.2.
            AlgebraExpr::Try { primary, fallback } => {
                let error = match self.eval(primary, context, input.clone()) {
                    ok @ Ok((GeneResult::Success { .. }, _)) => return ok,
                    Ok((GeneResult::Error { code, message, retryable, details }, failed)) => {
                        self.gene_error(failed, &code.to_string(), message, retryable, details)
                    }
                    // Keep the sandbox's own code (FUEL_EXHAUSTED, TIMEOUT, …):
                    // §34 Theorem 34.4 — the error reaches the handler, not lost.
                    Err((err, failed)) => {
                        self.gene_error(failed, sandbox_error_code(&err), err.to_string(), false, None)
                    }
                };
                let handler_input = serde_json::json!({
                    "error": error,
                    "original_input": input,
                });
                self.eval(fallback, context, handler_input)
            }

            AlgebraExpr::Transform { inner, mapper } => {
                match self.eval(inner, context, input)? {
                    (GeneResult::Success { data, .. }, _) => self.eval_gene(mapper, context, data),
                    err => Ok(err),
                }
            }
        }
    }

    /// §15.2 `GeneError { geneId, errorCode, message, context? }`. `geneId` is
    /// the failed gene's v2 ID, or null when the caller did not supply one —
    /// never the store's internal key.
    fn gene_error(
        &self,
        failed: Option<GeneId>,
        error_code: &str,
        message: String,
        retryable: bool,
        details: Option<serde_json::Value>,
    ) -> serde_json::Value {
        serde_json::json!({
            "geneId": failed.and_then(|id| self.gene_ids.get(&id).cloned()),
            "errorCode": error_code,
            "message": message,
            "context": { "retryable": retryable, "details": details },
        })
    }

    fn eval_gene(&self, gene_id: &GeneId, context: &Context, input: serde_json::Value) -> Evaluated {
        match self.execute_gene(gene_id, context, input) {
            Ok(result @ GeneResult::Success { .. }) => Ok((result, None)),
            Ok(result) => Ok((result, Some(*gene_id))),
            Err(err) => Err((err, Some(*gene_id))),
        }
    }

    fn execute_gene(
        &self,
        gene_id: &GeneId,
        context: &Context,
        input: serde_json::Value,
    ) -> Result<GeneResult, SandboxError> {
        let gene = self.gene_store.get(gene_id).ok_or_else(|| {
            SandboxError::ExecutionFailed(format!(
                "gene not found: {}",
                hex::encode(gene_id)
            ))
        })?;

        // The running gene's content-derived id travels with its context, so
        // its AgentMemory calls record it as createdBy / lastAccessedBy
        // (§38.2). Whatever id the incoming context carried is removed first:
        // a gene without an id of its own is denied memory, never run as
        // whichever gene the context named.
        let mut extensions = context.binding_extensions.clone().unwrap_or_default();
        extensions.remove(crate::sandbox::CALLER_GENE_ID_EXTENSION);
        if let Some(v2) = self.gene_ids.get(gene_id) {
            extensions.insert(
                crate::sandbox::CALLER_GENE_ID_EXTENSION.to_string(),
                serde_json::Value::String(v2.clone()),
            );
        }
        let with_caller = Context {
            binding_extensions: (!extensions.is_empty()).then_some(extensions),
            ..context.clone()
        };
        let context = &with_caller;

        match &gene.wasm_bytes {
            // execute_gated, not execute: a gene running as one step of a genome must
            // clear the same L0 gate it clears when run on its own. Using the ungated
            // path here meant any gene wrapped in Seq / Par / Cond / Try / Transform
            // had its domain allowlist and resource caps go unchecked — and genome
            // composition is the protocol's headline usage.
            Some(bytes) if self.declared_permissions => {
                let context = Context {
                    permissions: PermissionSet::declared_by(&gene.phenotype),
                    ..context.clone()
                };
                self.sandbox
                    .execute_gated(bytes, &context, input, &gene.phenotype)
            }
            Some(bytes) => self
                .sandbox
                .execute_gated(bytes, context, input, &gene.phenotype),
            None => Ok(GeneResult::Error {
                code: ErrorCode::ExecutionFailure,
                message: "gene has no wasm bytes".to_string(),
                retryable: false,
                details: None,
            }),
        }
    }

    fn execute_seq(
        &self,
        steps: &[AlgebraExpr],
        context: &Context,
        mut current_input: serde_json::Value,
    ) -> Evaluated {
        let start = std::time::Instant::now();
        let mut total_cost = 0.0;

        for step in steps {
            match self.eval(step, context, current_input)? {
                (GeneResult::Success { data, metadata }, _) => {
                    total_cost += metadata.resource_cost;
                    current_input = data;
                }
                err => return Ok(err),
            }
        }

        Ok((GeneResult::Success {
            data: current_input,
            metadata: ExecutionMetadata {
                duration_ms: start.elapsed().as_millis() as u64,
                resource_cost: total_cost,
                cache_hit: None,
                host: None,
            },
        }, None))
    }

    fn execute_par(
        &self,
        branches: &[AlgebraExpr],
        merge: &MergeStrategy,
        _deadline: &Option<u64>,
        context: &Context,
        input: serde_json::Value,
    ) -> Evaluated {
        let start = std::time::Instant::now();

        let results: Vec<Evaluated> = if branches.len() <= 1 {
            branches
                .iter()
                .map(|b| self.eval(b, context, input.clone()))
                .collect()
        } else {
            std::thread::scope(|s| {
                let handles: Vec<_> = branches
                    .iter()
                    .map(|branch| {
                        let input_clone = input.clone();
                        s.spawn(move || self.eval(branch, context, input_clone))
                    })
                    .collect();

                handles
                    .into_iter()
                    .map(|h| h.join().expect("branch thread panicked"))
                    .collect()
            })
        };

        let mut total_cost = 0.0;

        let merged = match merge {
            MergeStrategy::WaitAll => {
                let mut merged_data = serde_json::Map::new();
                for (i, result) in results.into_iter().enumerate() {
                    match result? {
                        (GeneResult::Success { data, metadata }, _) => {
                            total_cost += metadata.resource_cost;
                            merged_data.insert(format!("branch_{i}"), data);
                        }
                        err => return Ok(err),
                    }
                }
                serde_json::Value::Object(merged_data)
            }
            MergeStrategy::FirstSuccess => {
                let mut first_success = None;
                for result in results {
                    match result?.0 {
                        GeneResult::Success { data, metadata } => {
                            total_cost += metadata.resource_cost;
                            first_success = Some(data);
                            break;
                        }
                        GeneResult::Error { .. } => continue,
                    }
                }
                first_success.unwrap_or(serde_json::Value::Null)
            }
            MergeStrategy::Majority => {
                let total = branches.len();
                let mut successes: Vec<serde_json::Value> = Vec::new();
                for result in results {
                    match result?.0 {
                        GeneResult::Success { data, metadata } => {
                            total_cost += metadata.resource_cost;
                            successes.push(data);
                        }
                        GeneResult::Error { .. } => {}
                    }
                }

                if successes.len() > total / 2 {
                    successes
                        .into_iter()
                        .next()
                        .unwrap_or(serde_json::Value::Null)
                } else {
                    return Ok((GeneResult::Error {
                        code: ErrorCode::ExecutionFailure,
                        message: "majority of branches failed".to_string(),
                        retryable: false,
                        details: None,
                    }, None));
                }
            }
        };

        Ok((GeneResult::Success {
            data: merged,
            metadata: ExecutionMetadata {
                duration_ms: start.elapsed().as_millis() as u64,
                resource_cost: total_cost,
                cache_hit: None,
                host: None,
            },
        }, None))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sandbox::ConstraintSet;
    use crate::types::{Context, PermissionSet};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A mock sandbox that counts executions and returns configurable results.
    struct MockSandbox {
        call_count: AtomicU32,
        should_fail: bool,
    }

    impl MockSandbox {
        fn succeeding() -> Self {
            Self {
                call_count: AtomicU32::new(0),
                should_fail: false,
            }
        }

        fn calls(&self) -> u32 {
            self.call_count.load(Ordering::SeqCst)
        }
    }

    impl Sandbox for MockSandbox {
        fn constraints(&self) -> &ConstraintSet {
            static C: std::sync::OnceLock<ConstraintSet> = std::sync::OnceLock::new();
            C.get_or_init(ConstraintSet::default)
        }

        fn execute(
            &self,
            _wasm_bytes: &[u8],
            _context: &Context,
            input: serde_json::Value,
        ) -> Result<GeneResult, SandboxError> {
            self.call_count.fetch_add(1, Ordering::SeqCst);
            if self.should_fail {
                Ok(GeneResult::Error {
                    code: ErrorCode::ExecutionFailure,
                    message: "mock failure".into(),
                    retryable: false,
                    details: None,
                })
            } else {
                Ok(GeneResult::Success {
                    data: input,
                    metadata: ExecutionMetadata {
                        duration_ms: 1,
                        resource_cost: 10.0,
                        cache_hit: None,
                        host: None,
                    },
                })
            }
        }

        fn validate(&self, _: &[u8], _: &ConstraintSet) -> Result<bool, SandboxError> {
            Ok(true)
        }
    }

    fn test_context() -> Context {
        Context {
            agent_id: "test".into(),
            timestamp: 1000,
            permissions: PermissionSet::default(),
            trace_id: None,
            binding_extensions: None,
        }
    }

    fn make_gene(id_byte: u8) -> (GeneId, Gene) {
        use crate::types::gene::{Fidelity, GeneTransparency, Phenotype};
        let mut gene_id = [0u8; 32];
        gene_id[0] = id_byte;
        let gene = Gene {
            id: gene_id,
            phenotype: Phenotype {
                domain: "test".into(),
                input_schema: serde_json::json!({}),
                output_schema: serde_json::json!({}),
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
            },
            wasm_bytes: Some(vec![0]),
            source_code: None,
        };
        (gene_id, gene)
    }

    // ── L0 门控覆盖（回归：Genome 编排曾整条绕过门控）──

    fn ctx_allowing(domain: &str) -> Context {
        Context {
            permissions: PermissionSet {
                allowed_domains: Some(vec![domain.into()]),
                ..Default::default()
            },
            ..test_context()
        }
    }

    #[test]
    fn genome_step_clears_the_same_l0_gate_as_a_direct_run() {
        // make_gene 的 domain 是 "test"；只放行 "allowed" 时它必须被拦下——
        // 单独执行如此，包进 Seq 也必须如此。回归点：execute_gene 曾调用裸
        // execute()，于是任何基因只要被包进算子就不再过门控。
        let sandbox = MockSandbox::succeeding();
        let (id, gene) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id, gene)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);
        let ctx = ctx_allowing("allowed");

        let direct = exec.execute(&AlgebraExpr::Gene(id), &ctx, serde_json::json!({}));
        assert!(
            matches!(direct, Err(SandboxError::ConstraintViolation(_))),
            "单独执行必须被 L0 拦下，实际: {direct:?}"
        );

        let wrapped = exec.execute(
            &AlgebraExpr::Seq(vec![AlgebraExpr::Gene(id)]),
            &ctx,
            serde_json::json!({}),
        );
        assert!(
            matches!(wrapped, Err(SandboxError::ConstraintViolation(_))),
            "包进 Seq 后同样必须被拦下，实际: {wrapped:?}"
        );

        assert_eq!(sandbox.calls(), 0, "被门控拦下的基因不应进入沙箱");
    }

    #[test]
    fn l0_gate_blocks_every_composition_operator() {
        // 门控不能只覆盖 Seq——Par / Cond / Try / Transform 都会走 execute_gene。
        let sandbox = MockSandbox::succeeding();
        let (id, gene) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id, gene)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);
        let ctx = ctx_allowing("allowed");
        let leaf = || Box::new(AlgebraExpr::Gene(id));

        let exprs = vec![
            (
                "Par",
                AlgebraExpr::Par {
                    branches: vec![AlgebraExpr::Gene(id)],
                    merge: MergeStrategy::WaitAll,
                    deadline: None,
                },
            ),
            (
                "Try",
                AlgebraExpr::Try {
                    primary: leaf(),
                    fallback: leaf(),
                },
            ),
            (
                "Transform",
                AlgebraExpr::Transform {
                    inner: leaf(),
                    mapper: id,
                },
            ),
        ];

        for (name, expr) in exprs {
            let r = exec.execute(&expr, &ctx, serde_json::json!({}));
            let blocked = match &r {
                Err(SandboxError::ConstraintViolation(_)) => true,
                // Par / Try 把分支错误收进 GeneResult::Error 而非向上抛
                Ok(GeneResult::Error { message, .. }) => message.contains("L0 gate blocked"),
                _ => false,
            };
            assert!(blocked, "{name} 未被 L0 拦下，实际: {r:?}");
        }

        assert_eq!(sandbox.calls(), 0, "没有任何算子应把被拦基因送进沙箱");
    }

    #[test]
    fn l0_gate_does_not_over_block_a_permitted_domain() {
        // 控制项：域在白名单内时必须照常执行，证明上面的拦截不是无差别拒绝。
        let sandbox = MockSandbox::succeeding();
        let (id, gene) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id, gene)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);
        let ctx = ctx_allowing("test"); // make_gene 的 domain

        let r = exec.execute(
            &AlgebraExpr::Seq(vec![AlgebraExpr::Gene(id)]),
            &ctx,
            serde_json::json!({}),
        );
        assert!(matches!(r, Ok(GeneResult::Success { .. })), "不应误拦，实际: {r:?}");
        assert_eq!(sandbox.calls(), 1, "放行的基因应正常进入沙箱一次");
    }

    // ── T0: Try bug fix tests ──

    #[test]
    fn try_success_executes_primary_once() {
        let sandbox = MockSandbox::succeeding();
        let (id, gene) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let store: HashMap<GeneId, Gene> =
            [(id, gene), (id2, gene2)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Try {
            primary: Box::new(AlgebraExpr::Gene(id)),
            fallback: Box::new(AlgebraExpr::Gene(id2)),
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({"x": 1}));
        assert!(result.is_ok());
        match result.unwrap() {
            GeneResult::Success { .. } => {}
            _ => panic!("expected success"),
        }
        assert_eq!(sandbox.calls(), 1, "primary should execute exactly once on success");
    }

    #[test]
    fn try_failure_uses_fallback() {
        let success_sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);

        // We need a sandbox that fails for gene1 and succeeds for gene2.
        // Since our mock doesn't distinguish, use a gene without wasm_bytes for primary.
        let mut no_wasm_gene = gene1.clone();
        no_wasm_gene.wasm_bytes = None;

        let store: HashMap<GeneId, Gene> = [
            (id1, no_wasm_gene),
            (id2, gene2),
        ].into_iter().collect();

        let exec = AlgebraExecutor::new(&success_sandbox, &store);

        let expr = AlgebraExpr::Try {
            primary: Box::new(AlgebraExpr::Gene(id1)),
            fallback: Box::new(AlgebraExpr::Gene(id2)),
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({"x": 1})).unwrap();
        match result {
            GeneResult::Success { .. } => {}
            GeneResult::Error { message, .. } => panic!("expected fallback success, got error: {message}"),
        }
        assert_eq!(success_sandbox.calls(), 1, "only fallback should execute");
    }

    #[test]
    fn try_fallback_receives_error_and_original_input() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);

        let mut no_wasm_gene = gene1.clone();
        no_wasm_gene.wasm_bytes = None;

        let store: HashMap<GeneId, Gene> = [
            (id1, no_wasm_gene),
            (id2, gene2),
        ].into_iter().collect();

        let exec = AlgebraExecutor::new(&sandbox, &store);
        let original = serde_json::json!({"question": "hello"});

        let expr = AlgebraExpr::Try {
            primary: Box::new(AlgebraExpr::Gene(id1)),
            fallback: Box::new(AlgebraExpr::Gene(id2)),
        };

        let result = exec.execute(&expr, &test_context(), original.clone()).unwrap();
        match result {
            GeneResult::Success { data, .. } => {
                assert!(data.get("error").is_some(), "fallback input should contain 'error'");
                assert_eq!(data["original_input"], original, "should pass original_input");
                // §15.2 GeneError field name (was `code` before the TryCatch payload followed §34).
                assert!(data["error"]["errorCode"].is_string(), "error should have errorCode");
                assert!(data["error"]["message"].is_string(), "error should have message");
            }
            _ => panic!("expected fallback success with error+original_input"),
        }
    }

    // ── T4: Par parallelism tests ──

    #[test]
    fn par_wait_all_collects_all_branches() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let (id3, gene3) = make_gene(3);
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2), (id3, gene3),
        ].into_iter().collect();

        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Par {
            branches: vec![
                AlgebraExpr::Gene(id1),
                AlgebraExpr::Gene(id2),
                AlgebraExpr::Gene(id3),
            ],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({"v": 1})).unwrap();
        match result {
            GeneResult::Success { data, .. } => {
                let obj = data.as_object().unwrap();
                assert_eq!(obj.len(), 3, "WaitAll should produce 3 branches");
                assert!(obj.contains_key("branch_0"));
                assert!(obj.contains_key("branch_1"));
                assert!(obj.contains_key("branch_2"));
            }
            _ => panic!("expected success"),
        }
        assert_eq!(sandbox.calls(), 3);
    }

    #[test]
    fn par_wait_all_fails_on_any_error() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, mut gene2) = make_gene(2);
        gene2.wasm_bytes = None; // This will produce an Error result
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2),
        ].into_iter().collect();

        let exec = AlgebraExecutor::new(&sandbox, &store);
        let expr = AlgebraExpr::Par {
            branches: vec![AlgebraExpr::Gene(id1), AlgebraExpr::Gene(id2)],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        assert!(matches!(result, GeneResult::Error { .. }), "WaitAll should fail if any branch errors");
    }

    #[test]
    fn par_first_success_picks_first() {
        let sandbox = MockSandbox::succeeding();
        let (id1, mut gene1) = make_gene(1);
        gene1.wasm_bytes = None; // fail
        let (id2, gene2) = make_gene(2); // succeed
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2),
        ].into_iter().collect();

        let exec = AlgebraExecutor::new(&sandbox, &store);
        let expr = AlgebraExpr::Par {
            branches: vec![AlgebraExpr::Gene(id1), AlgebraExpr::Gene(id2)],
            merge: MergeStrategy::FirstSuccess,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({"ok": true})).unwrap();
        match result {
            GeneResult::Success { data, .. } => {
                assert_eq!(data, serde_json::json!({"ok": true}));
            }
            _ => panic!("expected success from second branch"),
        }
    }

    #[test]
    fn par_majority_requires_over_half() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, mut gene2) = make_gene(2);
        gene2.wasm_bytes = None;
        let (id3, mut gene3) = make_gene(3);
        gene3.wasm_bytes = None;
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2), (id3, gene3),
        ].into_iter().collect();

        let exec = AlgebraExecutor::new(&sandbox, &store);
        let expr = AlgebraExpr::Par {
            branches: vec![
                AlgebraExpr::Gene(id1),
                AlgebraExpr::Gene(id2),
                AlgebraExpr::Gene(id3),
            ],
            merge: MergeStrategy::Majority,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        assert!(
            matches!(result, GeneResult::Error { .. }),
            "majority (1/3) should fail"
        );
    }

    #[test]
    fn par_majority_succeeds_with_over_half() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let (id3, mut gene3) = make_gene(3);
        gene3.wasm_bytes = None;
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2), (id3, gene3),
        ].into_iter().collect();

        let exec = AlgebraExecutor::new(&sandbox, &store);
        let expr = AlgebraExpr::Par {
            branches: vec![
                AlgebraExpr::Gene(id1),
                AlgebraExpr::Gene(id2),
                AlgebraExpr::Gene(id3),
            ],
            merge: MergeStrategy::Majority,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        assert!(
            matches!(result, GeneResult::Success { .. }),
            "majority (2/3) should succeed"
        );
    }

    // ── Edge: gene not found ──

    #[test]
    fn execute_missing_gene_returns_error() {
        let sandbox = MockSandbox::succeeding();
        let store: HashMap<GeneId, Gene> = HashMap::new();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let missing_id = [99u8; 32];
        let expr = AlgebraExpr::Gene(missing_id);

        let result = exec.execute(&expr, &test_context(), serde_json::json!({}));
        assert!(result.is_err(), "missing gene should return SandboxError");
    }

    // ── Seq edge: empty sequence ──

    #[test]
    fn seq_empty_returns_input() {
        let sandbox = MockSandbox::succeeding();
        let store: HashMap<GeneId, Gene> = HashMap::new();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Seq(vec![]);
        let input = serde_json::json!({"pass": "through"});
        let result = exec.execute(&expr, &test_context(), input.clone()).unwrap();
        match result {
            GeneResult::Success { data, .. } => assert_eq!(data, input),
            _ => panic!("empty seq should return input"),
        }
    }

    // ── Additional edge case tests ──

    #[test]
    fn seq_mid_sequence_error_stops_execution() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, mut gene2) = make_gene(2);
        gene2.wasm_bytes = None; // will produce Error
        let (id3, gene3) = make_gene(3);
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2), (id3, gene3),
        ].into_iter().collect();

        let exec = AlgebraExecutor::new(&sandbox, &store);
        let expr = AlgebraExpr::Seq(vec![
            AlgebraExpr::Gene(id1),
            AlgebraExpr::Gene(id2),
            AlgebraExpr::Gene(id3),
        ]);

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        assert!(matches!(result, GeneResult::Error { .. }), "error mid-seq should halt");
        assert_eq!(sandbox.calls(), 1, "gene3 should not execute after gene2 errors");
    }

    #[test]
    fn seq_chains_output_to_next_input() {
        struct TransformSandbox;
        impl Sandbox for TransformSandbox {
            fn constraints(&self) -> &ConstraintSet {
                static C: std::sync::OnceLock<ConstraintSet> = std::sync::OnceLock::new();
                C.get_or_init(ConstraintSet::default)
            }

            fn execute(
                &self, _: &[u8], _: &Context, input: serde_json::Value,
            ) -> Result<GeneResult, SandboxError> {
                let n = input.get("n").and_then(|v| v.as_i64()).unwrap_or(0);
                Ok(GeneResult::Success {
                    data: serde_json::json!({"n": n + 1}),
                    metadata: ExecutionMetadata { duration_ms: 0, resource_cost: 0.0, cache_hit: None, host: None },
                })
            }
            fn validate(&self, _: &[u8], _: &ConstraintSet) -> Result<bool, SandboxError> { Ok(true) }
        }

        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let store: HashMap<GeneId, Gene> = [(id1, gene1), (id2, gene2)].into_iter().collect();
        let exec = AlgebraExecutor::new(&TransformSandbox, &store);

        let expr = AlgebraExpr::Seq(vec![AlgebraExpr::Gene(id1), AlgebraExpr::Gene(id2)]);
        let result = exec.execute(&expr, &test_context(), serde_json::json!({"n": 0})).unwrap();
        match result {
            GeneResult::Success { data, .. } => assert_eq!(data, serde_json::json!({"n": 2})),
            _ => panic!("expected success"),
        }
    }

    #[test]
    fn cond_true_takes_then_branch() {
        use crate::algebra::{Predicate, CompareOp};
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let store: HashMap<GeneId, Gene> = [(id1, gene1), (id2, gene2)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Cond {
            predicate: Predicate { field: "x".into(), op: CompareOp::Eq, value: serde_json::json!(1) },
            then_branch: Box::new(AlgebraExpr::Gene(id1)),
            else_branch: Box::new(AlgebraExpr::Gene(id2)),
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({"x": 1})).unwrap();
        assert!(matches!(result, GeneResult::Success { .. }));
        assert_eq!(sandbox.calls(), 1);
    }

    #[test]
    fn cond_false_takes_else_branch() {
        use crate::algebra::{Predicate, CompareOp};
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let store: HashMap<GeneId, Gene> = [(id1, gene1), (id2, gene2)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Cond {
            predicate: Predicate { field: "x".into(), op: CompareOp::Eq, value: serde_json::json!(1) },
            then_branch: Box::new(AlgebraExpr::Gene(id1)),
            else_branch: Box::new(AlgebraExpr::Gene(id2)),
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({"x": 99})).unwrap();
        assert!(matches!(result, GeneResult::Success { .. }));
        assert_eq!(sandbox.calls(), 1);
    }

    #[test]
    fn transform_inner_failure_propagates() {
        let sandbox = MockSandbox::succeeding();
        let (id1, mut gene1) = make_gene(1);
        gene1.wasm_bytes = None; // inner fails
        let (id2, gene2) = make_gene(2); // mapper
        let store: HashMap<GeneId, Gene> = [(id1, gene1), (id2, gene2)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Transform {
            inner: Box::new(AlgebraExpr::Gene(id1)),
            mapper: id2,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        assert!(matches!(result, GeneResult::Error { .. }), "inner error should propagate without calling mapper");
        assert_eq!(sandbox.calls(), 0);
    }

    #[test]
    fn transform_mapper_no_wasm() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1); // inner succeeds
        let (id2, mut gene2) = make_gene(2);
        gene2.wasm_bytes = None; // mapper fails
        let store: HashMap<GeneId, Gene> = [(id1, gene1), (id2, gene2)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Transform {
            inner: Box::new(AlgebraExpr::Gene(id1)),
            mapper: id2,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        assert!(matches!(result, GeneResult::Error { .. }), "mapper with no wasm should return error");
    }

    #[test]
    fn par_empty_branches_wait_all() {
        let sandbox = MockSandbox::succeeding();
        let store: HashMap<GeneId, Gene> = HashMap::new();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Par {
            branches: vec![],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        match result {
            GeneResult::Success { data, .. } => {
                assert!(data.as_object().unwrap().is_empty());
            }
            _ => panic!("empty par WaitAll should succeed with empty object"),
        }
    }

    #[test]
    fn par_first_success_all_fail() {
        let sandbox = MockSandbox::succeeding();
        let (id1, mut gene1) = make_gene(1);
        gene1.wasm_bytes = None;
        let (id2, mut gene2) = make_gene(2);
        gene2.wasm_bytes = None;
        let store: HashMap<GeneId, Gene> = [(id1, gene1), (id2, gene2)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Par {
            branches: vec![AlgebraExpr::Gene(id1), AlgebraExpr::Gene(id2)],
            merge: MergeStrategy::FirstSuccess,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        match result {
            GeneResult::Success { data, .. } => {
                assert_eq!(data, serde_json::Value::Null, "all-fail FirstSuccess returns Null");
            }
            _ => panic!("FirstSuccess with all failures should still return Success(Null)"),
        }
    }

    #[test]
    fn par_majority_even_branches_exactly_half() {
        // 2 out of 4: 2 > 4/2 => 2 > 2 => false => should fail
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let (id3, mut gene3) = make_gene(3);
        gene3.wasm_bytes = None;
        let (id4, mut gene4) = make_gene(4);
        gene4.wasm_bytes = None;
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2), (id3, gene3), (id4, gene4),
        ].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Par {
            branches: vec![
                AlgebraExpr::Gene(id1), AlgebraExpr::Gene(id2),
                AlgebraExpr::Gene(id3), AlgebraExpr::Gene(id4),
            ],
            merge: MergeStrategy::Majority,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        assert!(matches!(result, GeneResult::Error { .. }), "exactly half (2/4) should NOT pass majority");
    }

    #[test]
    fn par_single_branch_no_threading() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id1, gene1)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Par {
            branches: vec![AlgebraExpr::Gene(id1)],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({"v": 1})).unwrap();
        match result {
            GeneResult::Success { data, .. } => {
                assert!(data.as_object().unwrap().contains_key("branch_0"));
            }
            _ => panic!("single branch should succeed"),
        }
    }

    #[test]
    fn nested_seq_inside_par() {
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let (id3, gene3) = make_gene(3);
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2), (id3, gene3),
        ].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Par {
            branches: vec![
                AlgebraExpr::Seq(vec![AlgebraExpr::Gene(id1), AlgebraExpr::Gene(id2)]),
                AlgebraExpr::Gene(id3),
            ],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({})).unwrap();
        assert!(matches!(result, GeneResult::Success { .. }));
        assert_eq!(sandbox.calls(), 3);
    }

    #[test]
    fn nested_cond_inside_try() {
        use crate::algebra::{Predicate, CompareOp};
        let sandbox = MockSandbox::succeeding();
        let (id1, gene1) = make_gene(1);
        let (id2, gene2) = make_gene(2);
        let (id3, gene3) = make_gene(3);
        let store: HashMap<GeneId, Gene> = [
            (id1, gene1), (id2, gene2), (id3, gene3),
        ].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store);

        let expr = AlgebraExpr::Try {
            primary: Box::new(AlgebraExpr::Cond {
                predicate: Predicate { field: "ok".into(), op: CompareOp::Eq, value: serde_json::json!(true) },
                then_branch: Box::new(AlgebraExpr::Gene(id1)),
                else_branch: Box::new(AlgebraExpr::Gene(id2)),
            }),
            fallback: Box::new(AlgebraExpr::Gene(id3)),
        };

        let result = exec.execute(&expr, &test_context(), serde_json::json!({"ok": true})).unwrap();
        assert!(matches!(result, GeneResult::Success { .. }));
        assert_eq!(sandbox.calls(), 1, "should take then_branch from Cond");
    }


    // ── TryCatch handler input: spec §34 E-TRYCATCH + §15.2 GeneError ──
    //
    // The handler receives `{ error: GeneError, original_input }`, where
    // GeneError is `{ geneId, errorCode, message, context? }`. geneId is the
    // v2 ID of the gene that actually failed (not the store's internal key),
    // and errorCode is the code it failed with: a sandbox failure keeps its
    // own code — FUEL_EXHAUSTED included (§34 E-FUEL-EXHAUSTED) — instead of
    // becoming INTERNAL_ERROR (§34 Theorem 34.4: errors reach the handler).

    use crate::sandbox::{FUEL_EXHAUSTED_MESSAGE, TIMEOUT_MESSAGE_PREFIX};

    /// Outcome chosen by the gene's first wasm byte; anything else echoes its input.
    struct ScriptedSandbox;

    impl Sandbox for ScriptedSandbox {
        fn constraints(&self) -> &ConstraintSet {
            static C: std::sync::OnceLock<ConstraintSet> = std::sync::OnceLock::new();
            C.get_or_init(ConstraintSet::default)
        }

        fn execute(
            &self,
            wasm_bytes: &[u8],
            _context: &Context,
            input: serde_json::Value,
        ) -> Result<GeneResult, SandboxError> {
            match wasm_bytes.first() {
                Some(b'F') => Err(SandboxError::ResourceLimitExceeded(FUEL_EXHAUSTED_MESSAGE.into())),
                Some(b'T') => Err(SandboxError::ResourceLimitExceeded(format!(
                    "{TIMEOUT_MESSAGE_PREFIX} after 10ms"
                ))),
                Some(b'M') => Err(SandboxError::ResourceLimitExceeded("memory limit".into())),
                Some(b'V') => Err(SandboxError::ConstraintViolation("not allowed".into())),
                Some(b'X') => Err(SandboxError::ExecutionFailed("wasm trap".into())),
                Some(b'E') => Ok(GeneResult::Error {
                    code: ErrorCode::InvalidInput,
                    message: "bad input".into(),
                    retryable: true,
                    details: Some(serde_json::json!({"field": "q"})),
                }),
                _ => Ok(GeneResult::Success {
                    data: input,
                    metadata: ExecutionMetadata {
                        duration_ms: 1,
                        resource_cost: 1.0,
                        cache_hit: None,
                        host: None,
                    },
                }),
            }
        }

        fn validate(&self, _: &[u8], _: &ConstraintSet) -> Result<bool, SandboxError> {
            Ok(true)
        }
    }

    fn scripted(id_byte: u8, behaviour: u8) -> (GeneId, Gene) {
        let (id, mut gene) = make_gene(id_byte);
        gene.wasm_bytes = Some(vec![behaviour]);
        (id, gene)
    }

    fn v2(id_byte: u8) -> String {
        format!("v2:{}", hex::encode([id_byte; 32]))
    }

    /// Run `Try(body, echo)` and return what the echoing handler received.
    fn handler_input(body: AlgebraExpr, genes: Vec<(GeneId, Gene)>, with_ids: bool) -> serde_json::Value {
        let (echo_id, echo) = scripted(0xEE, b'.');
        let ids: HashMap<GeneId, String> = genes.iter().map(|(id, _)| (*id, v2(id[0]))).collect();
        let store: HashMap<GeneId, Gene> = genes.into_iter().chain([(echo_id, echo)]).collect();
        let exec = AlgebraExecutor::new(&ScriptedSandbox, &store);
        let exec = if with_ids { exec.with_gene_ids(ids) } else { exec };
        let expr = AlgebraExpr::Try {
            primary: Box::new(body),
            fallback: Box::new(AlgebraExpr::Gene(echo_id)),
        };
        match exec.execute(&expr, &test_context(), serde_json::json!({"q": "hi"})).unwrap() {
            GeneResult::Success { data, .. } => data,
            other => panic!("handler should have run and echoed its input, got {other:?}"),
        }
    }

    #[test]
    fn trycatch_handler_gets_spec_gene_error_for_a_gene_error() {
        let (id, gene) = scripted(1, b'E');
        let got = handler_input(AlgebraExpr::Gene(id), vec![(id, gene)], true);
        assert_eq!(
            got,
            serde_json::json!({
                "error": {
                    "geneId": v2(1),
                    "errorCode": "INVALID_INPUT",
                    "message": "bad input",
                    "context": {"retryable": true, "details": {"field": "q"}},
                },
                "original_input": {"q": "hi"},
            })
        );
    }

    #[test]
    fn trycatch_handler_gets_fuel_exhausted_not_internal_error() {
        let (id, gene) = scripted(1, b'F');
        let got = handler_input(AlgebraExpr::Gene(id), vec![(id, gene)], true);
        assert_eq!(got["error"]["errorCode"], "FUEL_EXHAUSTED");
        assert_eq!(got["error"]["geneId"], v2(1));
        assert!(got["error"]["message"].as_str().unwrap().contains(FUEL_EXHAUSTED_MESSAGE));
        assert_eq!(got["original_input"], serde_json::json!({"q": "hi"}));
    }

    #[test]
    fn trycatch_keeps_every_sandbox_error_code() {
        for (behaviour, code) in [
            (b'T', "TIMEOUT"),
            (b'M', "RESOURCE_EXHAUSTED"),
            (b'V', "SANDBOX_VIOLATION"),
            (b'X', "EXECUTION_FAILURE"),
        ] {
            let (id, gene) = scripted(1, behaviour);
            let got = handler_input(AlgebraExpr::Gene(id), vec![(id, gene)], true);
            assert_eq!(got["error"]["errorCode"], code, "behaviour {}", behaviour as char);
            assert_ne!(got["error"]["errorCode"], "INTERNAL_ERROR");
        }
    }

    #[test]
    fn trycatch_gene_id_names_the_gene_that_failed_inside_a_composite_body() {
        let (ok, ok_gene) = scripted(2, b'.');
        let (bad, bad_gene) = scripted(3, b'E');
        let got = handler_input(
            AlgebraExpr::Seq(vec![AlgebraExpr::Gene(ok), AlgebraExpr::Gene(bad)]),
            vec![(ok, ok_gene), (bad, bad_gene)],
            true,
        );
        assert_eq!(got["error"]["geneId"], v2(3));

        // Par: the first failing branch in declaration order, even with a
        // later branch failing in the sandbox at the same time.
        let (ok, ok_gene) = scripted(2, b'.');
        let (bad, bad_gene) = scripted(3, b'E');
        let (fuel, fuel_gene) = scripted(4, b'F');
        let got = handler_input(
            AlgebraExpr::Par {
                branches: vec![AlgebraExpr::Gene(ok), AlgebraExpr::Gene(bad), AlgebraExpr::Gene(fuel)],
                merge: MergeStrategy::WaitAll,
                deadline: None,
            },
            vec![(ok, ok_gene), (bad, bad_gene), (fuel, fuel_gene)],
            true,
        );
        assert_eq!(got["error"]["geneId"], v2(3));
        assert_eq!(got["error"]["errorCode"], "INVALID_INPUT");
    }

    #[test]
    fn trycatch_gene_id_is_null_without_a_v2_id_never_the_internal_key() {
        let (id, gene) = scripted(1, b'F');
        let got = handler_input(AlgebraExpr::Gene(id), vec![(id, gene)], false);
        assert!(got["error"]["geneId"].is_null(), "got {}", got["error"]["geneId"]);
        assert_eq!(got["error"]["errorCode"], "FUEL_EXHAUSTED");
    }

    /// Real fuel exhaustion: wasmtime runs a committed compiled gene under the
    /// default budget (1M fuel; the L0 gate admits it), which evolve-life
    /// exceeds. The handler (an echo, not wasm) must receive FUEL_EXHAUSTED
    /// for that gene.
    #[test]
    fn trycatch_handler_gets_fuel_exhausted_from_the_real_sandbox() {
        struct RealThenEcho(crate::sandbox::WasmtimeSandbox);

        impl Sandbox for RealThenEcho {
            fn constraints(&self) -> &ConstraintSet {
                self.0.constraints()
            }
            fn execute(
                &self,
                wasm_bytes: &[u8],
                context: &Context,
                input: serde_json::Value,
            ) -> Result<GeneResult, SandboxError> {
                if wasm_bytes.starts_with(b"\0asm") {
                    self.0.execute(wasm_bytes, context, input)
                } else {
                    ScriptedSandbox.execute(wasm_bytes, context, input)
                }
            }
            fn validate(&self, b: &[u8], c: &ConstraintSet) -> Result<bool, SandboxError> {
                self.0.validate(b, c)
            }
        }

        let wasm = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../genes/evolve-life/gene.ir.wasm"))
            .expect("committed fixture genes/evolve-life/gene.ir.wasm");
        let sandbox = RealThenEcho(
            crate::sandbox::WasmtimeSandbox::new(ConstraintSet::default()).unwrap(),
        );
        let (id, mut gene) = make_gene(1);
        gene.wasm_bytes = Some(wasm);
        let (echo_id, echo) = scripted(0xEE, b'.');
        let store: HashMap<GeneId, Gene> = [(id, gene), (echo_id, echo)].into_iter().collect();
        let exec = AlgebraExecutor::new(&sandbox, &store).with_gene_ids([(id, v2(1))].into_iter().collect());
        let expr = AlgebraExpr::Try {
            primary: Box::new(AlgebraExpr::Gene(id)),
            fallback: Box::new(AlgebraExpr::Gene(echo_id)),
        };
        let got = match exec.execute(&expr, &test_context(), serde_json::json!({"width": 8})).unwrap() {
            GeneResult::Success { data, .. } => data,
            other => panic!("handler should have run, got {other:?}"),
        };
        assert_eq!(got["error"]["errorCode"], "FUEL_EXHAUSTED", "got {got}");
        assert_eq!(got["error"]["geneId"], v2(1));
    }
}
