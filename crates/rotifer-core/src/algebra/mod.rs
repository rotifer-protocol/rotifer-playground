//! Gene Composition Algebra — combinators for composing genes into pipelines.

mod executor;
mod type_check;

pub use executor::AlgebraExecutor;
pub use type_check::check_composition;

use crate::types::GeneId;
use serde::{Deserialize, Serialize};

/// Gene Composition Algebra
/// MVP implements Seq, Par (with deadline), and Cond.
/// Try and Transform are planned.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AlgebraExpr {
    Gene(GeneId),
    Seq(Vec<AlgebraExpr>),
    Par {
        branches: Vec<AlgebraExpr>,
        merge: MergeStrategy,
        deadline: Option<u64>,
    },
    Cond {
        predicate: Predicate,
        then_branch: Box<AlgebraExpr>,
        else_branch: Box<AlgebraExpr>,
    },
    Try {
        primary: Box<AlgebraExpr>,
        fallback: Box<AlgebraExpr>,
    },
    Transform {
        inner: Box<AlgebraExpr>,
        mapper: GeneId,
    },
}

/// Strategy for merging results from parallel branches in a `Par` expression.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum MergeStrategy {
    /// Wait for all branches; merge results into an array.
    WaitAll,
    /// Return the first successful result; cancel remaining.
    FirstSuccess,
    /// Return when a majority of branches succeed.
    Majority,
}

/// A boolean predicate evaluated against JSON data for `Cond` branching.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Predicate {
    pub field: String,
    pub op: CompareOp,
    pub value: serde_json::Value,
}

/// Comparison operators supported by [`Predicate`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum CompareOp {
    Eq,
    Neq,
    Gt,
    Lt,
    Gte,
    Lte,
    Contains,
    Matches,
}

impl Predicate {
    /// Evaluate this predicate against a JSON value, returning `true` if matched.
    pub fn evaluate(&self, data: &serde_json::Value) -> bool {
        let field_value = data.get(&self.field);

        match field_value {
            None => false,
            Some(actual) => match self.op {
                CompareOp::Eq => actual == &self.value,
                CompareOp::Neq => actual != &self.value,
                CompareOp::Gt => compare_numeric(actual, &self.value, |a, b| a > b),
                CompareOp::Lt => compare_numeric(actual, &self.value, |a, b| a < b),
                CompareOp::Gte => compare_numeric(actual, &self.value, |a, b| a >= b),
                CompareOp::Lte => compare_numeric(actual, &self.value, |a, b| a <= b),
                CompareOp::Contains => {
                    if let (Some(haystack), Some(needle)) =
                        (actual.as_str(), self.value.as_str())
                    {
                        haystack.contains(needle)
                    } else {
                        false
                    }
                }
                CompareOp::Matches => false, // regex matching deferred
            },
        }
    }
}

fn compare_numeric(a: &serde_json::Value, b: &serde_json::Value, cmp: fn(f64, f64) -> bool) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(av), Some(bv)) => cmp(av, bv),
        _ => false,
    }
}

impl AlgebraExpr {
    pub fn depth(&self) -> usize {
        match self {
            AlgebraExpr::Gene(_) => 1,
            AlgebraExpr::Seq(exprs) => 1 + exprs.iter().map(|e| e.depth()).max().unwrap_or(0),
            AlgebraExpr::Par { branches, .. } => {
                1 + branches.iter().map(|e| e.depth()).max().unwrap_or(0)
            }
            AlgebraExpr::Cond {
                then_branch,
                else_branch,
                ..
            } => 1 + then_branch.depth().max(else_branch.depth()),
            AlgebraExpr::Try {
                primary, fallback, ..
            } => 1 + primary.depth().max(fallback.depth()),
            AlgebraExpr::Transform { inner, .. } => 1 + inner.depth(),
        }
    }

