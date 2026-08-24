use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use super::{AgentStore, ArenaStore, GeneStore, StorageError};
use crate::arena::ArenaEntry;
use crate::types::agent::Agent;
use crate::types::gene::Gene;
use crate::types::GeneId;

/// SQLite-backed implementation of [`GeneStore`], [`AgentStore`], and [`ArenaStore`].
pub struct SqliteStore {
    conn: Mutex<Connection>,
}

impl SqliteStore {
    /// Open (or create) a database at the given file path.
    pub fn new(path: &Path) -> Result<Self, StorageError> {
        let conn = Connection::open(path)
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?;

        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init_tables()?;
        Ok(store)
    }

    /// Create an ephemeral in-memory database (useful for tests).
    pub fn in_memory() -> Result<Self, StorageError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?;

        let store = Self {
            conn: Mutex::new(conn),
        };
        store.init_tables()?;
        Ok(store)
    }

    fn init_tables(&self) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS genes (
                id BLOB PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS arena_entries (
                gene_id BLOB PRIMARY KEY,
                domain TEXT NOT NULL,
                data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_arena_domain ON arena_entries(domain);"
        )
        .map_err(|e| StorageError::DatabaseError(e.to_string()))
    }
}

impl GeneStore for SqliteStore {
    fn save_gene(&self, gene: &Gene) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        let data = serde_json::to_string(gene)
            .map_err(|e| StorageError::SerializationError(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO genes (id, data) VALUES (?1, ?2)",
            params![gene.id.as_slice(), data],
        )
        .map_err(|e| StorageError::DatabaseError(e.to_string()))?;
        Ok(())
    }

    fn get_gene(&self, id: &GeneId) -> Result<Option<Gene>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM genes WHERE id = ?1")
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?;

        let result = stmt.query_row(params![id.as_slice()], |row| {
            let data: String = row.get(0)?;
            Ok(data)
        });

        match result {
            Ok(data) => {
                let gene: Gene = serde_json::from_str(&data)
                    .map_err(|e| StorageError::SerializationError(e.to_string()))?;
                Ok(Some(gene))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::DatabaseError(e.to_string())),
        }
    }

    fn list_genes(&self, domain: Option<&str>) -> Result<Vec<Gene>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM genes")
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?;

        let genes: Vec<Gene> = stmt
            .query_map([], |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?
            .filter_map(|r| r.ok())
            .filter_map(|data| serde_json::from_str::<Gene>(&data).ok())
            .filter(|gene| {
                domain
                    .map(|d| gene.phenotype.domain == d)
                    .unwrap_or(true)
            })
            .collect();

        Ok(genes)
    }

    fn delete_gene(&self, id: &GeneId) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM genes WHERE id = ?1", params![id.as_slice()])
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?;
        Ok(())
    }
}

impl AgentStore for SqliteStore {
    fn save_agent(&self, agent: &Agent) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        let data = serde_json::to_string(agent)
            .map_err(|e| StorageError::SerializationError(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO agents (id, data) VALUES (?1, ?2)",
            params![agent.id, data],
        )
        .map_err(|e| StorageError::DatabaseError(e.to_string()))?;
        Ok(())
    }

    fn get_agent(&self, id: &str) -> Result<Option<Agent>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM agents WHERE id = ?1")
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?;

        let result = stmt.query_row(params![id], |row| {
            let data: String = row.get(0)?;
            Ok(data)
        });

        match result {
            Ok(data) => {
                let agent: Agent = serde_json::from_str(&data)
                    .map_err(|e| StorageError::SerializationError(e.to_string()))?;
                Ok(Some(agent))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(StorageError::DatabaseError(e.to_string())),
        }
    }

    fn list_agents(&self) -> Result<Vec<Agent>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM agents")
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?;

        let agents: Vec<Agent> = stmt
            .query_map([], |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?
            .filter_map(|r| r.ok())
            .filter_map(|data| serde_json::from_str::<Agent>(&data).ok())
            .collect();

        Ok(agents)
    }
}

