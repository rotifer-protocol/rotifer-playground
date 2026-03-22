//! Reputation system for genes and developers.
//!
//! R(g) = α·arena_score + β·usage_score + γ·stability_score
//! where α=0.5, β=0.3, γ=0.2
//!
//! Developer reputation R(d) = avg(R(g_i)) + community_bonus

use serde::{Deserialize, Serialize};

const ALPHA: f64 = 0.5;
const BETA: f64 = 0.3;
const GAMMA: f64 = 0.2;
const DECAY_RATE: f64 = 0.05;
const DECAY_FLOOR: f64 = 0.01;

/// Detailed reputation breakdown for a gene.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneReputation {
    pub score: f64,
    pub arena_score: f64,
    pub usage_score: f64,
    pub stability_score: f64,
    pub epoch: u32,
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
}

/// Compute gene reputation from raw metrics.
///
/// ```
/// use rotifer_core::reputation::{compute_gene_reputation, GeneMetrics};
///
/// let metrics = GeneMetrics {
///     fitness_value: 0.85,
///     downloads: 100,
///     total_calls: 50,
/// };
/// let rep = compute_gene_reputation(&metrics, 1);
/// assert!(rep.score > 0.0);
/// assert!(rep.score <= 1.2);
/// ```
pub fn compute_gene_reputation(metrics: &GeneMetrics, epoch: u32) -> GeneReputation {
    let arena_score = metrics.fitness_value.clamp(0.0, 1.0);

    let usage_score = if metrics.downloads > 0 {
        ((metrics.downloads as f64 + 1.0).ln() / 1000_f64.ln()).min(1.0)
    } else {
        0.0
    };

    let stability_score = if metrics.total_calls > 0 {
        (metrics.total_calls as f64 / 100.0).min(1.0)
    } else {
        0.0
    };

    let score = ALPHA * arena_score + BETA * usage_score + GAMMA * stability_score;

    GeneReputation {
        score,
        arena_score,
        usage_score,
        stability_score,
        epoch,
    }
}

/// Apply time-based decay to a reputation score.
/// Returns the decayed score, floored at `DECAY_FLOOR`.
pub fn apply_decay(score: f64) -> f64 {
    let decayed = score * (1.0 - DECAY_RATE);
    if decayed < DECAY_FLOOR {
        DECAY_FLOOR
    } else {
        decayed
    }
}

/// Compute developer reputation from their gene reputations.
pub fn compute_developer_reputation(
    gene_reputations: &[f64],
    arena_wins: u32,
) -> DeveloperReputation {
    let avg_gene_rep = if gene_reputations.is_empty() {
        0.0
    } else {
        gene_reputations.iter().sum::<f64>() / gene_reputations.len() as f64
    };

    let community_bonus = (arena_wins as f64 * 0.02).min(0.2);
    let score = avg_gene_rep + community_bonus;

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
        };
        let rep = compute_gene_reputation(&metrics, 0);
        assert!((rep.score - 0.0).abs() < f64::EPSILON);
    }

    #[test]
    fn perfect_metrics_gives_high_reputation() {
        let metrics = GeneMetrics {
            fitness_value: 1.0,
            downloads: 10000,
            total_calls: 200,
        };
        let rep = compute_gene_reputation(&metrics, 1);
        assert!(rep.score > 0.8);
        assert!(rep.arena_score == 1.0);
    }

    #[test]
    fn fitness_clamps_to_one() {
        let metrics = GeneMetrics {
            fitness_value: 1.5,
            downloads: 0,
            total_calls: 0,
        };
        let rep = compute_gene_reputation(&metrics, 0);
        assert!((rep.arena_score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn decay_reduces_score() {
        let original = 0.8;
        let decayed = apply_decay(original);
        assert!(decayed < original);
        assert!((decayed - 0.76).abs() < 0.001);
    }

    #[test]
    fn decay_respects_floor() {
        let tiny = 0.005;
        let decayed = apply_decay(tiny);
        assert!((decayed - DECAY_FLOOR).abs() < f64::EPSILON);
    }

    #[test]
    fn repeated_decay_converges_to_floor() {
        let mut score = 1.0;
        for _ in 0..1000 {
            score = apply_decay(score);
        }
        assert!((score - DECAY_FLOOR).abs() < f64::EPSILON);
    }

    #[test]
    fn developer_reputation_empty_genes() {
        let rep = compute_developer_reputation(&[], 0);
        assert!((rep.score - 0.0).abs() < f64::EPSILON);
        assert_eq!(rep.genes_published, 0);
    }

    #[test]
    fn developer_reputation_with_genes() {
        let reps = vec![0.5, 0.7, 0.9];
        let rep = compute_developer_reputation(&reps, 3);
        let expected_avg = (0.5 + 0.7 + 0.9) / 3.0;
        let expected_bonus = 3.0 * 0.02;
        assert!((rep.score - (expected_avg + expected_bonus)).abs() < 0.001);
    }

    #[test]
    fn community_bonus_capped() {
        let reps = vec![0.5];
        let rep = compute_developer_reputation(&reps, 100);
        assert!((rep.community_bonus - 0.2).abs() < f64::EPSILON);
    }

    #[test]
    fn usage_score_log_scaled() {
        let m1 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 1,
            total_calls: 0,
        };
        let m2 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 100,
            total_calls: 0,
        };
        let m3 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 10000,
            total_calls: 0,
        };

        let r1 = compute_gene_reputation(&m1, 0);
        let r2 = compute_gene_reputation(&m2, 0);
        let r3 = compute_gene_reputation(&m3, 0);

        assert!(r1.usage_score < r2.usage_score);
        assert!(r2.usage_score < r3.usage_score);
    }

    #[test]
    fn stability_score_scales_linearly() {
        let m1 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 10,
        };
        let m2 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 50,
        };
        let m3 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 100,
        };
        let m4 = GeneMetrics {
            fitness_value: 0.0,
            downloads: 0,
            total_calls: 200,
        };

        let r1 = compute_gene_reputation(&m1, 0);
        let r2 = compute_gene_reputation(&m2, 0);
        let r3 = compute_gene_reputation(&m3, 0);
        let r4 = compute_gene_reputation(&m4, 0);

        assert!(r1.stability_score < r2.stability_score);
        assert!(r2.stability_score < r3.stability_score);
        // Caps at 1.0
        assert!((r3.stability_score - 1.0).abs() < f64::EPSILON);
        assert!((r4.stability_score - 1.0).abs() < f64::EPSILON);
    }

    #[test]
    fn epoch_tracked() {
        let m = GeneMetrics {
            fitness_value: 0.5,
            downloads: 0,
            total_calls: 0,
        };
        let r = compute_gene_reputation(&m, 42);
        assert_eq!(r.epoch, 42);
    }
}
