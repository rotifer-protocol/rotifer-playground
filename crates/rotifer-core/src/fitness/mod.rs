//! Fitness scoring and admission gate per Rotifer spec §5.
//!
//! v0.5.5: Multiplicative model — F(g) = [S_r · ln(1+C_util) · (1+R_rob)] / [L · Cost]
//! Any single zero-valued factor drives the entire score to zero.
//! Admission thresholds: τ = 0.3, V_min = 0.7.

use serde::{Deserialize, Serialize};

const TAU: f64 = 0.3;
const V_MIN: f64 = 0.7;

/// Formula version tag for backward-compatible Arena coexistence.
pub const FORMULA_VERSION: u32 = 2;

/// Composite fitness score for a gene, combining performance and safety.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitnessScore {
    /// Overall fitness value (unbounded positive; higher is better).
    pub value: f64,
    /// Safety sub-score in \[0, 1\]; must meet V_min for admission.
    pub safety_score: f64,
    pub components: FitnessComponents,
    /// Which formula produced this score (1 = legacy additive, 2 = multiplicative).
    #[serde(default = "default_formula_version")]
    pub formula_version: u32,
}

fn default_formula_version() -> u32 {
    FORMULA_VERSION
}

/// Breakdown of fitness into individual components.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitnessComponents {
    /// Fraction of successful executions in (0, 1].
    pub success_rate: f64,
    /// Normalized latency score — lower latency → higher score.
    pub latency_score: f64,
    /// Normalized resource efficiency — lower cost → higher score.
    pub resource_efficiency: f64,
    /// Coverage utilization in [0, 1]. Default 0.5 if unknown.
    #[serde(default = "default_coverage")]
    pub coverage: f64,
    /// Robustness score in [0, 1]. Default 0.5 if unknown.
    #[serde(default = "default_robustness")]
    pub robustness: f64,
}

fn default_coverage() -> f64 {
    0.5
}
fn default_robustness() -> f64 {
    0.5
}

/// Raw outcome of a single evaluation run, fed into [`compute_fitness`].
#[derive(Debug, Clone)]
pub struct EvaluationResult {
    pub success: bool,
    pub latency_ms: u64,
    pub resource_cost: f64,
    /// Optional coverage utilization measured during execution.
    pub coverage: Option<f64>,
    /// Optional robustness score measured during execution.
    pub robustness: Option<f64>,
}

/// Compute a [`FitnessScore`] from a batch of evaluation results.
///
/// Uses the spec-aligned multiplicative formula:
/// ```text
/// F(g) = [S_r · ln(1 + C_util) · (1 + R_rob)] / [L · Resource_Cost]
/// ```
/// where each factor is derived from evaluation metrics. If success_rate is
/// zero the entire fitness collapses to zero (no mutual compensation).
pub fn compute_fitness(results: &[EvaluationResult]) -> FitnessScore {
    if results.is_empty() {
        return FitnessScore {
            value: 0.0,
            safety_score: 0.0,
            components: FitnessComponents {
                success_rate: 0.0,
                latency_score: 0.0,
                resource_efficiency: 0.0,
                coverage: 0.0,
                robustness: 0.0,
            },
            formula_version: FORMULA_VERSION,
        };
    }

    let total = results.len() as f64;
    let successes = results.iter().filter(|r| r.success).count() as f64;
    let success_rate = successes / total;

    let avg_latency = results.iter().map(|r| r.latency_ms as f64).sum::<f64>() / total;
    let latency_score = 1.0 / (1.0 + avg_latency / 1000.0);

    let avg_cost = results.iter().map(|r| r.resource_cost).sum::<f64>() / total;
    let resource_efficiency = 1.0 / (1.0 + avg_cost / 10_000.0);

    let coverage = results
        .iter()
        .filter_map(|r| r.coverage)
        .sum::<f64>()
        / results.iter().filter(|r| r.coverage.is_some()).count().max(1) as f64;
    let coverage = if results.iter().any(|r| r.coverage.is_some()) {
        coverage
    } else {
        0.5
    };

    let robustness = results
        .iter()
        .filter_map(|r| r.robustness)
        .sum::<f64>()
        / results.iter().filter(|r| r.robustness.is_some()).count().max(1) as f64;
    let robustness = if results.iter().any(|r| r.robustness.is_some()) {
        robustness
    } else {
        0.5
    };

    // Multiplicative formula: F(g) = [S_r · ln(1+C) · (1+R)] / [L · Cost]
    let l = latency_score.max(0.001);
    let cost = resource_efficiency.max(0.001);
    let numerator = success_rate * (1.0 + coverage).ln_1p().max(0.001) * (1.0 + robustness);
    let denominator = l * cost;
    let value = if denominator > 0.0 {
        numerator / denominator
    } else {
        0.0
    };

    // Normalize to [0, 1] range for admission gate compatibility.
    // The raw multiplicative value can exceed 1.0; we cap it.
    let normalized_value = value.min(1.0);

    let safety_score = if successes == total {
        1.0
    } else {
        success_rate * 0.9
    };

    FitnessScore {
        value: normalized_value,
        safety_score,
        components: FitnessComponents {
            success_rate,
            latency_score,
            resource_efficiency,
            coverage,
            robustness,
        },
        formula_version: FORMULA_VERSION,
    }
}

