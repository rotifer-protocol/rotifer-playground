use std::collections::HashMap;

use super::AlgebraExpr;
use crate::types::gene::Gene;
use crate::types::GeneId;

const MAX_DEPTH: usize = 16;
const MAX_GENE_REFS: usize = 64;

/// Errors detected during static composition validation.
#[derive(Debug)]
pub enum TypeCheckError {
    /// A gene referenced in the expression is not in the store.
    GeneNotFound(GeneId),
    /// Expression tree exceeds the maximum nesting depth.
    DepthExceeded { actual: usize, max: usize },
    /// Expression references more unique genes than allowed.
    TooManyGeneRefs { actual: usize, max: usize },
    /// Input/output schemas between adjacent genes are incompatible.
    SchemaIncompatible { from: String, to: String, detail: String },
}

/// Statically validate an [`AlgebraExpr`] against depth, gene-count, and
/// existence constraints. Returns accumulated errors if any.
pub fn check_composition(
    expr: &AlgebraExpr,
    gene_store: &HashMap<GeneId, Gene>,
) -> Result<(), Vec<TypeCheckError>> {
    let mut errors = Vec::new();

    let depth = expr.depth();
    if depth > MAX_DEPTH {
        errors.push(TypeCheckError::DepthExceeded {
            actual: depth,
            max: MAX_DEPTH,
        });
    }

    let count = expr.gene_count();
    if count > MAX_GENE_REFS {
        errors.push(TypeCheckError::TooManyGeneRefs {
            actual: count,
            max: MAX_GENE_REFS,
        });
    }

    check_gene_existence(expr, gene_store, &mut errors);

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors)
    }
}

