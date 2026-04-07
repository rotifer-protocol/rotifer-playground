//! Reputation system for genes and developers.
//!
//! Gene reputation uses phase-based weights over Arena / Usage / Stability:
//! - W0 cold start (`ecosystem_downloads < 100`): `0.70 / 0.05 / 0.25`
//! - W1 normal growth (`ecosystem_downloads < 10_000`): `0.60 / 0.20 / 0.20`
//! - W2 mature ecosystem: `0.50 / 0.30 / 0.20`
//!
//! Developer reputation uses a diminishing-returns weighted sum of positive gene
//! reputations plus a capped community bonus:
//! `R(d) = Σ(positive R(g_i)) × ln(1+n) / n + community_bonus`
//!
//! The production source of truth remains the Supabase SQL implementation. This
//! module mirrors that behavior for local/runtime callers.

use serde::{Deserialize, Serialize};

const COLD_START_THRESHOLD: u64 = 100;
const MATURE_THRESHOLD: u64 = 10_000;
const COMMUNITY_BONUS_PER_WIN: f64 = 0.02;
const COMMUNITY_BONUS_CAP: f64 = 0.2;
const DECAY_RATE_PER_MONTH: f64 = 0.05;
const DECAY_FACTOR_FLOOR: f64 = 0.1;

/// Current ecosystem phase used to pick reputation weights.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReputationPhase {
    W0,
    W1,
    W2,
}

impl ReputationPhase {
    pub fn from_total_downloads(total_downloads: u64) -> Self {
        if total_downloads < COLD_START_THRESHOLD {
            Self::W0
        } else if total_downloads < MATURE_THRESHOLD {
            Self::W1
        } else {
            Self::W2
        }
    }

    pub fn weights(self) -> (f64, f64, f64) {
        match self {
            Self::W0 => (0.70, 0.05, 0.25),
            Self::W1 => (0.60, 0.20, 0.20),
            Self::W2 => (0.50, 0.30, 0.20),
        }
    }
}

/// Detailed reputation breakdown for a gene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneReputation {
    pub score: f64,
    pub arena_score: f64,
    pub usage_score: f64,
    pub stability_score: f64,
    pub epoch: u32,
    pub phase: ReputationPhase,
}

/// Detailed reputation breakdown for a developer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeveloperReputation {
    pub score: f64,
    pub genes_published: u32,
    pub total_downloads: u64,
    pub arena_wins: u32,
    pub community_bonus: f64,
}

/// Input metrics for computing gene reputation.
#[derive(Debug, Clone)]
pub struct GeneMetrics {
    pub fitness_value: f64,
    pub downloads: u64,
    pub total_calls: u32,
    pub ecosystem_downloads: u64,
}

/// Compute gene reputation from raw metrics.
///
/// ```
/// use rotifer_core::reputation::{compute_gene_reputation, GeneMetrics, ReputationPhase};
///
/// let metrics = GeneMetrics {
///     fitness_value: 0.85,
///     downloads: 100,
///     total_calls: 50,
///     ecosystem_downloads: 80,
/// };
/// let rep = compute_gene_reputation(&metrics, 1);
/// assert!(rep.score > 0.0);
/// assert!(rep.score <= 1.0);
/// assert_eq!(rep.phase, ReputationPhase::W0);
/// ```
pub fn compute_gene_reputation(metrics: &GeneMetrics, epoch: u32) -> GeneReputation {
    let phase = ReputationPhase::from_total_downloads(metrics.ecosystem_downloads);
    let (w_arena, w_usage, w_stability) = phase.weights();

    let arena_score = metrics.fitness_value.clamp(0.0, 1.0);

    let usage_score = if metrics.downloads > 0 {
        ((metrics.downloads as f64 + 1.0).ln() / 1000_f64.ln()).min(1.0)
    } else {
        0.0
    };

    let stability_score = if metrics.total_calls > 0 {
        ((metrics.total_calls as f64 + 1.0).ln() / 101_f64.ln()).min(1.0)
    } else {
        0.0
    };

    let score = w_arena * arena_score + w_usage * usage_score + w_stability * stability_score;

    GeneReputation {
        score,
        arena_score,
        usage_score,
        stability_score,
        epoch,
        phase,
    }
}

/// Optional helper for the planned v0.9 inactivity decay model.
///
/// This helper is not part of the current production reputation pipeline.
pub fn apply_decay(score: f64, idle_months: u32) -> f64 {
    let decay_factor = (1.0 - DECAY_RATE_PER_MONTH * idle_months as f64).max(DECAY_FACTOR_FLOOR);
    score * decay_factor
}

