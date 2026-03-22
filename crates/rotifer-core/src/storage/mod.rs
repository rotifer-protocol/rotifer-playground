//! Persistent storage traits and SQLite implementation.

mod sqlite;

pub use self::sqlite::SqliteStore;

use crate::arena::ArenaEntry;
use crate::types::agent::Agent;
use crate::types::gene::Gene;
use crate::types::GeneId;
use thiserror::Error;

/// Errors from the storage layer.
#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    DatabaseError(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("serialization error: {0}")]
    SerializationError(String),
}

/// CRUD interface for gene persistence.
pub trait GeneStore: Send + Sync {
    fn save_gene(&self, gene: &Gene) -> Result<(), StorageError>;
    fn get_gene(&self, id: &GeneId) -> Result<Option<Gene>, StorageError>;
    fn list_genes(&self, domain: Option<&str>) -> Result<Vec<Gene>, StorageError>;
    fn delete_gene(&self, id: &GeneId) -> Result<(), StorageError>;
}

/// CRUD interface for agent persistence.
pub trait AgentStore: Send + Sync {
    fn save_agent(&self, agent: &Agent) -> Result<(), StorageError>;
    fn get_agent(&self, id: &str) -> Result<Option<Agent>, StorageError>;
    fn list_agents(&self) -> Result<Vec<Agent>, StorageError>;
}

/// Interface for storing arena leaderboard entries.
pub trait ArenaStore: Send + Sync {
    fn save_entry(&self, entry: &ArenaEntry) -> Result<(), StorageError>;
    fn get_rankings(&self, domain: &str) -> Result<Vec<ArenaEntry>, StorageError>;
}