fn check_gene_existence(
    expr: &AlgebraExpr,
    gene_store: &HashMap<GeneId, Gene>,
    errors: &mut Vec<TypeCheckError>,
) {
    match expr {
        AlgebraExpr::Gene(id) => {
            if !gene_store.contains_key(id) {
                errors.push(TypeCheckError::GeneNotFound(*id));
            }
        }
        AlgebraExpr::Seq(steps) => {
            for step in steps {
                check_gene_existence(step, gene_store, errors);
            }
        }
        AlgebraExpr::Par { branches, .. } => {
            for branch in branches {
                check_gene_existence(branch, gene_store, errors);
            }
        }
        AlgebraExpr::Cond {
            then_branch,
            else_branch,
            ..
        } => {
            check_gene_existence(then_branch, gene_store, errors);
            check_gene_existence(else_branch, gene_store, errors);
        }
        AlgebraExpr::Try {
            primary, fallback, ..
        } => {
            check_gene_existence(primary, gene_store, errors);
            check_gene_existence(fallback, gene_store, errors);
        }
        AlgebraExpr::Transform { inner, mapper } => {
            check_gene_existence(inner, gene_store, errors);
            if !gene_store.contains_key(mapper) {
                errors.push(TypeCheckError::GeneNotFound(*mapper));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::algebra::{CompareOp, MergeStrategy, Predicate};
    use crate::types::gene::{Fidelity, Gene, GeneTransparency, Phenotype};
    use crate::types::GeneId;

    fn make_gene(id_byte: u8) -> (GeneId, Gene) {
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
            wasm_bytes: None,
            source_code: None,
        };
        (gene_id, gene)
    }

    fn missing_id(byte: u8) -> GeneId {
        let mut id = [0u8; 32];
        id[0] = byte;
        id
    }

    fn dummy_predicate() -> Predicate {
        Predicate { field: "x".into(), op: CompareOp::Eq, value: serde_json::json!(1) }
    }

    #[test]
    fn check_single_gene_exists() {
        let (id, gene) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id, gene)].into_iter().collect();
        assert!(check_composition(&AlgebraExpr::Gene(id), &store).is_ok());
    }

    #[test]
    fn check_single_gene_not_found() {
        let store: HashMap<GeneId, Gene> = HashMap::new();
        let id = missing_id(99);
        let errs = check_composition(&AlgebraExpr::Gene(id), &store).unwrap_err();
        assert_eq!(errs.len(), 1);
        assert!(matches!(&errs[0], TypeCheckError::GeneNotFound(gid) if *gid == id));
    }

    #[test]
    fn check_multiple_missing_genes() {
        let store: HashMap<GeneId, Gene> = HashMap::new();
        let expr = AlgebraExpr::Seq(vec![
            AlgebraExpr::Gene(missing_id(1)),
            AlgebraExpr::Gene(missing_id(2)),
            AlgebraExpr::Gene(missing_id(3)),
        ]);
        let errs = check_composition(&expr, &store).unwrap_err();
        let not_found_count = errs.iter().filter(|e| matches!(e, TypeCheckError::GeneNotFound(_))).count();
        assert_eq!(not_found_count, 3);
    }

    #[test]
    fn check_depth_at_max_passes() {
        let (id, gene) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id, gene)].into_iter().collect();
        // Build exactly depth=16: 15 nested Seq wrappers + 1 Gene = depth 16
        let mut expr = AlgebraExpr::Gene(id);
        for _ in 0..(MAX_DEPTH - 1) {
            expr = AlgebraExpr::Seq(vec![expr]);
        }
        assert_eq!(expr.depth(), MAX_DEPTH);
        assert!(check_composition(&expr, &store).is_ok());
    }

    #[test]
    fn check_depth_exceeds_max_fails() {
        let (id, gene) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id, gene)].into_iter().collect();
        let mut expr = AlgebraExpr::Gene(id);
        for _ in 0..MAX_DEPTH {
            expr = AlgebraExpr::Seq(vec![expr]);
        }
        assert_eq!(expr.depth(), MAX_DEPTH + 1);
        let errs = check_composition(&expr, &store).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, TypeCheckError::DepthExceeded { actual, max } if *actual == MAX_DEPTH + 1 && *max == MAX_DEPTH)));
    }

    #[test]
    fn check_gene_count_at_max_passes() {
        let mut store = HashMap::new();
        let mut genes = Vec::new();
        for i in 0..MAX_GENE_REFS as u8 {
            let (id, gene) = make_gene(i);
            store.insert(id, gene);
            genes.push(AlgebraExpr::Gene(id));
        }
        let expr = AlgebraExpr::Seq(genes);
        assert_eq!(expr.gene_count(), MAX_GENE_REFS);
        assert!(check_composition(&expr, &store).is_ok());
    }

    #[test]
    fn check_gene_count_exceeds_max_fails() {
        let mut store = HashMap::new();
        let mut genes = Vec::new();
        for i in 0..=MAX_GENE_REFS as u8 {
            let (id, gene) = make_gene(i);
            store.insert(id, gene);
            genes.push(AlgebraExpr::Gene(id));
        }
        let expr = AlgebraExpr::Seq(genes);
        assert_eq!(expr.gene_count(), MAX_GENE_REFS + 1);
        let errs = check_composition(&expr, &store).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, TypeCheckError::TooManyGeneRefs { .. })));
    }

    #[test]
    fn check_seq_recurses_into_steps() {
        let (id_a, gene_a) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id_a, gene_a)].into_iter().collect();
        let id_b = missing_id(2);
        let expr = AlgebraExpr::Seq(vec![AlgebraExpr::Gene(id_a), AlgebraExpr::Gene(id_b)]);
        let errs = check_composition(&expr, &store).unwrap_err();
        assert_eq!(errs.len(), 1);
        assert!(matches!(&errs[0], TypeCheckError::GeneNotFound(gid) if *gid == id_b));
    }

    #[test]
    fn check_par_recurses_into_branches() {
        let (id_a, gene_a) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id_a, gene_a)].into_iter().collect();
        let id_b = missing_id(2);
        let expr = AlgebraExpr::Par {
            branches: vec![AlgebraExpr::Gene(id_a), AlgebraExpr::Gene(id_b)],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };
        let errs = check_composition(&expr, &store).unwrap_err();
        assert!(matches!(&errs[0], TypeCheckError::GeneNotFound(gid) if *gid == id_b));
    }

    #[test]
    fn check_cond_recurses_both_branches() {
        let (id_a, gene_a) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id_a, gene_a)].into_iter().collect();
        let id_b = missing_id(2);
        let expr = AlgebraExpr::Cond {
            predicate: dummy_predicate(),
            then_branch: Box::new(AlgebraExpr::Gene(id_a)),
            else_branch: Box::new(AlgebraExpr::Gene(id_b)),
        };
        let errs = check_composition(&expr, &store).unwrap_err();
        assert!(matches!(&errs[0], TypeCheckError::GeneNotFound(gid) if *gid == id_b));
    }

    #[test]
    fn check_try_recurses_primary_and_fallback() {
        let (id_a, gene_a) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id_a, gene_a)].into_iter().collect();
        let id_b = missing_id(2);
        let expr = AlgebraExpr::Try {
            primary: Box::new(AlgebraExpr::Gene(id_a)),
            fallback: Box::new(AlgebraExpr::Gene(id_b)),
        };
        let errs = check_composition(&expr, &store).unwrap_err();
        assert!(matches!(&errs[0], TypeCheckError::GeneNotFound(gid) if *gid == id_b));
    }

    #[test]
    fn check_transform_validates_mapper() {
        let (id_a, gene_a) = make_gene(1);
        let store: HashMap<GeneId, Gene> = [(id_a, gene_a)].into_iter().collect();
        let mapper_id = missing_id(2);
        let expr = AlgebraExpr::Transform {
            inner: Box::new(AlgebraExpr::Gene(id_a)),
            mapper: mapper_id,
        };
        let errs = check_composition(&expr, &store).unwrap_err();
        assert!(matches!(&errs[0], TypeCheckError::GeneNotFound(gid) if *gid == mapper_id));
    }

    #[test]
    fn check_empty_seq_passes() {
        let store: HashMap<GeneId, Gene> = HashMap::new();
        assert!(check_composition(&AlgebraExpr::Seq(vec![]), &store).is_ok());
    }

    #[test]
    fn check_empty_par_passes() {
        let store: HashMap<GeneId, Gene> = HashMap::new();
        let expr = AlgebraExpr::Par {
            branches: vec![],
            merge: MergeStrategy::WaitAll,
            deadline: None,
        };
        assert!(check_composition(&expr, &store).is_ok());
    }

    #[test]
    fn check_multiple_error_types_accumulated() {
        let store: HashMap<GeneId, Gene> = HashMap::new();
        // Build deep + missing gene → DepthExceeded AND GeneNotFound
        let id = missing_id(1);
        let mut expr = AlgebraExpr::Gene(id);
        for _ in 0..MAX_DEPTH {
            expr = AlgebraExpr::Seq(vec![expr]);
        }
        let errs = check_composition(&expr, &store).unwrap_err();
        let has_depth = errs.iter().any(|e| matches!(e, TypeCheckError::DepthExceeded { .. }));
        let has_not_found = errs.iter().any(|e| matches!(e, TypeCheckError::GeneNotFound(_)));
        assert!(has_depth, "should report DepthExceeded");
        assert!(has_not_found, "should report GeneNotFound");
    }
}
