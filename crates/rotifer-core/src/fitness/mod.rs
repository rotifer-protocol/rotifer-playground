//! Fitness scoring and admission gate per Rotifer spec §5.
//!
//! Multiplicative model, normalized to [0, 1] (ADR-346):
//! F(g) = S_r · log₂(1 + C_util) · (1 + R_rob)/2 · L_score · Cost_score
//! Five factors, each in [0, 1]; any single zero-valued factor drives the
//! whole score to zero, and the product stays in [0, 1] with no cap applied.
//! Admission thresholds: V_min = 0.7; τ = 0.3 is the unnormalized-era default,
//! to be recalibrated for the [0, 1] range (ADR-346 D4).

use serde::{Deserialize, Serialize};

const TAU: f64 = 0.3;
const V_MIN: f64 = 0.7;

/// Formula version tag for backward-compatible Arena coexistence.
/// 1 = legacy additive, 2 = multiplicative (ADR-318 D2, range (0, 2·ln 2]),
/// 3 = multiplicative normalized to [0, 1] (ADR-346).
pub const FORMULA_VERSION: u32 = 3;

/// Composite fitness score for a gene, combining performance and safety.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FitnessScore {
    /// Overall fitness value in [0, 1]; higher is better.
    pub value: f64,
    /// Safety sub-score in \[0, 1\]; must meet V_min for admission.
    pub safety_score: f64,
    pub components: FitnessComponents,
    /// Which formula produced this score (see [`FORMULA_VERSION`]).
    #[serde(default = "default_formula_version")]
    pub formula_version: u32,
}

/// A stored score without a `formula_version` field predates the field, and
/// so the normalization: version 2. Pinned rather than tracking
/// `FORMULA_VERSION`, which would read old scores as the current scale.
fn default_formula_version() -> u32 {
    2
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

/// The scale F(g)'s efficiency terms are measured against (ADR-318 D2):
/// `L_score = 1 / (1 + L / L_ref)`, `Cost_score = 1 / (1 + Cost / Cost_ref)`,
/// so a Gene exactly at the reference scores 1/2 on each.
///
/// D2 defines `L_ref` / `Cost_ref` as the current-season median of the Gene's
/// own domain and fidelity, which the registry computes
/// (`get_fitness_reference`); [`ReferenceScale::FALLBACK`] holds the fixed
/// constants used while that sample is too small or unreachable.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReferenceScale {
    /// `L_ref`, in milliseconds.
    pub latency_ms: f64,
    /// `Cost_ref`, in fuel.
    pub resource_cost: f64,
}

impl ReferenceScale {
    /// Provisional constants (`[N]`, uncalibrated) — the scale used whenever no
    /// season median is available. Same values as the CLI's
    /// `LATENCY_SCALE_MS` / `RESOURCE_SCALE_UNITS`.
    pub const FALLBACK: ReferenceScale = ReferenceScale {
        latency_ms: 1000.0,
        resource_cost: 10_000.0,
    };

    /// Both values finite and positive — otherwise the terms would divide by
    /// zero or go negative, and the fallback is used instead.
    pub fn is_usable(&self) -> bool {
        self.latency_ms.is_finite()
            && self.latency_ms > 0.0
            && self.resource_cost.is_finite()
            && self.resource_cost > 0.0
    }
}

/// Compute a [`FitnessScore`] from a batch of evaluation results, against the
/// fallback reference scale. See [`compute_fitness_with_reference`].
pub fn compute_fitness(results: &[EvaluationResult]) -> FitnessScore {
    compute_fitness_with_reference(results, ReferenceScale::FALLBACK)
}

