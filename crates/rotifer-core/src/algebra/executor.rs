use std::collections::HashMap;

use super::{AlgebraExpr, MergeStrategy};
use crate::sandbox::{Sandbox, SandboxError};
use crate::types::gene::Gene;
use crate::types::{Context, ErrorCode, ExecutionMetadata, GeneId, GeneResult};

/// Evaluates [`AlgebraExpr`] trees by dispatching genes to a [`Sandbox`].
///
/// `Par` branches run with true thread-level parallelism via `std::thread::scope`.
pub struct AlgebraExecutor<'a> {
    sandbox: &'a dyn Sandbox,
    gene_store: &'a HashMap<GeneId, Gene>,
}

impl<'a> AlgebraExecutor<'a> {
    /// Create an executor bound to a sandbox and a gene lookup table.
    pub fn new(sandbox: &'a dyn Sandbox, gene_store: &'a HashMap<GeneId, Gene>) -> Self {
        Self {
            sandbox,
            gene_store,
        }
    }

    /// Recursively evaluate an algebra expression tree.
    pub fn execute(
        &self,
        expr: &AlgebraExpr,
        context: &Context,
        input: serde_json::Value,
    ) -> Result<GeneResult, SandboxError> {
        match expr {
            AlgebraExpr::Gene(id) => self.execute_gene(id, context, input),

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
                    self.execute(then_branch, context, input)
                } else {
                    self.execute(else_branch, context, input)
                }
            }

            AlgebraExpr::Try { primary, fallback } => {
                match self.execute(primary, context, input.clone()) {
                    ok @ Ok(GeneResult::Success { .. }) => ok,
                    _ => self.execute(fallback, context, input),
                }
            }

            AlgebraExpr::Transform { inner, mapper } => {
                let inner_result = self.execute(inner, context, input)?;
                match inner_result {
                    GeneResult::Success { data, .. } => {
                        self.execute_gene(mapper, context, data)
                    }
                    err => Ok(err),
                }
            }
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

        match &gene.wasm_bytes {
            Some(bytes) => self.sandbox.execute(bytes, context, input),
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
    ) -> Result<GeneResult, SandboxError> {
        let start = std::time::Instant::now();
        let mut total_cost = 0.0;

        for step in steps {
            let result = self.execute(step, context, current_input)?;
            match result {
                GeneResult::Success { data, metadata } => {
                    total_cost += metadata.resource_cost;
                    current_input = data;
                }
                err @ GeneResult::Error { .. } => return Ok(err),
            }
        }

        Ok(GeneResult::Success {
            data: current_input,
            metadata: ExecutionMetadata {
                duration_ms: start.elapsed().as_millis() as u64,
                resource_cost: total_cost,
                cache_hit: None,
            },
        })
    }

    fn execute_par(
        &self,
        branches: &[AlgebraExpr],
        merge: &MergeStrategy,
        _deadline: &Option<u64>,
        context: &Context,
        input: serde_json::Value,
    ) -> Result<GeneResult, SandboxError> {
        let start = std::time::Instant::now();

        let results: Vec<Result<GeneResult, SandboxError>> = if branches.len() <= 1 {
            branches
                .iter()
                .map(|b| self.execute(b, context, input.clone()))
                .collect()
        } else {
            std::thread::scope(|s| {
                let handles: Vec<_> = branches
                    .iter()
                    .map(|branch| {
                        let input_clone = input.clone();
                        s.spawn(move || self.execute(branch, context, input_clone))
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
                        GeneResult::Success { data, metadata } => {
                            total_cost += metadata.resource_cost;
                            merged_data.insert(format!("branch_{i}"), data);
                        }
                        err @ GeneResult::Error { .. } => return Ok(err),
                    }
                }
                serde_json::Value::Object(merged_data)
            }
            MergeStrategy::FirstSuccess => {
                let mut first_success = None;
                for result in results {
                    match result? {
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
                    match result? {
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
                    return Ok(GeneResult::Error {
                        code: ErrorCode::ExecutionFailure,
                        message: "majority of branches failed".to_string(),
                        retryable: false,
                        details: None,
                    });
                }
            }
        };

        Ok(GeneResult::Success {
            data: merged,
            metadata: ExecutionMetadata {
                duration_ms: start.elapsed().as_millis() as u64,
                resource_cost: total_cost,
                cache_hit: None,
            },
        })
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
            llm_requirements: None,
            guard_config: None,
            },
            wasm_bytes: Some(vec![0]),
            source_code: None,
        };
        (gene_id, gene)
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
            fn execute(
                &self, _: &[u8], _: &Context, input: serde_json::Value,
            ) -> Result<GeneResult, SandboxError> {
                let n = input.get("n").and_then(|v| v.as_i64()).unwrap_or(0);
                Ok(GeneResult::Success {
                    data: serde_json::json!({"n": n + 1}),
                    metadata: ExecutionMetadata { duration_ms: 0, resource_cost: 0.0, cache_hit: None },
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
}