    pub fn gene_count(&self) -> usize {
        match self {
            AlgebraExpr::Gene(_) => 1,
            AlgebraExpr::Seq(exprs) => exprs.iter().map(|e| e.gene_count()).sum(),
            AlgebraExpr::Par { branches, .. } => branches.iter().map(|e| e.gene_count()).sum(),
            AlgebraExpr::Cond {
                then_branch,
                else_branch,
                ..
            } => then_branch.gene_count() + else_branch.gene_count(),
            AlgebraExpr::Try {
                primary, fallback, ..
            } => primary.gene_count() + fallback.gene_count(),
            AlgebraExpr::Transform { inner, .. } => inner.gene_count() + 1,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(byte: u8) -> [u8; 32] {
        let mut arr = [0u8; 32];
        arr[0] = byte;
        arr
    }

    // ── Predicate::evaluate ──

    #[test]
    fn predicate_eq_match() {
        let p = Predicate { field: "x".into(), op: CompareOp::Eq, value: serde_json::json!(42) };
        assert!(p.evaluate(&serde_json::json!({"x": 42})));
    }

    #[test]
    fn predicate_eq_no_match() {
        let p = Predicate { field: "x".into(), op: CompareOp::Eq, value: serde_json::json!(42) };
        assert!(!p.evaluate(&serde_json::json!({"x": 99})));
    }

    #[test]
    fn predicate_eq_string_values() {
        let p = Predicate { field: "s".into(), op: CompareOp::Eq, value: serde_json::json!("hello") };
        assert!(p.evaluate(&serde_json::json!({"s": "hello"})));
        assert!(!p.evaluate(&serde_json::json!({"s": "world"})));
    }

    #[test]
    fn predicate_neq() {
        let p = Predicate { field: "x".into(), op: CompareOp::Neq, value: serde_json::json!(1) };
        assert!(p.evaluate(&serde_json::json!({"x": 2})));
        assert!(!p.evaluate(&serde_json::json!({"x": 1})));
    }

    #[test]
    fn predicate_gt_numeric() {
        let p = Predicate { field: "x".into(), op: CompareOp::Gt, value: serde_json::json!(5) };
        assert!(p.evaluate(&serde_json::json!({"x": 10})));
        assert!(!p.evaluate(&serde_json::json!({"x": 3})));
    }

    #[test]
    fn predicate_gt_equal_values_is_false() {
        let p = Predicate { field: "x".into(), op: CompareOp::Gt, value: serde_json::json!(5) };
        assert!(!p.evaluate(&serde_json::json!({"x": 5})));
    }

    #[test]
    fn predicate_lt_numeric() {
        let p = Predicate { field: "x".into(), op: CompareOp::Lt, value: serde_json::json!(7) };
        assert!(p.evaluate(&serde_json::json!({"x": 3})));
        assert!(!p.evaluate(&serde_json::json!({"x": 10})));
    }

    #[test]
    fn predicate_gte_boundary() {
        let p = Predicate { field: "x".into(), op: CompareOp::Gte, value: serde_json::json!(5) };
        assert!(p.evaluate(&serde_json::json!({"x": 5})));
        assert!(p.evaluate(&serde_json::json!({"x": 6})));
        assert!(!p.evaluate(&serde_json::json!({"x": 4})));
    }

    #[test]
    fn predicate_lte_boundary() {
        let p = Predicate { field: "x".into(), op: CompareOp::Lte, value: serde_json::json!(5) };
        assert!(p.evaluate(&serde_json::json!({"x": 5})));
        assert!(p.evaluate(&serde_json::json!({"x": 4})));
        assert!(!p.evaluate(&serde_json::json!({"x": 6})));
    }

    #[test]
    fn predicate_gt_non_numeric_returns_false() {
        let p = Predicate { field: "x".into(), op: CompareOp::Gt, value: serde_json::json!("abc") };
        assert!(!p.evaluate(&serde_json::json!({"x": "xyz"})));
    }

    #[test]
    fn predicate_contains_string() {
        let p = Predicate { field: "s".into(), op: CompareOp::Contains, value: serde_json::json!("world") };
        assert!(p.evaluate(&serde_json::json!({"s": "hello world"})));
    }

    #[test]
    fn predicate_contains_no_match() {
        let p = Predicate { field: "s".into(), op: CompareOp::Contains, value: serde_json::json!("xyz") };
        assert!(!p.evaluate(&serde_json::json!({"s": "hello"})));
    }

    #[test]
    fn predicate_contains_non_string_returns_false() {
        let p = Predicate { field: "x".into(), op: CompareOp::Contains, value: serde_json::json!(42) };
        assert!(!p.evaluate(&serde_json::json!({"x": 42})));
    }

    #[test]
    fn predicate_matches_always_false() {
        let p = Predicate { field: "s".into(), op: CompareOp::Matches, value: serde_json::json!(".*") };
        assert!(!p.evaluate(&serde_json::json!({"s": "anything"})));
    }

    #[test]
    fn predicate_missing_field_returns_false() {
        let p = Predicate { field: "z".into(), op: CompareOp::Eq, value: serde_json::json!(1) };
        assert!(!p.evaluate(&serde_json::json!({"x": 1})));
    }

    #[test]
    fn predicate_null_field_value() {
        let p_eq = Predicate { field: "x".into(), op: CompareOp::Eq, value: serde_json::json!(null) };
        assert!(p_eq.evaluate(&serde_json::json!({"x": null})));

        let p_gt = Predicate { field: "x".into(), op: CompareOp::Gt, value: serde_json::json!(null) };
        assert!(!p_gt.evaluate(&serde_json::json!({"x": null})));
    }

    // ── AlgebraExpr::depth ──

    #[test]
    fn depth_gene_is_1() {
        assert_eq!(AlgebraExpr::Gene(id(1)).depth(), 1);
    }

    #[test]
    fn depth_empty_seq_is_1() {
        assert_eq!(AlgebraExpr::Seq(vec![]).depth(), 1);
    }

    #[test]
    fn depth_nested_seq_in_par() {
        let expr = AlgebraExpr::Par {
            branches: vec![
                AlgebraExpr::Seq(vec![AlgebraExpr::Gene(id(1)), AlgebraExpr::Gene(id(2))]),
                AlgebraExpr::Gene(id(3)),
            ],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };
        assert_eq!(expr.depth(), 3); // Par(1) + Seq(1) + Gene(1)
    }

    #[test]
    fn depth_cond() {
        let expr = AlgebraExpr::Cond {
            predicate: Predicate { field: "x".into(), op: CompareOp::Eq, value: serde_json::json!(1) },
            then_branch: Box::new(AlgebraExpr::Gene(id(1))),
            else_branch: Box::new(AlgebraExpr::Seq(vec![AlgebraExpr::Gene(id(2))])),
        };
        assert_eq!(expr.depth(), 3); // Cond(1) + Seq(1) + Gene(1)
    }

    #[test]
    fn depth_transform() {
        let expr = AlgebraExpr::Transform {
            inner: Box::new(AlgebraExpr::Gene(id(1))),
            mapper: id(2),
        };
        assert_eq!(expr.depth(), 2);
    }

    // ── AlgebraExpr::gene_count ──

    #[test]
    fn gene_count_single_gene() {
        assert_eq!(AlgebraExpr::Gene(id(1)).gene_count(), 1);
    }

    #[test]
    fn gene_count_empty_seq() {
        assert_eq!(AlgebraExpr::Seq(vec![]).gene_count(), 0);
    }

    #[test]
    fn gene_count_transform() {
        let expr = AlgebraExpr::Transform {
            inner: Box::new(AlgebraExpr::Gene(id(1))),
            mapper: id(2),
        };
        assert_eq!(expr.gene_count(), 2);
    }

    #[test]
    fn gene_count_complex_tree() {
        let expr = AlgebraExpr::Par {
            branches: vec![
                AlgebraExpr::Seq(vec![AlgebraExpr::Gene(id(1)), AlgebraExpr::Gene(id(2))]),
                AlgebraExpr::Try {
                    primary: Box::new(AlgebraExpr::Gene(id(3))),
                    fallback: Box::new(AlgebraExpr::Gene(id(4))),
                },
            ],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };
        assert_eq!(expr.gene_count(), 4);
    }
}