/// Compute a [`FitnessScore`] from a batch of evaluation results.
///
/// Uses the multiplicative formula (ADR-318 D2), normalized to [0, 1]
/// (ADR-346):
/// ```text
/// F(g) = S_r · log₂(1 + C_util) · (1 + R_rob)/2 · L_score · Cost_score
/// ```
/// where `L_score` and `Cost_score` are the normalized, already-inverted
/// efficiency scores below — they multiply rather than divide, which is what
/// makes a slower or costlier gene score lower. If success_rate is zero the
/// entire fitness collapses to zero (no mutual compensation).
///
/// `reference` scales the two efficiency terms; one that is not usable (zero,
/// negative or non-finite) is replaced by [`ReferenceScale::FALLBACK`].
pub fn compute_fitness_with_reference(
    results: &[EvaluationResult],
    reference: ReferenceScale,
) -> FitnessScore {
    let reference = if reference.is_usable() {
        reference
    } else {
        ReferenceScale::FALLBACK
    };
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
    let latency_score = 1.0 / (1.0 + avg_latency / reference.latency_ms);

    let avg_cost = results.iter().map(|r| r.resource_cost).sum::<f64>() / total;
    let resource_efficiency = 1.0 / (1.0 + avg_cost / reference.resource_cost);

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

    // Multiplicative formula, normalized (ADR-346):
    // F(g) = S_r · log₂(1 + C) · (1 + R)/2 · L_score · Cost_score
    //
    // The efficiency scores multiply. Dividing by them, as this did until
    // ADR-318 D2, inverted the penalty into a reward: because both are already
    // inverted (lower latency → score nearer 1), dividing made F(g) *rise* with
    // latency, and everything past ~1s pinned at the 1.0 cap below. The
    // `latency_penalized_below_fast_gene` tests hold the direction.
    //
    // Each factor is in [0, 1]: log₂(1 + C) is 1 at C = 1 and (1 + R)/2 is 1 at
    // R = 1, so the maximum is exactly 1 — not computed as ln(1 + C)·(1 + R)
    // and divided by 2·ln 2 afterwards, which could round to just above 1.
    // The 0.001 floor on the coverage term is the old ln-scale floor in the
    // new unit (÷ ln 2), so the result equals the old formula ÷ 2·ln 2.
    let coverage_term = (1.0 + coverage).log2().max(0.001 / std::f64::consts::LN_2);
    let quality = success_rate * coverage_term * ((1.0 + robustness) / 2.0);
    let value = quality * latency_score * resource_efficiency;

    // No cap. `min(1.0)` was there because dividing by the efficiency scores
    // made the value unbounded; multiplying by them bounds it by its own
    // factors, and ADR-318 D2 drops the cap for exactly that reason: it erased
    // every difference above 1.0, which is how six leaderboard genes came to
    // tie at a perfect 1.000.

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

/// Check a fitness score against the pre-normalization admission gate
/// (τ ≥ 0.3, V ≥ 0.7). Spec §5.1 now pauses τ until it is recalibrated for the
/// [0, 1] range (ADR-346 D4); this keeps the old value until then.
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
        // ADR-346: five factors each in [0, 1], so the theoretical maximum is
        // exactly 1 — reached by the factors themselves, no min(1.0).
        assert_eq!(best.value, 1.0);
        assert!(best.value <= 1.0);
    }

    /// ADR-346: no input may score above 1.0, compared exactly — the registry's
    /// chk_fitness_value rejects 1.0000000000000002. Deterministic LCG, so a
    /// failure reproduces; edges (exactly 1, and 0 latency / cost) included.
    #[test]
    fn random_inputs_never_score_above_one() {
        let mut state: u64 = 0x5eed;
        let mut rnd = || {
            state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (state >> 11) as f64 / (1u64 << 53) as f64
        };
        let mut worst = 0.0_f64;
        for _ in 0..200_000 {
            let pick = rnd();
            let unit = if pick < 0.1 { 1.0 } else { rnd() };
            let coverage = if rnd() < 0.1 { 1.0 } else { rnd() };
            let robustness = if rnd() < 0.1 { 1.0 } else { rnd() };
            let runs: Vec<EvaluationResult> = (0..(1 + (rnd() * 4.0) as usize))
                .map(|_| EvaluationResult {
                    success: rnd() < unit.max(0.05),
                    latency_ms: if rnd() < 0.2 { 0 } else { (rnd() * 5000.0) as u64 },
                    resource_cost: if rnd() < 0.2 { 0.0 } else { rnd() * 1e8 },
                    coverage: Some(coverage),
                    robustness: Some(robustness),
                })
                .collect();
            let v = compute_fitness(&runs).value;
            assert!(v <= 1.0, "scored {v} for {runs:?}");
            worst = worst.max(v);
        }
        assert!(worst <= 1.0);
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
    fn formula_version_is_three() {
        let results = vec![eval(true, 100, 1000.0)];
        let score = compute_fitness(&results);
        assert_eq!(score.formula_version, 3);
    }

    /// A score stored before `formula_version` existed was computed by the
    /// version-2 formula (ADR-318 D2, unnormalized). Reading it as the current
    /// version would mix the two scales without a trace.
    #[test]
    fn a_stored_score_without_a_version_reads_as_two() {
        let json = r#"{"value":1.2,"safety_score":1.0,"components":{"success_rate":1.0,"latency_score":1.0,"resource_efficiency":1.0,"coverage":1.0,"robustness":1.0}}"#;
        let score: FitnessScore = serde_json::from_str(json).unwrap();
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

    /// The vectors in `tests/fixtures/fitness-reference-vectors.json` were
    /// computed independently; `src/utils/fitness-formula.ts` checks the same
    /// file, so the two implementations cannot drift apart unnoticed.
    #[test]
    fn reproduces_the_shared_reference_vectors() {
        let doc: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/fitness-reference-vectors.json"
        ))
        .unwrap();
        let vectors = doc["vectors"].as_array().unwrap();
        assert!(vectors.len() >= 5);
        let close = |a: f64, b: f64| (a - b).abs() < 1e-12;
        for v in vectors {
            let name = v["name"].as_str().unwrap();
            let runs: Vec<EvaluationResult> = v["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| EvaluationResult {
                    success: r["success"].as_bool().unwrap(),
                    latency_ms: r["latency_ms"].as_u64().unwrap(),
                    resource_cost: r["resource_cost"].as_f64().unwrap(),
                    coverage: None,
                    robustness: None,
                })
                .collect();
            let reference = ReferenceScale {
                latency_ms: v["reference"]["latency_ms"].as_f64().unwrap(),
                resource_cost: v["reference"]["resource_cost"].as_f64().unwrap(),
            };
            let got = compute_fitness_with_reference(&runs, reference);
            let want = &v["expected"];
            let field = |k: &str| want[k].as_f64().unwrap();
            assert!(close(got.components.success_rate, field("success_rate")), "{name}: S_r");
            assert!(close(got.components.latency_score, field("latency_score")), "{name}: L_score");
            assert!(
                close(got.components.resource_efficiency, field("resource_efficiency")),
                "{name}: Cost_score"
            );
            assert!(close(got.value, field("value")), "{name}: F(g)");
        }
    }

    #[test]
    fn a_gene_at_the_reference_scores_one_half_on_each_term() {
        let reference = ReferenceScale {
            latency_ms: 80.0,
            resource_cost: 3000.0,
        };
        let score = compute_fitness_with_reference(&[eval(true, 80, 3000.0)], reference);
        assert!((score.components.latency_score - 0.5).abs() < 1e-12);
        assert!((score.components.resource_efficiency - 0.5).abs() < 1e-12);
    }

    #[test]
    fn the_reference_decides_who_is_cheap() {
        // The same Gene against a cheap and an expensive peer group: relative
        // to peers that cost more, it scores higher.
        let runs = [eval(true, 100, 5000.0)];
        let cheap_peers = ReferenceScale {
            latency_ms: 50.0,
            resource_cost: 1000.0,
        };
        let costly_peers = ReferenceScale {
            latency_ms: 500.0,
            resource_cost: 50_000.0,
        };
        let among_cheap = compute_fitness_with_reference(&runs, cheap_peers);
        let among_costly = compute_fitness_with_reference(&runs, costly_peers);
        assert!(among_costly.value > among_cheap.value);
    }

    #[test]
    fn compute_fitness_is_the_fallback_scale() {
        let runs = [eval(true, 120, 4321.0), eval(false, 60, 100.0)];
        let plain = compute_fitness(&runs);
        let explicit = compute_fitness_with_reference(&runs, ReferenceScale::FALLBACK);
        assert_eq!(plain.value, explicit.value);
        assert_eq!(plain.components.latency_score, explicit.components.latency_score);
    }

    #[test]
    fn an_unusable_reference_falls_back_instead_of_dividing_by_zero() {
        let runs = [eval(true, 120, 4321.0)];
        let fallback = compute_fitness(&runs).value;
        for bad in [
            ReferenceScale {
                latency_ms: 0.0,
                resource_cost: 1.0,
            },
            ReferenceScale {
                latency_ms: 1.0,
                resource_cost: -5.0,
            },
            ReferenceScale {
                latency_ms: f64::NAN,
                resource_cost: 1.0,
            },
            ReferenceScale {
                latency_ms: 1.0,
                resource_cost: f64::INFINITY,
            },
        ] {
            let v = compute_fitness_with_reference(&runs, bad).value;
            assert!(v.is_finite());
            assert_eq!(v, fallback);
        }
    }
}
