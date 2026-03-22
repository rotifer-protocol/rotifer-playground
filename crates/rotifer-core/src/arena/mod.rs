//! L0 Arena — competitive, fitness-ranked gene selection per §4.
//!
//! Genes compete within a domain; the Arena maintains ranked leaderboards
//! and decides which genes survive to propagate.

mod local;

pub use local::LocalArena;

use crate::fitness::FitnessScore;
use crate::types::gene::Gene;
use crate::types::{GeneId, Timestamp};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Errors from Arena operations.
#[derive(Debug, Error)]
pub enum ArenaError {
    #[error("gene not found: {0}")]
    GeneNotFound(String),
    #[error("evaluation failed: {0}")]
    EvaluationFailed(String),
    #[error("storage error: {0}")]
    StorageError(String),
}

/// A gene's current standing in the Arena leaderboard.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArenaEntry {
    pub gene_id: GeneId,
    pub domain: String,
    pub fitness: FitnessScore,
    pub rank: u32,
    pub total_calls: u64,
    pub last_evaluated: Timestamp,
}

/// Trait for Arena implementations (local simulator, on-chain, etc.).
pub trait ArenaEngine: Send + Sync {
    /// Submit a gene with its fitness score; returns the resulting leaderboard entry.
    fn submit(&mut self, gene: &Gene, fitness: FitnessScore) -> Result<ArenaEntry, ArenaError>;
    /// Return the ranked leaderboard for a domain, sorted by fitness descending.
    fn rank(&self, domain: &str) -> Vec<ArenaEntry>;
    /// Look up a single gene's entry by ID.
    fn get_entry(&self, gene_id: &GeneId) -> Option<&ArenaEntry>;
    /// Return all entries across all domains.
    fn all_entries(&self) -> Vec<&ArenaEntry>;
}