/// Compute developer reputation from their gene reputations.
pub fn compute_developer_reputation(
    gene_reputations: &[f64],
    arena_wins: u32,
) -> DeveloperReputation {
    let positive_gene_reputations: Vec<f64> = gene_reputations
        .iter()
        .copied()
        .filter(|score| *score > 0.0)
        .collect();

    let gene_contribution = if positive_gene_reputations.is_empty() {
        0.0
    } else {
        let gene_count = positive_gene_reputations.len() as f64;
        let reputation_sum = positive_gene_reputations.iter().sum::<f64>();
        reputation_sum * (1.0 + gene_count).ln() / gene_count
    };

    let community_bonus = (arena_wins as f64 * COMMUNITY_BONUS_PER_WIN).min(COMMUNITY_BONUS_CAP);
    let score = gene_contribution + community_bonus;

    DeveloperReputation {
        score,
        genes_published: gene_reputations.len() as u32,
        total_downloads: 0,
        arena_wins,
        community_bonus,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_metrics_gives_zero_reputation() {
        let metrics = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 0,
            ecosystem_downloads: 0,
        };
        let rep = compute_gene_reputation(&metrics, 0);
        assert!((rep.score - 0.0).abs() < f64::EPSILON);
        assert_eq!(rep.phase, ReputationPhase::W0);
    }

    #[test]
    fn perfect_metrics_gives_full_reputation() {
        let metrics = GeneMetrics {
            fitness_value: 1.0,
            downloads: 10000,
            total_calls: 200,
            ecosystem_downloads: 80,
        };
        let rep = compute_gene_reputation(&metrics, 1);
        assert!((rep.score - 1.0).abs() < 0.001);
        assert_eq!(rep.arena_score, 1.0);
    }

    #[test]
    fn fitness_clamps_to_one() {
        let metrics = GeneMetrics {
            fitness_value: 1.5,
            downloads: 0,
            total_calls: 0,
            ecosystem_downloads: 0,
        };
        let rep = compute_gene_reputation(&metrics, 0);
        assert!((rep.arena_score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn phase_thresholds_match_sql_logic() {
        assert_eq!(ReputationPhase::from_total_downloads(0), ReputationPhase::W0);
        assert_eq!(ReputationPhase::from_total_downloads(99), ReputationPhase::W0);
        assert_eq!(ReputationPhase::from_total_downloads(100), ReputationPhase::W1);
        assert_eq!(ReputationPhase::from_total_downloads(9_999), ReputationPhase::W1);
        assert_eq!(ReputationPhase::from_total_downloads(10_000), ReputationPhase::W2);
    }

    #[test]
    fn mature_phase_shifts_more_weight_to_usage() {
        let metrics = GeneMetrics {
            fitness_value: 0.5,
            downloads: 1000,
            total_calls: 50,
            ecosystem_downloads: 0,
        };

        let w0 = compute_gene_reputation(&metrics, 0);
        let w2 = compute_gene_reputation(
            &GeneMetrics {
                ecosystem_downloads: 10_000,
                ..metrics
            },
            0,
        );

        assert_eq!(w0.phase, ReputationPhase::W0);
        assert_eq!(w2.phase, ReputationPhase::W2);
        assert!(w2.score > w0.score);
    }

    #[test]
    fn decay_reduces_score_after_one_month() {
        let decayed = apply_decay(0.8, 1);
        assert!((decayed - 0.76).abs() < 0.001);
    }

    #[test]
    fn decay_factor_floors_at_ten_percent() {
        let decayed = apply_decay(1.0, 100);
        assert!((decayed - 0.1).abs() < f64::EPSILON);
    }

    #[test]
    fn developer_reputation_empty_genes() {
        let rep = compute_developer_reputation(&[], 0);
        assert!((rep.score - 0.0).abs() < f64::EPSILON);
        assert_eq!(rep.genes_published, 0);
    }

    #[test]
    fn developer_reputation_uses_diminishing_returns_sum() {
        let reps = vec![0.5, 0.7, 0.9];
        let rep = compute_developer_reputation(&reps, 3);
        let expected_bonus = 3.0 * COMMUNITY_BONUS_PER_WIN;
        let expected_gene_contribution = (0.5 + 0.7 + 0.9) * (1.0_f64 + 3.0).ln() / 3.0;
        assert!((rep.score - (expected_gene_contribution + expected_bonus)).abs() < 0.001);
    }

    #[test]
    fn developer_reputation_ignores_zero_or_negative_scores() {
        let rep = compute_developer_reputation(&[-0.2, 0.0, 0.9], 0);
        let expected = 0.9 * (1.0_f64 + 1.0).ln();
        assert!((rep.score - expected).abs() < 0.001);
        assert_eq!(rep.genes_published, 3);
    }

    #[test]
    fn community_bonus_capped() {
        let reps = vec![0.5];
        let rep = compute_developer_reputation(&reps, 100);
        assert!((rep.community_bonus - COMMUNITY_BONUS_CAP).abs() < f64::EPSILON);
    }

    #[test]
    fn usage_score_log_scaled() {
        let m1 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 1,
            total_calls: 0,
            ecosystem_downloads: 0,
        };
        let m2 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 100,
            total_calls: 0,
            ecosystem_downloads: 0,
        };
        let m3 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 10000,
            total_calls: 0,
            ecosystem_downloads: 0,
        };

        let r1 = compute_gene_reputation(&m1, 0);
        let r2 = compute_gene_reputation(&m2, 0);
        let r3 = compute_gene_reputation(&m3, 0);

        assert!(r1.usage_score < r2.usage_score);
        assert!(r2.usage_score < r3.usage_score);
    }

    #[test]
    fn stability_score_scales_logarithmically() {
        let m1 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 10,
            ecosystem_downloads: 0,
        };
        let m2 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 50,
            ecosystem_downloads: 0,
        };
        let m3 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 100,
            ecosystem_downloads: 0,
        };
        let m4 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 200,
            ecosystem_downloads: 0,
        };

        let r1 = compute_gene_reputation(&m1, 0);
        let r2 = compute_gene_reputation(&m2, 0);
        let r3 = compute_gene_reputation(&m3, 0);
        let r4 = compute_gene_reputation(&m4, 0);

        assert!(r1.stability_score < r2.stability_score);
        assert!(r2.stability_score < r3.stability_score);
        assert!((r3.stability_score - 1.0).abs() < f64::EPSILON);
        assert!((r4.stability_score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn epoch_and_phase_tracked() {
        let metrics = GeneMetrics {
            fitness_value: 0.5,
            downloads: 0,
            total_calls: 0,
            ecosystem_downloads: 500,
        };
        let rep = compute_gene_reputation(&metrics, 42);
        assert_eq!(rep.epoch, 42);
        assert_eq!(rep.phase, ReputationPhase::W1);
    }
}
