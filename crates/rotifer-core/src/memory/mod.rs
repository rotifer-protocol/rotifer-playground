//! AgentMemory (spec §38, v0.9.4): memory that belongs to an agent rather
//! than to any gene, so it survives the genome changing.
//!
//! - [`types`]: the §38.1 types in their v0.9.4 wire shape.
//! - [`store`]: SQLite persistence, quota and eviction, and the §38.2 L0
//!   permission check.
//! - [`events`]: lifecycle lines for `.rotifer/audit.jsonl` and §17 events.

pub mod events;
pub mod store;
pub mod types;

pub use events::{JsonlSink, MemoryEventSink, NullSink, RecordingSink};
pub use store::{AdminDelete, ImportOptions, MemoryStore};
pub use types::{
    AccessScope, AgentMemory, CallerGene, DEFAULT_QUOTA_BYTES, MAX_QUERY_RESPONSE_BYTES,
    MAX_VALUE_BYTES, MemoryAccessPolicy, MemoryCategory, MemoryEntry, MemoryError, MemoryFilter,
    RetentionPolicy, SharePolicy, entry_id,
};

#[cfg(test)]
mod tests;