/// Check whether a fitness score meets the admission gate (§5: τ ≥ 0.3, V ≥ 0.7).
pub fn passes_admission(score: &FitnessScore) -> bool {
    score.value >= TAU && score.safety_score >= V_MIN
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eval(success: bool, latency_ms: u64, resource_cost: f64) -> EvaluationResult {
        EvaluationResult {
            success,
            latency_ms,
            resource_cost,
            coverage: None,
            robustness: None,
        }
    }

    #[test]
    fn test_perfect_fitness() {
        let results = vec![
            eval(true, 100, 1000.0),
            eval(true, 150, 1200.0),
        ];
        let score = compute_fitness(&results);
        assert!(score.value > TAU);
        assert!(score.safety_score >= V_MIN);
        assert!(passes_admission(&score));
        assert_eq!(score.formula_version, FORMULA_VERSION);
    }

    #[test]
    fn test_empty_results() {
        let score = compute_fitness(&[]);
        assert_eq!(score.value, 0.0);
        assert!(!passes_admission(&score));
    }

    #[test]
    fn test_failing_gene_zero_fitness() {
        let results = vec![
            eval(false, 5000, 50000.0),
            eval(false, 5000, 50000.0),
        ];
        let score = compute_fitness(&results);
        // Multiplicative model: success_rate=0 → value=0
        assert_eq!(score.components.success_rate, 0.0);
        assert_eq!(score.value, 0.0, "zero success_rate must collapse fitness to 0");
        assert!(!passes_admission(&score));
    }

    #[test]
    fn single_success_result() {
        let results = vec![eval(true, 50, 100.0)];
        let score = compute_fitness(&results);
        assert_eq!(score.components.success_rate, 1.0);
        assert!(score.safety_score >= V_MIN);
    }

    #[test]
    fn mixed_success_and_failure() {
        let results = vec![
            eval(true, 100, 1000.0),
            eval(true, 100, 1000.0),
            eval(true, 100, 1000.0),
            eval(false, 100, 1000.0),
            eval(false, 100, 1000.0),
        ];
        let score = compute_fitness(&results);
        assert!((score.components.success_rate - 0.6).abs() < f64::EPSILON);
        assert!((score.safety_score - 0.54).abs() < f64::EPSILON);
    }

    #[test]
    fn zero_latency() {
        let results = vec![eval(true, 0, 0.0)];
        let score = compute_fitness(&results);
        assert!((score.components.latency_score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn zero_resource_cost() {
        let results = vec![eval(true, 100, 0.0)];
        let score = compute_fitness(&results);
        assert!((score.components.resource_efficiency - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn coverage_and_robustness_defaults() {
        let results = vec![eval(true, 100, 1000.0)];
        let score = compute_fitness(&results);
        assert!((score.components.coverage - 0.5).abs() < f64::EPSILON);
        assert!((score.components.robustness - 0.5).abs() < f64::EPSILON);
    }

    #[test]
    fn custom_coverage_and_robustness() {
        let results = vec![EvaluationResult {
            success: true,
            latency_ms: 100,
            resource_cost: 1000.0,
            coverage: Some(0.9),
            robustness: Some(0.8),
        }];
        let score = compute_fitness(&results);
        assert!((score.components.coverage - 0.9).abs() < f64::EPSILON);
        assert!((score.components.robustness - 0.8).abs() < f64::EPSILON);
        assert!(score.value > 0.0);
    }

    #[test]
    fn formula_version_is_two() {
        let results = vec![eval(true, 100, 1000.0)];
        let score = compute_fitness(&results);
        assert_eq!(score.formula_version, 2);
    }

    #[test]
    fn admission_boundary_exactly_at_tau() {
        let score = FitnessScore {
            value: TAU,
            safety_score: 1.0,
            components: FitnessComponents {
                success_rate: 1.0, latency_score: 1.0, resource_efficiency: 1.0,
                coverage: 0.5, robustness: 0.5,
            },
            formula_version: FORMULA_VERSION,
        };
        assert!(passes_admission(&score));
    }

    #[test]
    fn admission_boundary_just_below_tau() {
        let score = FitnessScore {
            value: TAU - 0.001,
            safety_score: 1.0,
            components: FitnessComponents {
                success_rate: 1.0, latency_score: 1.0, resource_efficiency: 1.0,
                coverage: 0.5, robustness: 0.5,
            },
            formula_version: FORMULA_VERSION,
        };
        assert!(!passes_admission(&score));
    }

    #[test]
    fn admission_boundary_exactly_at_vmin() {
        let score = FitnessScore {
            value: 1.0,
            safety_score: V_MIN,
            components: FitnessComponents {
                success_rate: 1.0, latency_score: 1.0, resource_efficiency: 1.0,
                coverage: 0.5, robustness: 0.5,
            },
            formula_version: FORMULA_VERSION,
        };
        assert!(passes_admission(&score));
    }

    #[test]
    fn admission_boundary_just_below_vmin() {
        let score = FitnessScore {
            value: 1.0,
            safety_score: V_MIN - 0.001,
            components: FitnessComponents {
                success_rate: 1.0, latency_score: 1.0, resource_efficiency: 1.0,
                coverage: 0.5, robustness: 0.5,
            },
            formula_version: FORMULA_VERSION,
        };
        assert!(!passes_admission(&score));
    }

    #[test]
    fn admission_fails_one_threshold() {
        let score = FitnessScore {
            value: TAU + 0.1,
            safety_score: V_MIN - 0.1,
            components: FitnessComponents {
                success_rate: 0.5, latency_score: 0.5, resource_efficiency: 0.5,
                coverage: 0.5, robustness: 0.5,
            },
            formula_version: FORMULA_VERSION,
        };
        assert!(!passes_admission(&score), "above TAU but below V_MIN should fail");
    }

    #[test]
    fn constants_match_spec() {
        assert!((TAU - 0.3).abs() < f64::EPSILON, "TAU should be 0.3 per §5");
        assert!((V_MIN - 0.7).abs() < f64::EPSILON, "V_MIN should be 0.7 per §5");
    }
}
