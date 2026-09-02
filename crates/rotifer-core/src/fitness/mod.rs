//! Fitness scoring and admission gate per Rotifer spec §5.
//!
//! v0.5.5: Multiplicative model — F(g) = S_r · ln(1+C_util) · (1+R_rob) · L_score · Cost_score
//! Any single zero-valued factor drives the entire score to zero.
//! Bounded by its own factors — (0, 2·ln 2] — so no cap is applied.
//! Admission thresholds: τ = 0.3, V_min = 0.7.

use serde::{Deserialize, Serialize};

const TAU: f64 = 0.3;
const V_MIN: f64 = 0.7;

/// Formula version tag for backward-compatible Arena coexistence.
pub const FORMULA_VERSION: u32 = 2;

/// Composite fitness score for a gene, combining performance and safety.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitnessScore {
    /// Overall fitness value in (0, 2·ln 2] ≈ (0, 1.386]; higher is better.
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
/// Uses the spec-aligned multiplicative formula (ADR-318 D2):
/// ```text
/// F(g) = S_r · ln(1 + C_util) · (1 + R_rob) · L_score · Cost_score
/// ```
/// where `L_score` and `Cost_score` are the normalized, already-inverted
/// efficiency scores below — they multiply rather than divide, which is what
/// makes a slower or costlier gene score lower. If success_rate is zero the
/// entire fitness collapses to zero (no mutual compensation).
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

    // Multiplicative formula: F(g) = S_r · ln(1+C) · (1+R) · L_score · Cost_score
    //
    // The efficiency scores multiply. Dividing by them, as this did until
    // ADR-318 D2, inverted the penalty into a reward: because both are already
    // inverted (lower latency → score nearer 1), dividing made F(g) *rise* with
    // latency, and everything past ~1s pinned at the 1.0 cap below. The
    // `latency_penalized_below_fast_gene` tests hold the direction.
    let quality = success_rate * coverage.ln_1p().max(0.001) * (1.0 + robustness);
    let value = quality * latency_score * resource_efficiency;

    // No cap. `min(1.0)` was there because dividing by the efficiency scores
    // made the value unbounded; multiplying by them bounds it by its own
    // factors — (0, 2·ln 2] ≈ (0, 1.386] — and ADR-318 D2 drops the cap for
    // exactly that reason: it erased every difference above 1.0, which is how
    // six leaderboard genes came to tie at a perfect 1.000.

    let safety_score = if successes == total {
        1.0
    } else {
        success_rate * 0.9
    };

    FitnessScore {
        value,
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

    /// The direction of the latency and cost terms.
    ///
    /// Until ADR-318 D2 the normalized efficiency scores sat in the
    /// *denominator*, so F(g) climbed with latency and every gene slower than a
    /// second pinned at the 1.0 cap. Arena ranking was selecting against
    /// performance. These fail if the penalty flips back into a reward.
    #[test]
    fn latency_penalized_below_fast_gene() {
        let fast = compute_fitness(&[eval(true, 5, 1.0)]).value;
        let slow = compute_fitness(&[eval(true, 100, 1.0)]).value;
        let slower = compute_fitness(&[eval(true, 1000, 1.0)]).value;
        let slowest = compute_fitness(&[eval(true, 8370, 1.0)]).value;
        assert!(fast > slow, "5ms ({fast}) must outscore 100ms ({slow})");
        assert!(slow > slower, "100ms ({slow}) must outscore 1000ms ({slower})");
        assert!(slower > slowest, "1000ms ({slower}) must outscore 8370ms ({slowest})");
    }

    #[test]
    fn latency_penalized_monotonically_across_range() {
        let ladder = [0u64, 1, 5, 12, 50, 100, 500, 1000, 3000, 8370, 60_000];
        let scores: Vec<f64> = ladder
            .iter()
            .map(|&ms| compute_fitness(&[eval(true, ms, 1.0)]).value)
            .collect();
        for w in scores.windows(2) {
            assert!(w[1] < w[0], "F(g) must fall as latency rises, got {w:?}");
        }
    }

    #[test]
    fn slow_gene_does_not_pin_at_cap() {
        let slow = compute_fitness(&[eval(true, 8370, 1.0)]);
        assert!(slow.value < 1.0, "a 8.4s gene must not score a perfect 1.0");
        let fast = compute_fitness(&[eval(true, 100, 1.0)]);
        assert!(slow.value < fast.value / 2.0);
    }

    #[test]
    fn resource_cost_penalized_below_cheap_gene() {
        let cheap = compute_fitness(&[eval(true, 100, 100.0)]).value;
        let costly = compute_fitness(&[eval(true, 100, 10_000.0)]).value;
        let costliest = compute_fitness(&[eval(true, 100, 1_000_000.0)]).value;
        assert!(cheap > costly, "cheap ({cheap}) must outscore costly ({costly})");
        assert!(costly > costliest);
    }

    #[test]
    fn no_cap_and_bounded_by_its_own_factors() {
        let best = compute_fitness(&[EvaluationResult {
            success: true,
            latency_ms: 0,
            resource_cost: 0.0,
            coverage: Some(1.0),
            robustness: Some(1.0),
        }]);
        // ADR-318 D2 range: (0, 2·ln 2] ≈ (0, 1.386], no min(1.0).
        assert!((best.value - 2.0 * std::f64::consts::LN_2).abs() < 1e-12);
        assert!(best.value > 1.0, "the cap must be gone, got {}", best.value);
    }

    #[test]
    fn near_perfect_genes_stay_distinguishable() {
        let mk = |latency_ms| EvaluationResult {
            success: true,
            latency_ms,
            resource_cost: 0.0,
            coverage: Some(1.0),
            robustness: Some(1.0),
        };
        let a = compute_fitness(&[mk(1)]).value;
        let b = compute_fitness(&[mk(2)]).value;
        assert!(a > b, "the cap used to tie these at 1.000: {a} vs {b}");
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
