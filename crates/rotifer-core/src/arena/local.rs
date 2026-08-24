use std::collections::HashMap;

use super::{ArenaEngine, ArenaEntry, ArenaError};
use crate::fitness::FitnessScore;
use crate::types::gene::Gene;
use crate::types::GeneId;

/// Local single-binding Arena simulator for the Playground.
/// Maintains per-domain rankings based on fitness scores.
pub struct LocalArena {
    entries: HashMap<GeneId, ArenaEntry>,
}

impl LocalArena {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }
}

impl Default for LocalArena {
    fn default() -> Self {
        Self::new()
    }
}

impl ArenaEngine for LocalArena {
    fn submit(&mut self, gene: &Gene, fitness: FitnessScore) -> Result<ArenaEntry, ArenaError> {
        let now = chrono::Utc::now().timestamp_millis() as u64;

        let entry = ArenaEntry {
            gene_id: gene.id,
            domain: gene.phenotype.domain.clone(),
            fitness,
            rank: 0, // will be computed on rank()
            total_calls: 0,
            last_evaluated: now,
        };

        self.entries.insert(gene.id, entry.clone());
        self.recompute_ranks(&gene.phenotype.domain);

        Ok(self.entries.get(&gene.id).cloned().unwrap_or(entry))
    }

    fn rank(&self, domain: &str) -> Vec<ArenaEntry> {
        let mut domain_entries: Vec<ArenaEntry> = self
            .entries
            .values()
            .filter(|e| e.domain == domain)
            .cloned()
            .collect();

        domain_entries.sort_by(|a, b| {
            b.fitness
                .value
                .partial_cmp(&a.fitness.value)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for (i, entry) in domain_entries.iter_mut().enumerate() {
            entry.rank = (i + 1) as u32;
        }

        domain_entries
    }

    fn get_entry(&self, gene_id: &GeneId) -> Option<&ArenaEntry> {
        self.entries.get(gene_id)
    }

    fn all_entries(&self) -> Vec<&ArenaEntry> {
        self.entries.values().collect()
    }
}

impl LocalArena {
    fn recompute_ranks(&mut self, domain: &str) {
        let mut domain_ids: Vec<(GeneId, f64)> = self
            .entries
            .iter()
            .filter(|(_, e)| e.domain == domain)
            .map(|(id, e)| (*id, e.fitness.value))
            .collect();

        domain_ids.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        for (rank, (id, _)) in domain_ids.iter().enumerate() {
            if let Some(entry) = self.entries.get_mut(id) {
                entry.rank = (rank + 1) as u32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fitness::{FitnessComponents, FitnessScore};
    use crate::types::gene::{Fidelity, Gene, GeneTransparency, Phenotype};

    fn make_gene(domain: &str, fitness_value: f64) -> (Gene, FitnessScore) {
        let id_byte = (fitness_value * 100.0) as u8;
        let gene = Gene {
            id: [id_byte; 32],
            phenotype: Phenotype {
                domain: domain.to_string(),
                input_schema: serde_json::json!({"type": "object"}),
                output_schema: serde_json::json!({"type": "object"}),
                dependencies: vec![],
                version: "0.1.0".to_string(),
                author: "test".to_string(),
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
            wasm_bytes: None,
            source_code: None,
        };

        let fitness = FitnessScore {
            value: fitness_value,
            safety_score: 1.0,
            components: FitnessComponents {
                success_rate: fitness_value,
                latency_score: 1.0,
                resource_efficiency: 1.0,
                coverage: 0.5,
                robustness: 0.5,
            },
            formula_version: 2,
        };

        (gene, fitness)
    }

    #[test]
    fn test_ranking() {
        let mut arena = LocalArena::new();

        let (g1, f1) = make_gene("search.web", 0.9);
        let (g2, f2) = make_gene("search.web", 0.7);
        let (g3, f3) = make_gene("search.web", 0.8);

        arena.submit(&g1, f1).unwrap();
        arena.submit(&g2, f2).unwrap();
        arena.submit(&g3, f3).unwrap();

        let rankings = arena.rank("search.web");
        assert_eq!(rankings.len(), 3);
        assert_eq!(rankings[0].gene_id, g1.id); // 0.9 is #1
        assert_eq!(rankings[1].gene_id, g3.id); // 0.8 is #2
        assert_eq!(rankings[2].gene_id, g2.id); // 0.7 is #3
    }

    #[test]
    fn test_cross_domain_isolation() {
        let mut arena = LocalArena::new();

        let (g1, f1) = make_gene("search.web", 0.9);
        let (g2, f2) = make_gene("file.read", 0.5);

        arena.submit(&g1, f1).unwrap();
        arena.submit(&g2, f2).unwrap();

        assert_eq!(arena.rank("search.web").len(), 1);
        assert_eq!(arena.rank("file.read").len(), 1);
    }

    // ── Additional edge case tests ──

    #[test]
    fn rank_empty_arena() {
        let arena = LocalArena::new();
        assert!(arena.rank("any_domain").is_empty());
    }

    #[test]
    fn rank_nonexistent_domain() {
        let mut arena = LocalArena::new();
        let (g, f) = make_gene("domain.a", 0.5);
        arena.submit(&g, f).unwrap();
        assert!(arena.rank("domain.b").is_empty());
    }

    #[test]
    fn rank_single_entry() {
        let mut arena = LocalArena::new();
        let (g, f) = make_gene("d", 0.5);
        arena.submit(&g, f).unwrap();
        let rankings = arena.rank("d");
        assert_eq!(rankings.len(), 1);
        assert_eq!(rankings[0].rank, 1);
    }

    #[test]
    fn submit_duplicate_gene_id_updates() {
        let mut arena = LocalArena::new();
        let (g, f1) = make_gene("d", 0.5);
        arena.submit(&g, f1).unwrap();

        let f2 = FitnessScore {
            value: 0.9,
            safety_score: 1.0,
            components: FitnessComponents {
                success_rate: 0.9,
                latency_score: 1.0,
                resource_efficiency: 1.0,
                coverage: 0.5,
                robustness: 0.5,
            },
            formula_version: 2,
        };
        arena.submit(&g, f2).unwrap();

        let rankings = arena.rank("d");
        assert_eq!(rankings.len(), 1);
        assert!((rankings[0].fitness.value - 0.9).abs() < f64::EPSILON);
    }

    #[test]
    fn rank_equal_fitness_values() {
        let mut arena = LocalArena::new();
        let (g1, f1) = make_gene("d", 0.8);

        let mut g2_id = [0u8; 32];
        g2_id[0] = 99;
        let g2 = Gene {
            id: g2_id,
            phenotype: Phenotype {
                domain: "d".into(),
                input_schema: serde_json::json!({"type": "object"}),
                output_schema: serde_json::json!({"type": "object"}),
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
            wasm_bytes: None,
            source_code: None,
        };
        let f2 = FitnessScore {
            value: 0.8,
            safety_score: 1.0,
            components: FitnessComponents {
                success_rate: 0.8,
                latency_score: 1.0,
                resource_efficiency: 1.0,
                coverage: 0.5,
                robustness: 0.5,
            },
            formula_version: 2,
        };

        arena.submit(&g1, f1).unwrap();
        arena.submit(&g2, f2).unwrap();

        let rankings = arena.rank("d");
        assert_eq!(rankings.len(), 2);
        // Both should have valid ranks (1, 2) regardless of order
        let ranks: Vec<u32> = rankings.iter().map(|e| e.rank).collect();
        assert!(ranks.contains(&1));
        assert!(ranks.contains(&2));
    }

    #[test]
    fn get_entry_existing() {
        let mut arena = LocalArena::new();
        let (g, f) = make_gene("d", 0.7);
        arena.submit(&g, f).unwrap();
        assert!(arena.get_entry(&g.id).is_some());
    }

    #[test]
    fn get_entry_nonexistent() {
        let arena = LocalArena::new();
        assert!(arena.get_entry(&[0u8; 32]).is_none());
    }

    #[test]
    fn all_entries_empty_arena() {
        let arena = LocalArena::new();
        assert!(arena.all_entries().is_empty());
    }

    #[test]
    fn all_entries_mixed_domains() {
        let mut arena = LocalArena::new();
        let (g1, f1) = make_gene("a", 0.5);
        let (g2, f2) = make_gene("b", 0.6);
        arena.submit(&g1, f1).unwrap();
        arena.submit(&g2, f2).unwrap();
        assert_eq!(arena.all_entries().len(), 2);
    }

    #[test]
    fn default_trait() {
        let arena = LocalArena::default();
        assert!(arena.rank("x").is_empty());
    }
}