impl ArenaStore for SqliteStore {
    fn save_entry(&self, entry: &ArenaEntry) -> Result<(), StorageError> {
        let conn = self.conn.lock().unwrap();
        let data = serde_json::to_string(entry)
            .map_err(|e| StorageError::SerializationError(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO arena_entries (gene_id, domain, data) VALUES (?1, ?2, ?3)",
            params![entry.gene_id.as_slice(), entry.domain, data],
        )
        .map_err(|e| StorageError::DatabaseError(e.to_string()))?;
        Ok(())
    }

    fn get_rankings(&self, domain: &str) -> Result<Vec<ArenaEntry>, StorageError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM arena_entries WHERE domain = ?1")
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?;

        let mut entries: Vec<ArenaEntry> = stmt
            .query_map(params![domain], |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .map_err(|e| StorageError::DatabaseError(e.to_string()))?
            .filter_map(|r| r.ok())
            .filter_map(|data| serde_json::from_str::<ArenaEntry>(&data).ok())
            .collect();

        entries.sort_by_key(|a| a.rank);
        Ok(entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fitness::{FitnessComponents, FitnessScore};
    use crate::types::gene::{Fidelity, GeneTransparency, Phenotype};

    fn make_gene_obj(id_byte: u8, domain: &str) -> Gene {
        let mut gene_id = [0u8; 32];
        gene_id[0] = id_byte;
        Gene {
            id: gene_id,
            phenotype: Phenotype {
                domain: domain.into(),
                input_schema: serde_json::json!({"type": "object"}),
                output_schema: serde_json::json!({"type": "object"}),
                dependencies: vec![],
                version: "0.1.0".into(),
                author: "test".into(),
                created_at: 1000,
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
        }
    }

    fn make_entry(id_byte: u8, domain: &str, rank: u32) -> ArenaEntry {
        let mut gene_id = [0u8; 32];
        gene_id[0] = id_byte;
        ArenaEntry {
            gene_id,
            domain: domain.into(),
            fitness: FitnessScore {
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
            },
            rank,
            total_calls: 10,
            last_evaluated: 1000,
        }
    }

    // ── GeneStore ──

    #[test]
    fn gene_save_and_get_roundtrip() {
        let store = SqliteStore::in_memory().unwrap();
        let gene = make_gene_obj(1, "test.domain");
        store.save_gene(&gene).unwrap();
        let fetched = store.get_gene(&gene.id).unwrap().unwrap();
        assert_eq!(fetched.id, gene.id);
        assert_eq!(fetched.phenotype.domain, "test.domain");
    }

    #[test]
    fn gene_get_nonexistent_returns_none() {
        let store = SqliteStore::in_memory().unwrap();
        let result = store.get_gene(&[0u8; 32]).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn gene_list_all_no_filter() {
        let store = SqliteStore::in_memory().unwrap();
        for i in 1..=3 {
            store.save_gene(&make_gene_obj(i, "test")).unwrap();
        }
        let all = store.list_genes(None).unwrap();
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn gene_list_with_domain_filter() {
        let store = SqliteStore::in_memory().unwrap();
        store.save_gene(&make_gene_obj(1, "alpha")).unwrap();
        store.save_gene(&make_gene_obj(2, "beta")).unwrap();
        store.save_gene(&make_gene_obj(3, "alpha")).unwrap();
        let filtered = store.list_genes(Some("alpha")).unwrap();
        assert_eq!(filtered.len(), 2);
    }

    #[test]
    fn gene_list_empty_store() {
        let store = SqliteStore::in_memory().unwrap();
        let all = store.list_genes(None).unwrap();
        assert!(all.is_empty());
    }

    #[test]
    fn gene_delete_then_get_returns_none() {
        let store = SqliteStore::in_memory().unwrap();
        let gene = make_gene_obj(1, "test");
        store.save_gene(&gene).unwrap();
        store.delete_gene(&gene.id).unwrap();
        assert!(store.get_gene(&gene.id).unwrap().is_none());
    }

    #[test]
    fn gene_delete_nonexistent_is_noop() {
        let store = SqliteStore::in_memory().unwrap();
        let result = store.delete_gene(&[0u8; 32]);
        assert!(result.is_ok());
    }

    #[test]
    fn gene_save_twice_upserts() {
        let store = SqliteStore::in_memory().unwrap();
        let mut gene = make_gene_obj(1, "domain.a");
        store.save_gene(&gene).unwrap();

        gene.phenotype.domain = "domain.b".into();
        store.save_gene(&gene).unwrap();

        let fetched = store.get_gene(&gene.id).unwrap().unwrap();
        assert_eq!(fetched.phenotype.domain, "domain.b");
        assert_eq!(store.list_genes(None).unwrap().len(), 1);
    }

    // ── AgentStore ──

    #[test]
    fn agent_save_and_get_roundtrip() {
        let store = SqliteStore::in_memory().unwrap();
        let agent = Agent::new("agent-1".into());
        store.save_agent(&agent).unwrap();
        let fetched = store.get_agent(&agent.id).unwrap().unwrap();
        assert_eq!(fetched.name, "agent-1");
        assert_eq!(fetched.id, agent.id);
    }

    #[test]
    fn agent_get_nonexistent_returns_none() {
        let store = SqliteStore::in_memory().unwrap();
        assert!(store.get_agent("no-such-id").unwrap().is_none());
    }

    #[test]
    fn agent_list_empty_store() {
        let store = SqliteStore::in_memory().unwrap();
        assert!(store.list_agents().unwrap().is_empty());
    }

    #[test]
    fn agent_list_multiple() {
        let store = SqliteStore::in_memory().unwrap();
        for i in 0..3 {
            store.save_agent(&Agent::new(format!("a{i}"))).unwrap();
        }
        assert_eq!(store.list_agents().unwrap().len(), 3);
    }

    // ── ArenaStore ──

    #[test]
    fn arena_save_entry_and_get_rankings() {
        let store = SqliteStore::in_memory().unwrap();
        let entry = make_entry(1, "search", 1);
        store.save_entry(&entry).unwrap();
        let rankings = store.get_rankings("search").unwrap();
        assert_eq!(rankings.len(), 1);
        assert_eq!(rankings[0].gene_id, entry.gene_id);
    }

    #[test]
    fn arena_get_rankings_sorted_by_rank() {
        let store = SqliteStore::in_memory().unwrap();
        store.save_entry(&make_entry(1, "d", 3)).unwrap();
        store.save_entry(&make_entry(2, "d", 1)).unwrap();
        store.save_entry(&make_entry(3, "d", 2)).unwrap();
        let rankings = store.get_rankings("d").unwrap();
        assert_eq!(rankings[0].rank, 1);
        assert_eq!(rankings[1].rank, 2);
        assert_eq!(rankings[2].rank, 3);
    }

    #[test]
    fn arena_get_rankings_empty_domain() {
        let store = SqliteStore::in_memory().unwrap();
        let rankings = store.get_rankings("nonexistent").unwrap();
        assert!(rankings.is_empty());
    }

    #[test]
    fn arena_save_entry_upsert() {
        let store = SqliteStore::in_memory().unwrap();
        let mut entry = make_entry(1, "d", 1);
        store.save_entry(&entry).unwrap();
        entry.rank = 5;
        store.save_entry(&entry).unwrap();
        let rankings = store.get_rankings("d").unwrap();
        assert_eq!(rankings.len(), 1);
        assert_eq!(rankings[0].rank, 5);
    }

    #[test]
    fn special_characters_in_agent_name() {
        let store = SqliteStore::in_memory().unwrap();
        let agent = Agent::new("agent'; DROP TABLE agents; --".into());
        store.save_agent(&agent).unwrap();
        let fetched = store.get_agent(&agent.id).unwrap().unwrap();
        assert_eq!(fetched.name, "agent'; DROP TABLE agents; --");
        assert_eq!(store.list_agents().unwrap().len(), 1);
    }

    #[test]
    fn unicode_in_domain_and_name() {
        let store = SqliteStore::in_memory().unwrap();
        let gene = make_gene_obj(1, "搜索.网页");
        store.save_gene(&gene).unwrap();
        let fetched = store.get_gene(&gene.id).unwrap().unwrap();
        assert_eq!(fetched.phenotype.domain, "搜索.网页");

        let agent = Agent::new("代理αβγ".into());
        store.save_agent(&agent).unwrap();
        let fetched_agent = store.get_agent(&agent.id).unwrap().unwrap();
        assert_eq!(fetched_agent.name, "代理αβγ");
    }

    #[test]
    fn concurrent_read_write() {
        use std::sync::Arc;
        let store = Arc::new(SqliteStore::in_memory().unwrap());
        let handles: Vec<_> = (0..4u8)
            .map(|i| {
                let s = Arc::clone(&store);
                std::thread::spawn(move || {
                    let gene = make_gene_obj(i, "concurrent");
                    s.save_gene(&gene).unwrap();
                    s.get_gene(&gene.id).unwrap().unwrap();
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(store.list_genes(None).unwrap().len(), 4);
    }
}
