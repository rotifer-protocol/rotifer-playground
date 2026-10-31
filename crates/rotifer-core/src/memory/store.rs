//! SQLite-backed AgentMemory: the `agent_memory_entries` table, the quota
//! and its eviction order (§38.1), and the L0
//! permission check every gene call passes through (§38.2).
//!
//! Memory is keyed by agent id only. Nothing here reads or depends on the
//! agent's genome, so replacing genes cannot touch it (§38.1).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{Connection, OptionalExtension, Row, TransactionBehavior, params};

use super::events::{MemoryAction, MemoryAuditEvent, MemoryEventSink, MemoryTelemetryEvent};
use super::types::{
    AccessScope, AgentMemory, CallerGene, DEFAULT_QUERY_LIMIT, DEFAULT_QUOTA_BYTES, MAX_KEY_BYTES,
    MAX_QUERY_LIMIT, MAX_QUERY_RESPONSE_BYTES, MAX_VALUE_BYTES, MemoryAccessPolicy, MemoryCategory,
    MemoryEntry, MemoryError, MemoryFilter, RetentionPolicy, SharePolicy, entry_id,
    format_rfc3339_ms,
};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS agent_memories (
    agent_id        TEXT PRIMARY KEY,
    quota           INTEGER NOT NULL CHECK (quota > 0),
    created_at      INTEGER NOT NULL,
    retention_days  INTEGER CHECK (retention_days IS NULL OR retention_days > 0)
);
CREATE TABLE IF NOT EXISTS agent_memory_entries (
    entry_id          TEXT PRIMARY KEY,
    agent_id          TEXT NOT NULL REFERENCES agent_memories(agent_id),
    category          TEXT NOT NULL CHECK (category IN ('PREFERENCE','PATTERN','CONTEXT','CACHE')),
    key               TEXT NOT NULL,
    value             BLOB NOT NULL,
    created_by        TEXT NOT NULL,
    creator_domain    TEXT NOT NULL,
    last_accessed_by  TEXT,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    read_scope        TEXT NOT NULL CHECK (read_scope IN ('CREATOR_GENE_ONLY','SAME_DOMAIN','ALL_GENES','DEPLOYER_CONFIGURED')),
    write_scope       TEXT NOT NULL CHECK (write_scope IN ('CREATOR_GENE_ONLY','SAME_DOMAIN','ALL_GENES','DEPLOYER_CONFIGURED')),
    share_policy      TEXT NOT NULL CHECK (share_policy IN ('PRIVATE','ANONYMIZED_SHARE','KNOWLEDGE_GENE')),
    retention_policy  TEXT,
    UNIQUE (agent_id, key)
);
CREATE INDEX IF NOT EXISTS idx_agent_memory_entries_age
    ON agent_memory_entries (agent_id, category, updated_at);
";

const ENTRY_COLUMNS: &str = "entry_id, category, key, value, created_by, last_accessed_by, created_at, \
     updated_at, read_scope, write_scope, share_policy, retention_policy, creator_domain";

/// An entry as stored: the wire entry plus the creator's domain, which
/// SAME_DOMAIN compares and which is not a wire field.
struct StoredEntry {
    entry: MemoryEntry,
    creator_domain: String,
}

fn row_to_stored(row: &Row<'_>) -> rusqlite::Result<(StoredEntry, Vec<String>)> {
    let category: String = row.get(1)?;
    let read_scope: String = row.get(8)?;
    let write_scope: String = row.get(9)?;
    let share_policy: String = row.get(10)?;
    let retention: Option<String> = row.get(11)?;
    // Enum text and retention JSON are parsed by the caller (parse errors are
    // MemoryError, not rusqlite errors); carry them through as strings.
    let raw = vec![
        category,
        read_scope,
        write_scope,
        share_policy,
        retention.unwrap_or_default(),
    ];
    let stored = StoredEntry {
        entry: MemoryEntry {
            entry_id: row.get(0)?,
            category: MemoryCategory::Cache,
            key: row.get(2)?,
            value: row.get(3)?,
            created_by: row.get(4)?,
            last_accessed_by: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            access_policy: MemoryAccessPolicy::default(),
            retention_policy: None,
        },
        creator_domain: row.get(12)?,
    };
    Ok((stored, raw))
}

fn retention_json(r: Option<RetentionPolicy>) -> Result<Option<String>, MemoryError> {
    r.map(|r| serde_json::to_string(&r))
        .transpose()
        .map_err(|e| MemoryError::Storage(e.to_string()))
}

fn finish_stored(
    (mut stored, raw): (StoredEntry, Vec<String>),
) -> Result<StoredEntry, MemoryError> {
    stored.entry.category = MemoryCategory::parse(&raw[0])?;
    stored.entry.access_policy = MemoryAccessPolicy {
        read_scope: AccessScope::parse(&raw[1])?,
        write_scope: AccessScope::parse(&raw[2])?,
        share_policy: SharePolicy::parse(&raw[3])?,
    };
    stored.entry.retention_policy = if raw[4].is_empty() {
        None
    } else {
        Some(serde_json::from_str(&raw[4]).map_err(|e| MemoryError::Storage(e.to_string()))?)
    };
    Ok(stored)
}

/// Whether `caller` may act on an entry under `scope` (§38.2 L0 check).
/// Returns the reason when it may not.
fn scope_allows(
    scope: AccessScope,
    stored: &StoredEntry,
    caller: &CallerGene,
) -> Result<(), String> {
    match scope {
        AccessScope::CreatorGeneOnly if caller.gene_id == stored.entry.created_by => Ok(()),
        AccessScope::CreatorGeneOnly => Err("the entry is CREATOR_GENE_ONLY and the caller did not create it".into()),
        AccessScope::SameDomain if caller.domain == stored.creator_domain => Ok(()),
        // The creator's domain is not named: a denial tells the caller nothing
        // about another gene.
        AccessScope::SameDomain => Err(format!(
            "the entry is SAME_DOMAIN and the caller's domain ({}) is not its creator's",
            caller.domain
        )),
        // Memory is per agent, so every caller here is a gene of the same agent.
        AccessScope::AllGenes => Ok(()),
        AccessScope::DeployerConfigured => Err(
            "the entry is DEPLOYER_CONFIGURED, which resolves from the agent's DataPolicy (§30.2); \
             DataPolicy defines no memory scope yet, so it is treated as not configured and denied"
                .into(),
        ),
    }
}

/// A value is at most 1 MiB once decoded.
fn validate_value(value: &[u8]) -> Result<(), MemoryError> {
    if value.len() > MAX_VALUE_BYTES {
        return Err(MemoryError::InvalidInput(format!(
            "value is {} bytes, more than {MAX_VALUE_BYTES} (1 MiB)",
            value.len()
        )));
    }
    Ok(())
}

/// Narrow a file to owner read/write (0600) on unix; elsewhere a no-op.
pub(crate) fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(path)?.permissions().mode() & 0o777 != 0o600 {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Why a policy cannot be stored in this version, if it names
/// DEPLOYER_CONFIGURED in either scope.
fn deployer_configured_reason(policy: MemoryAccessPolicy) -> Option<String> {
    [policy.read_scope, policy.write_scope]
        .contains(&AccessScope::DeployerConfigured)
        .then(|| {
            "DEPLOYER_CONFIGURED resolves from the agent's DataPolicy (§30.2), which defines no \
             memory scope yet; an entry with it could never be read or written, so it is not \
             created"
                .to_string()
        })
}

fn validate_key(key: &str) -> Result<(), MemoryError> {
    if key.is_empty() {
        return Err(MemoryError::InvalidInput("key is empty".into()));
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(MemoryError::InvalidInput(format!(
            "key is {} bytes, longer than {MAX_KEY_BYTES}",
            key.len()
        )));
    }
    if key.contains('\0') {
        return Err(MemoryError::InvalidInput("key contains a NUL byte".into()));
    }
    Ok(())
}

type Clock = Box<dyn Fn() -> i64 + Send + Sync>;

/// How [`MemoryStore::import`] treats a bundle.
#[derive(Debug, Clone, Default)]
pub struct ImportOptions {
    /// Keep CACHE entries (§38.4: they MAY be dropped; dropped by default).
    pub include_cache: bool,
    /// Domain of each creator gene, by its id. SAME_DOMAIN compares against
    /// the creator's domain, which is not a wire field, so a bundle does not
    /// carry it. An entry whose creator is not listed keeps no domain: its
    /// SAME_DOMAIN scope then matches no caller (it is denied, not widened).
    pub creator_domains: HashMap<String, String>,
}

/// What a deployer delete removes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdminDelete<'a> {
    /// The entry under this key.
    Key(&'a str),
    /// Every entry of this category.
    Category(MemoryCategory),
}

/// What one import decided, inside its transaction.
enum ImportOutcome {
    Refused(MemoryError),
    OverQuota {
        err: MemoryError,
        total: u64,
        quota: u64,
    },
    Imported,
}

/// An entry a write evicts: what its audit line needs, without its value.
struct Victim {
    entry_id: String,
    category: MemoryCategory,
    size: u64,
}

/// What one write decided, inside its transaction.
enum WriteOutcome {
    Denied {
        reason: String,
        category: MemoryCategory,
    },
    OverQuota {
        err: MemoryError,
        total: u64,
        quota: u64,
    },
    Written(MemoryEntry),
}

/// AgentMemory for every agent of one project, in one SQLite database.
pub struct MemoryStore {
    conn: Mutex<Connection>,
    sink: Arc<dyn MemoryEventSink>,
    clock: Clock,
}

impl MemoryStore {
    /// Open (or create) the memory tables in the database at `path`.
    pub fn open(path: &Path, sink: Arc<dyn MemoryEventSink>) -> Result<Self, MemoryError> {
        let conn = Connection::open(path)?;
        // Memory can hold user data (§30): the database is the user's alone,
        // whatever the umask.
        restrict_to_owner(path).map_err(|e| MemoryError::Storage(e.to_string()))?;
        Self::from_connection(conn, sink)
    }

    /// An ephemeral store, for tests.
    pub fn in_memory(sink: Arc<dyn MemoryEventSink>) -> Result<Self, MemoryError> {
        Self::from_connection(Connection::open_in_memory()?, sink)
    }

    fn from_connection(
        conn: Connection,
        sink: Arc<dyn MemoryEventSink>,
    ) -> Result<Self, MemoryError> {
        conn.execute_batch("PRAGMA foreign_keys = ON;")?;
        conn.execute_batch(SCHEMA)?;
        // A database made before retention was enforced lacks the column;
        // add it (null: unlimited, the default DataPolicy).
        let has_retention = conn
            .prepare(
                "SELECT 1 FROM pragma_table_info('agent_memories') WHERE name = 'retention_days'",
            )?
            .exists([])?;
        if !has_retention {
            conn.execute_batch(
                "ALTER TABLE agent_memories ADD COLUMN retention_days INTEGER \
                 CHECK (retention_days IS NULL OR retention_days > 0);",
            )?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
            sink,
            clock: Box::new(|| chrono::Utc::now().timestamp_millis()),
        })
    }

    /// Replace the clock (epoch milliseconds). Tests use it to order entries.
    pub fn with_clock(mut self, clock: impl Fn() -> i64 + Send + Sync + 'static) -> Self {
        self.clock = Box::new(clock);
        self
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    /// The connection. A panic elsewhere while holding it leaves SQLite
    /// consistent (every multi-step change is a transaction), so a poisoned
    /// lock is taken over rather than turned into a panic here.
    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ── Agent-level operations (the deployer / CLI, not a gene) ──────────

    /// Create an agent's memory with a quota in bytes (§38.1: the deployer
    /// MUST configure one). A memory that already exists is an error; change
    /// its quota with [`Self::set_quota`].
    pub fn create_memory(&self, agent_id: &str, quota: u64) -> Result<AgentMemory, MemoryError> {
        if agent_id.is_empty() {
            return Err(MemoryError::InvalidInput("agentId is empty".into()));
        }
        Self::validate_quota(quota)?;
        let now = self.now();
        {
            let mut conn = self.lock();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO agent_memories (agent_id, quota, created_at) VALUES (?1, ?2, ?3)",
                params![agent_id, quota as i64, now],
            )?;
            if inserted == 0 {
                return Err(MemoryError::InvalidInput(format!(
                    "agent {agent_id} already has a memory"
                )));
            }
            self.audit(
                MemoryAction::MemoryCreated,
                agent_id,
                None,
                None,
                None,
                0,
                0,
                quota,
                None,
            )?;
            tx.commit()?;
        }
        self.get_memory(agent_id)
    }

    /// Change an agent's quota. A lower quota takes effect at the next write,
    /// which evicts in §38.1 order; nothing is evicted here.
    pub fn set_quota(&self, agent_id: &str, quota: u64) -> Result<(), MemoryError> {
        Self::validate_quota(quota)?;
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let n = tx.execute(
            "UPDATE agent_memories SET quota = ?2 WHERE agent_id = ?1",
            params![agent_id, quota as i64],
        )?;
        if n == 0 {
            return Err(MemoryError::NotFound(format!(
                "agent {agent_id} has no memory"
            )));
        }
        self.purge_expired(&tx, agent_id)?;
        let total = Self::total_size(&tx, agent_id)?;
        // A quota change is a deployer's state change.
        self.audit(
            MemoryAction::QuotaChanged,
            agent_id,
            None,
            None,
            None,
            0,
            total,
            quota,
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The agent's DataPolicy retention (§30.2 `maxRetentionDays`), which
    /// entries without their own retentionPolicy inherit.
    /// `None` is unlimited, the default. The binding passes it from the
    /// agent's DataPolicy; expiry follows at each entry's next purge.
    pub fn set_retention_days(&self, agent_id: &str, days: Option<u32>) -> Result<(), MemoryError> {
        if days.is_some_and(|d| d == 0 || d > i32::MAX as u32) {
            return Err(MemoryError::InvalidInput(
                "maxRetentionDays must be an integer from 1 to 2147483647, or null".into(),
            ));
        }
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let n = tx.execute(
            "UPDATE agent_memories SET retention_days = ?2 WHERE agent_id = ?1",
            params![agent_id, days],
        )?;
        if n == 0 {
            return Err(MemoryError::NotFound(format!(
                "agent {agent_id} has no memory"
            )));
        }
        let (quota, _) = Self::memory_row(&tx, agent_id)?.unwrap_or((0, 0));
        let total = Self::total_size(&tx, agent_id)?;
        self.audit(
            MemoryAction::RetentionChanged,
            agent_id,
            None,
            None,
            None,
            0,
            total,
            quota,
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    /// The deployer removes entries: the one under a key, or every entry of
    /// a category (PREFERENCE is never evicted, so a full quota needs a way
    /// out). Gene access scopes do not apply — the
    /// deployer owns the agent. One transaction; each removed entry is one
    /// `delete` audit line with `actor: "deployer"`, written before the
    /// commit. Returns how many entries were removed; a key that is not
    /// there is MEMORY_NOT_FOUND, a category with none is 0.
    pub fn admin_delete(
        &self,
        agent_id: &str,
        target: AdminDelete<'_>,
    ) -> Result<u64, MemoryError> {
        if let AdminDelete::Key(key) = target {
            validate_key(key)?;
        }
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (quota, _) = Self::memory_row(&tx, agent_id)?
            .ok_or_else(|| MemoryError::NotFound(format!("agent {agent_id} has no memory")))?;
        self.purge_expired(&tx, agent_id)?;
        let victims: Vec<Victim> = {
            let (clause, arg) = match target {
                AdminDelete::Key(key) => ("entry_id = ?2", entry_id(agent_id, key)),
                AdminDelete::Category(c) => ("category = ?2", c.as_str().to_string()),
            };
            let mut stmt = tx.prepare(&format!(
                "SELECT entry_id, category, LENGTH(CAST(key AS BLOB)) + LENGTH(value) \
                 FROM agent_memory_entries WHERE agent_id = ?1 AND {clause} ORDER BY entry_id"
            ))?;
            let rows = stmt.query_map(params![agent_id, arg], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            rows.map(|r| {
                let (entry_id, category, size) = r?;
                Ok(Victim {
                    entry_id,
                    category: MemoryCategory::parse(&category)?,
                    size: size as u64,
                })
            })
            .collect::<Result<_, MemoryError>>()?
        };
        if victims.is_empty() && matches!(target, AdminDelete::Key(_)) {
            tx.commit()?;
            return Err(MemoryError::NotFound(format!(
                "no memory entry under that key for agent {agent_id}"
            )));
        }
        let mut running = Self::total_size(&tx, agent_id)?;
        for v in &victims {
            tx.execute(
                "DELETE FROM agent_memory_entries WHERE entry_id = ?1",
                params![v.entry_id],
            )?;
            running -= v.size;
            self.record(&MemoryAuditEvent {
                actor: Some("deployer"),
                ..self.audit_event(
                    MemoryAction::Delete,
                    agent_id,
                    Some(&v.entry_id),
                    Some(v.category),
                    None,
                    -(v.size as i64),
                    running,
                    quota,
                    None,
                )
            })?;
        }
        tx.commit()?;
        Ok(victims.len() as u64)
    }

    fn validate_quota(quota: u64) -> Result<(), MemoryError> {
        if quota == 0 || quota > i64::MAX as u64 {
            return Err(MemoryError::InvalidInput(format!(
                "quota {quota} is not a positive byte count"
            )));
        }
        Ok(())
    }

    /// The whole memory, every entry: the deployer's view.
    pub fn get_memory(&self, agent_id: &str) -> Result<AgentMemory, MemoryError> {
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (quota, created_at) = Self::memory_row(&tx, agent_id)?
            .ok_or_else(|| MemoryError::NotFound(format!("agent {agent_id} has no memory")))?;
        self.purge_expired(&tx, agent_id)?;
        let entries: Vec<MemoryEntry> = Self::select_entries(&tx, agent_id, "ORDER BY key")?
            .into_iter()
            .map(|s| s.entry)
            .collect();
        tx.commit()?;
        let total_size = entries.iter().map(MemoryEntry::size).sum();
        Ok(AgentMemory {
            agent_id: agent_id.into(),
            entries,
            total_size,
            quota,
            created_at,
        })
    }

    /// §38.4: the memory as it goes into a MigrationBundle. PREFERENCE,
    /// PATTERN and CONTEXT always; CACHE only if asked (it MAY be dropped).
    /// Policies, retention and `createdBy` are carried unchanged.
    pub fn export(&self, agent_id: &str, include_cache: bool) -> Result<AgentMemory, MemoryError> {
        let mut memory = self.get_memory(agent_id)?;
        if !include_cache {
            memory
                .entries
                .retain(|e| e.category != MemoryCategory::Cache);
            memory.total_size = memory.entries.iter().map(MemoryEntry::size).sum();
        }
        Ok(memory)
    }

    /// §38.4: bring a MigrationBundle's memory into `agent_id`, as the
    /// counterpart of [`Self::export`].
    ///
    /// - `createdBy`, `lastAccessedBy`, timestamps, `accessPolicy` and
    ///   `retentionPolicy` are kept, whether or not the creator gene is part
    ///   of the target agent. `entryId` is recomputed: it is derived from the
    ///   agent id.
    /// - CACHE entries are dropped unless `include_cache`.
    /// - The target's quota applies; a target without memory gets the
    ///   bundle's quota. An import that does not fit, or that names a key the
    ///   target already has, changes nothing (no eviction, no overwrite).
    /// - What a write refuses, an import refuses: bad keys or retention, a
    ///   repeated key, a share policy other than PRIVATE.
    /// - One audit line per imported entry.
    pub fn import(
        &self,
        agent_id: &str,
        bundle: &AgentMemory,
        options: &ImportOptions,
    ) -> Result<AgentMemory, MemoryError> {
        if agent_id.is_empty() {
            return Err(MemoryError::InvalidInput("agentId is empty".into()));
        }
        Self::validate_quota(bundle.quota)?;
        let selected: Vec<&MemoryEntry> = bundle
            .entries
            .iter()
            .filter(|e| options.include_cache || e.category != MemoryCategory::Cache)
            .collect();
        let mut seen = HashSet::new();
        for e in &selected {
            validate_key(&e.key)?;
            validate_value(&e.value)?;
            if !seen.insert(e.key.as_str()) {
                return Err(MemoryError::InvalidInput("the bundle repeats a key".into()));
            }
            if let Some(reason) = deployer_configured_reason(e.access_policy) {
                return Err(MemoryError::AccessDenied(reason));
            }
            if e.access_policy.share_policy != SharePolicy::Private {
                return Err(MemoryError::AccessDenied(format!(
                    "the bundle has a {} entry; sharing needs anonymization, which the agent's \
                     DataPolicy (§30.2) does not support by default, so only PRIVATE can be imported",
                    e.access_policy.share_policy.as_str()
                )));
            }
        }

        let now = self.now();
        let outcome = {
            let mut conn = self.lock();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let created_memory = (tx.execute(
                "INSERT OR IGNORE INTO agent_memories (agent_id, quota, created_at) VALUES (?1, ?2, ?3)",
                params![agent_id, bundle.quota as i64, now],
            )? > 0)
                .then_some(bundle.quota);
            let (quota, _) = Self::memory_row(&tx, agent_id)?
                .ok_or_else(|| MemoryError::Storage(format!("memory for {agent_id} vanished")))?;
            self.purge_expired(&tx, agent_id)?;
            let total = Self::total_size(&tx, agent_id)?;
            let incoming: u64 = selected.iter().map(|e| e.size()).sum();
            let mut clash = false;
            for e in &selected {
                clash |= Self::select_one(&tx, agent_id, &e.key)?.is_some();
            }
            let refusal = if clash {
                Some(ImportOutcome::Refused(MemoryError::InvalidInput(
                    "the target agent already has entries under some of the bundle's keys; \
                     import does not overwrite"
                        .into(),
                )))
            } else if total + incoming > quota {
                Some(ImportOutcome::OverQuota {
                    err: MemoryError::QuotaExceeded(format!(
                        "importing {incoming} bytes needs {} of {quota}; import does not evict",
                        total + incoming
                    )),
                    total,
                    quota,
                })
            } else {
                None
            };
            if let Some(refusal) = refusal {
                // A refusal keeps the purge, unless this import created the
                // memory (then there was nothing to purge).
                if created_memory.is_none() {
                    tx.commit()?;
                }
                refusal
            } else {
                let mut sizes = Vec::new();
                for e in &selected {
                    let id = entry_id(agent_id, &e.key);
                    let domain = options
                        .creator_domains
                        .get(&e.created_by)
                        .cloned()
                        .unwrap_or_default();
                    tx.execute(
                        "INSERT INTO agent_memory_entries (entry_id, agent_id, category, key, value, \
                         created_by, creator_domain, last_accessed_by, created_at, updated_at, read_scope, \
                         write_scope, share_policy, retention_policy) \
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
                        params![
                            id,
                            agent_id,
                            e.category.as_str(),
                            e.key,
                            e.value,
                            e.created_by,
                            domain,
                            e.last_accessed_by,
                            e.created_at,
                            e.updated_at,
                            e.access_policy.read_scope.as_str(),
                            e.access_policy.write_scope.as_str(),
                            e.access_policy.share_policy.as_str(),
                            retention_json(e.retention_policy)?,
                        ],
                    )?;
                    sizes.push((id, e.category, e.size()));
                }
                // Audit lines before the commit.
                if let Some(q) = created_memory {
                    self.audit(
                        MemoryAction::MemoryCreated,
                        agent_id,
                        None,
                        None,
                        None,
                        0,
                        0,
                        q,
                        None,
                    )?;
                }
                let mut running = total;
                for (id, category, size) in sizes {
                    running += size;
                    self.audit(
                        MemoryAction::Import,
                        agent_id,
                        Some(&id),
                        Some(category),
                        None,
                        size as i64,
                        running,
                        quota,
                        None,
                    )?;
                }
                tx.commit()?;
                ImportOutcome::Imported
            }
        };

        match outcome {
            ImportOutcome::Refused(err) => Err(err),
            ImportOutcome::OverQuota { err, total, quota } => {
                self.audit_refusal(
                    MemoryAction::QuotaRejected,
                    agent_id,
                    None,
                    None,
                    None,
                    total,
                    quota,
                    err.code(),
                );
                Err(err)
            }
            ImportOutcome::Imported => self.get_memory(agent_id),
        }
    }

    // ── Gene operations (§38.2 GeneMemoryAccess) ─────────────────────────

    /// readMemory: the entry under `key`, or None. With `category`, only an
    /// entry of that category is returned. A successful read records the
    /// caller as `lastAccessedBy`.
    pub fn read(
        &self,
        agent_id: &str,
        caller: &CallerGene,
        key: &str,
        category: Option<MemoryCategory>,
    ) -> Result<Option<MemoryEntry>, MemoryError> {
        validate_key(key)?;
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.purge_expired(&tx, agent_id)?;
        let found = Self::select_one(&tx, agent_id, key)?;
        let Some(stored) = found.filter(|s| category.is_none_or(|c| c == s.entry.category)) else {
            tx.commit()?;
            return Ok(None);
        };
        if let Err(reason) = scope_allows(stored.entry.access_policy.read_scope, &stored, caller) {
            tx.commit()?;
            drop(conn);
            return Err(self.deny(agent_id, caller, &stored.entry, "read", reason));
        }
        tx.execute(
            "UPDATE agent_memory_entries SET last_accessed_by = ?2 WHERE entry_id = ?1",
            params![stored.entry.entry_id, caller.gene_id],
        )?;
        tx.commit()?;
        let mut entry = stored.entry;
        entry.last_accessed_by = Some(caller.gene_id.clone());
        Ok(Some(entry))
    }

    /// writeMemory: create or update the entry under `key`. Either way the
    /// caller becomes its `lastAccessedBy`.
    ///
    /// - A new entry belongs to the caller (`createdBy`), with `policy` or the
    ///   default (SAME_DOMAIN / SAME_DOMAIN / PRIVATE).
    /// - An existing entry needs the caller to pass its writeScope. Its id,
    ///   creator and createdAt stay; without `policy` its policy stays. Only
    ///   its creator may change the policy — otherwise a gene with write
    ///   access could widen who reads an entry it did not create.
    /// - `retention_policy`: `None` keeps the stored one (a new entry has
    ///   none), `Some(None)` resets it to inherit the agent's DataPolicy,
    ///   `Some(Some(p))` sets it. Resetting and setting are changes, so only
    ///   the creator may make them.
    /// - Over quota, entries are evicted CACHE (oldest first), then the oldest
    ///   PATTERN, then the oldest CONTEXT; PREFERENCE never. If that still
    ///   does not make room, nothing is evicted and nothing written:
    ///   MEMORY_QUOTA_EXCEEDED.
    ///
    /// An agent without a memory gets one with the default quota on its first
    /// write (agents created before v0.9.4 have none).
    #[allow(clippy::too_many_arguments)]
    pub fn write(
        &self,
        agent_id: &str,
        caller: &CallerGene,
        key: &str,
        value: &[u8],
        category: MemoryCategory,
        policy: Option<MemoryAccessPolicy>,
        retention_policy: Option<Option<RetentionPolicy>>,
    ) -> Result<MemoryEntry, MemoryError> {
        if agent_id.is_empty() {
            return Err(MemoryError::InvalidInput("agentId is empty".into()));
        }
        validate_key(key)?;
        validate_value(value)?;
        // DEPLOYER_CONFIGURED resolves from the agent's DataPolicy, which has
        // no memory scope yet: an entry with it could never be read or
        // written, by anyone. Creating one is refused. No
        // stored entry can carry it, so only the requested policy is checked.
        if let Some(reason) = policy.and_then(deployer_configured_reason) {
            return Err(self.deny_target(
                agent_id,
                caller,
                &entry_id(agent_id, key),
                category,
                "write",
                reason,
            ));
        }
        // Sharing beyond the agent needs anonymization (§38.1), which the
        // default §30.2 DataPolicy does not support, and v0.9.4 has no way
        // to change it: such writes are denied. No stored entry
        // can carry another share policy, so only the requested one is checked.
        if let Some(share @ (SharePolicy::AnonymizedShare | SharePolicy::KnowledgeGene)) =
            policy.map(|p| p.share_policy)
        {
            let reason = format!(
                "sharePolicy {} needs anonymization, which the agent's DataPolicy (§30.2) does not \
                 support by default; only PRIVATE can be written in this version",
                share.as_str()
            );
            return Err(self.deny_target(
                agent_id,
                caller,
                &entry_id(agent_id, key),
                category,
                "write",
                reason,
            ));
        }
        let now = self.now();
        let id = entry_id(agent_id, key);

        // One IMMEDIATE transaction from the first read to the commit, so the
        // permission check, the quota arithmetic, the evictions and the write
        // see one state even with another process on the same database.
        // Anything that is not a write rolls back, including the
        // default memory an agent's first write would have created. The
        // audit lines of a write are written inside it, before the commit;
        // a refusal's line and telemetry go out after the lock is released.
        let outcome = {
            let mut conn = self.lock();
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let created_memory = tx.execute(
                "INSERT OR IGNORE INTO agent_memories (agent_id, quota, created_at) VALUES (?1, ?2, ?3)",
                params![agent_id, DEFAULT_QUOTA_BYTES as i64, now],
            )? > 0;
            let (quota, _) = Self::memory_row(&tx, agent_id)?
                .ok_or_else(|| MemoryError::Storage(format!("memory for {agent_id} vanished")))?;
            // An expired entry is gone before the write looks: writing its
            // key is a fresh create, and it holds no quota.
            self.purge_expired(&tx, agent_id)?;
            let existing = Self::select_one(&tx, agent_id, key)?;
            let total = Self::total_size(&tx, agent_id)?;

            let denial = existing.as_ref().and_then(|stored| {
                if let Err(reason) = scope_allows(stored.entry.access_policy.write_scope, stored, caller) {
                    return Some((reason, stored.entry.category));
                }
                // Overwriting keeps the creator and the policies. Only the
                // creator may change them; anyone else sending a different
                // one is refused rather than silently ignored.
                let is_creator = caller.gene_id == stored.entry.created_by;
                let changes_policy = policy.is_some_and(|p| p != stored.entry.access_policy);
                // Null is a change too when a policy is stored.
                let changes_retention = retention_policy.is_some_and(|r| r != stored.entry.retention_policy);
                (!is_creator && (changes_policy || changes_retention)).then(|| {
                    (
                        "only the gene that created an entry may change its accessPolicy or retentionPolicy".to_string(),
                        stored.entry.category,
                    )
                })
            });

            let new_size = (key.len() + value.len()) as u64;
            let old_size = existing.as_ref().map_or(0, |s| s.entry.size());
            let after = total - old_size + new_size;

            if let Some((reason, category)) = denial {
                // A refusal keeps the purge, unless this write created the
                // memory (then there was nothing to purge).
                if !created_memory {
                    tx.commit()?;
                }
                WriteOutcome::Denied { reason, category }
            } else {
                // Plan the evictions before touching anything. Candidates
                // are scanned in eviction order — id, category and size
                // only, never values — until there is room, so the table is
                // never loaded whole.
                let mut evict: Vec<Victim> = Vec::new();
                let mut freed = 0u64;
                if after > quota {
                    let mut stmt = tx.prepare(
                        "SELECT entry_id, category, LENGTH(CAST(key AS BLOB)) + LENGTH(value) \
                         FROM agent_memory_entries WHERE agent_id = ?1 AND category != 'PREFERENCE' \
                         ORDER BY CASE category WHEN 'CACHE' THEN 0 WHEN 'PATTERN' THEN 1 ELSE 2 END, \
                         updated_at, entry_id",
                    )?;
                    // "Oldest" is updatedAt ascending, ties by entryId, the
                    // same in every binding.
                    let mut rows = stmt.query(params![agent_id])?;
                    while after - freed > quota {
                        let Some(row) = rows.next()? else { break };
                        let entry_id: String = row.get(0)?;
                        if entry_id == id {
                            continue;
                        }
                        let size = row.get::<_, i64>(2)? as u64;
                        freed += size;
                        evict.push(Victim {
                            entry_id,
                            category: MemoryCategory::parse(&row.get::<_, String>(1)?)?,
                            size,
                        });
                    }
                }
                if after - freed > quota {
                    if !created_memory {
                        tx.commit()?;
                    }
                    WriteOutcome::OverQuota {
                        err: MemoryError::QuotaExceeded(format!(
                            "writing {new_size} bytes needs {after} of {quota}; evicting every CACHE, PATTERN \
                             and CONTEXT entry would free only {freed} (PREFERENCE is never evicted)"
                        )),
                        total,
                        quota,
                    }
                } else {
                    let entry = match &existing {
                        Some(s) => MemoryEntry {
                            entry_id: id.clone(),
                            category,
                            key: key.into(),
                            value: value.to_vec(),
                            created_by: s.entry.created_by.clone(),
                            // The writer is the latest gene to touch it.
                            last_accessed_by: Some(caller.gene_id.clone()),
                            created_at: s.entry.created_at,
                            updated_at: now,
                            access_policy: policy.unwrap_or(s.entry.access_policy),
                            retention_policy: retention_policy.unwrap_or(s.entry.retention_policy),
                        },
                        None => MemoryEntry {
                            entry_id: id.clone(),
                            category,
                            key: key.into(),
                            value: value.to_vec(),
                            created_by: caller.gene_id.clone(),
                            last_accessed_by: Some(caller.gene_id.clone()),
                            created_at: now,
                            updated_at: now,
                            access_policy: policy.unwrap_or_default(),
                            retention_policy: retention_policy.flatten(),
                        },
                    };
                    let creator_domain = existing
                        .as_ref()
                        .map_or_else(|| caller.domain.clone(), |s| s.creator_domain.clone());
                    for e in &evict {
                        tx.execute(
                            "DELETE FROM agent_memory_entries WHERE entry_id = ?1",
                            params![e.entry_id],
                        )?;
                    }
                    tx.execute(
                        "INSERT INTO agent_memory_entries (entry_id, agent_id, category, key, value, created_by, \
                         creator_domain, last_accessed_by, created_at, updated_at, read_scope, write_scope, \
                         share_policy, retention_policy) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14) \
                         ON CONFLICT(entry_id) DO UPDATE SET category = excluded.category, value = excluded.value, \
                         updated_at = excluded.updated_at, read_scope = excluded.read_scope, \
                         write_scope = excluded.write_scope, share_policy = excluded.share_policy, \
                         retention_policy = excluded.retention_policy, \
                         last_accessed_by = excluded.last_accessed_by",
                        params![
                            entry.entry_id,
                            agent_id,
                            category.as_str(),
                            key,
                            value,
                            entry.created_by,
                            creator_domain,
                            entry.last_accessed_by,
                            entry.created_at,
                            now,
                            entry.access_policy.read_scope.as_str(),
                            entry.access_policy.write_scope.as_str(),
                            entry.access_policy.share_policy.as_str(),
                            retention_json(entry.retention_policy)?,
                        ],
                    )?;
                    let final_total = Self::total_size(&tx, agent_id)?;
                    // Audit lines before the commit: a change whose line
                    // cannot be written is rolled back.
                    if created_memory {
                        self.audit(
                            MemoryAction::MemoryCreated,
                            agent_id,
                            None,
                            None,
                            Some(&caller.gene_id),
                            0,
                            0,
                            DEFAULT_QUOTA_BYTES,
                            None,
                        )?;
                    }
                    // What the memory actually holds after each eviction —
                    // not `after`, the total the pending write projects,
                    // which can exceed the quota.
                    let mut running = total;
                    for e in &evict {
                        running -= e.size;
                        self.audit(
                            MemoryAction::Evict,
                            agent_id,
                            Some(&e.entry_id),
                            Some(e.category),
                            Some(&caller.gene_id),
                            -(e.size as i64),
                            running,
                            quota,
                            None,
                        )?;
                    }
                    self.audit(
                        if existing.is_some() {
                            MemoryAction::Update
                        } else {
                            MemoryAction::Write
                        },
                        agent_id,
                        Some(&id),
                        Some(category),
                        Some(&caller.gene_id),
                        new_size as i64 - old_size as i64,
                        final_total,
                        quota,
                        None,
                    )?;
                    tx.commit()?;
                    WriteOutcome::Written(entry)
                }
            }
        };

        match outcome {
            WriteOutcome::Denied { reason, category } => {
                Err(self.deny_target(agent_id, caller, &id, category, "write", reason))
            }
            WriteOutcome::OverQuota { err, total, quota } => {
                self.audit_refusal(
                    MemoryAction::QuotaRejected,
                    agent_id,
                    Some(&id),
                    Some(category),
                    Some(&caller.gene_id),
                    total,
                    quota,
                    err.code(),
                );
                Err(err)
            }
            WriteOutcome::Written(entry) => Ok(entry),
        }
    }

    /// queryMemory: the entries matching `filter` that the caller may read,
    /// newest `updatedAt` first, ties by `entryId`, at most
    /// `limit` of them (default 100, capped at 1000; 0 is invalid). Entries
    /// the caller may not read are left out, not reported as denials: a query
    /// is a search, not a request for a specific entry. It records no
    /// reader: `lastAccessedBy` is left as it was, so a
    /// scan of up to 1000 rows never becomes a write.
    pub fn query(
        &self,
        agent_id: &str,
        caller: &CallerGene,
        filter: &MemoryFilter,
    ) -> Result<Vec<MemoryEntry>, MemoryError> {
        let limit = match filter.limit {
            Some(0) => return Err(MemoryError::InvalidInput("limit must be at least 1".into())),
            Some(l) => l.min(MAX_QUERY_LIMIT),
            None => DEFAULT_QUERY_LIMIT,
        } as usize;
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.purge_expired(&tx, agent_id)?;
        let out = Self::scan(&tx, agent_id, caller, filter, limit);
        // The purge stands even when the scan refuses (no expired line is
        // ever written for a delete that did not happen).
        tx.commit()?;
        out
    }

    /// queryMemory's scan, inside its transaction.
    fn scan(
        conn: &Connection,
        agent_id: &str,
        caller: &CallerGene,
        filter: &MemoryFilter,
        limit: usize,
    ) -> Result<Vec<MemoryEntry>, MemoryError> {
        // The table is scanned, never loaded: the filters
        // that are columns run in SQL, rows are decoded one at a time, and
        // reading stops at the limit.
        let mut sql =
            format!("SELECT {ENTRY_COLUMNS} FROM agent_memory_entries WHERE agent_id = ?1");
        let mut args: Vec<rusqlite::types::Value> = vec![agent_id.to_string().into()];
        if let Some(c) = filter.category {
            args.push(c.as_str().to_string().into());
            sql += &format!(" AND category = ?{}", args.len());
        }
        if let Some(t) = filter.since {
            args.push(t.into());
            sql += &format!(" AND updated_at >= ?{}", args.len());
        }
        if let Some(t) = filter.until {
            args.push(t.into());
            sql += &format!(" AND updated_at < ?{}", args.len());
        }
        sql += " ORDER BY updated_at DESC, entry_id ASC";

        let mut out: Vec<MemoryEntry> = Vec::new();
        // Bytes of the JSON array so far: its brackets, each entry, commas.
        let mut size = 2;
        {
            let mut stmt = conn.prepare(&sql)?;
            let mut rows = stmt.query(rusqlite::params_from_iter(args))?;
            while out.len() < limit {
                let Some(row) = rows.next()? else { break };
                let stored = finish_stored(row_to_stored(row)?)?;
                if filter
                    .key_prefix
                    .as_ref()
                    .is_some_and(|p| !stored.entry.key.starts_with(p.as_str()))
                    || scope_allows(stored.entry.access_policy.read_scope, &stored, caller).is_err()
                {
                    continue;
                }
                let entry = stored.entry;
                size += serde_json::to_vec(&entry)
                    .map_err(|e| MemoryError::Storage(e.to_string()))?
                    .len()
                    + usize::from(!out.is_empty());
                // Refused whole, never truncated.
                if size > MAX_QUERY_RESPONSE_BYTES {
                    return Err(MemoryError::InvalidInput(format!(
                        "result too large; lower limit or narrow the filter (over {MAX_QUERY_RESPONSE_BYTES} bytes)"
                    )));
                }
                out.push(entry);
            }
        }
        Ok(out)
    }

    /// deleteMemory: remove the entry under `key`. Needs the entry's
    /// writeScope (§38.2: the creator, or a gene with write access).
    pub fn delete(
        &self,
        agent_id: &str,
        caller: &CallerGene,
        key: &str,
    ) -> Result<(), MemoryError> {
        validate_key(key)?;
        // Look-up, permission and deletion in one IMMEDIATE transaction, so
        // another connection cannot change the entry in between.
        let mut conn = self.lock();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.purge_expired(&tx, agent_id)?;
        let Some(stored) = Self::select_one(&tx, agent_id, key)? else {
            tx.commit()?;
            return Err(MemoryError::NotFound(format!(
                "no memory entry under that key for agent {agent_id}"
            )));
        };
        if let Err(reason) = scope_allows(stored.entry.access_policy.write_scope, &stored, caller) {
            tx.commit()?;
            drop(conn);
            return Err(self.deny(agent_id, caller, &stored.entry, "delete", reason));
        }
        tx.execute(
            "DELETE FROM agent_memory_entries WHERE entry_id = ?1",
            params![stored.entry.entry_id],
        )?;
        let (quota, _) = Self::memory_row(&tx, agent_id)?.unwrap_or((0, 0));
        let total = Self::total_size(&tx, agent_id)?;
        self.audit(
            MemoryAction::Delete,
            agent_id,
            Some(&stored.entry.entry_id),
            Some(stored.entry.category),
            Some(&caller.gene_id),
            -(stored.entry.size() as i64),
            total,
            quota,
            None,
        )?;
        tx.commit()?;
        Ok(())
    }

    // ── internals ───────────────────────────────────────────────────────

    /// Remove `agent_id`'s entries whose retention has run out, inside the
    /// caller's transaction, each with an `expired` audit line written
    /// before the commit. An entry expires when
    /// (now − updatedAt) >= days × 86 400 s, the form every binding uses (no
    /// binding adds days to a timestamp, which can overflow). Its days are its own
    /// retentionPolicy's; an entry without one inherits the agent's
    /// DataPolicy retention; null days never expire.
    fn purge_expired(&self, tx: &Connection, agent_id: &str) -> Result<(), MemoryError> {
        let Some((quota, _)) = Self::memory_row(tx, agent_id)? else {
            return Ok(());
        };
        let victims: Vec<Victim> = {
            let mut stmt = tx.prepare(
                "SELECT e.entry_id, e.category, LENGTH(CAST(e.key AS BLOB)) + LENGTH(e.value) \
                 FROM agent_memory_entries e JOIN agent_memories m ON m.agent_id = e.agent_id \
                 WHERE e.agent_id = ?1 AND ?2 - e.updated_at >= 86400000 * \
                 (CASE WHEN e.retention_policy IS NULL THEN m.retention_days \
                  ELSE json_extract(e.retention_policy, '$.maxRetentionDays') END) \
                 ORDER BY e.entry_id",
            )?;
            let rows = stmt.query_map(params![agent_id, self.now()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            rows.map(|r| {
                let (entry_id, category, size) = r?;
                Ok(Victim {
                    entry_id,
                    category: MemoryCategory::parse(&category)?,
                    size: size as u64,
                })
            })
            .collect::<Result<_, MemoryError>>()?
        };
        if victims.is_empty() {
            return Ok(());
        }
        let mut running = Self::total_size(tx, agent_id)?;
        for v in &victims {
            tx.execute(
                "DELETE FROM agent_memory_entries WHERE entry_id = ?1",
                params![v.entry_id],
            )?;
            running -= v.size;
            self.audit(
                MemoryAction::Expired,
                agent_id,
                Some(&v.entry_id),
                Some(v.category),
                None,
                -(v.size as i64),
                running,
                quota,
                None,
            )?;
        }
        Ok(())
    }

    fn memory_row(conn: &Connection, agent_id: &str) -> Result<Option<(u64, i64)>, MemoryError> {
        Ok(conn
            .query_row(
                "SELECT quota, created_at FROM agent_memories WHERE agent_id = ?1",
                params![agent_id],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)?)),
            )
            .optional()?)
    }

    fn total_size(conn: &Connection, agent_id: &str) -> Result<u64, MemoryError> {
        let total: i64 = conn.query_row(
            "SELECT COALESCE(SUM(LENGTH(CAST(key AS BLOB)) + LENGTH(value)), 0) \
             FROM agent_memory_entries WHERE agent_id = ?1",
            params![agent_id],
            |r| r.get(0),
        )?;
        Ok(total as u64)
    }

    fn select_one(
        conn: &Connection,
        agent_id: &str,
        key: &str,
    ) -> Result<Option<StoredEntry>, MemoryError> {
        let sql = format!("SELECT {ENTRY_COLUMNS} FROM agent_memory_entries WHERE entry_id = ?1");
        conn.query_row(&sql, params![entry_id(agent_id, key)], row_to_stored)
            .optional()?
            .map(finish_stored)
            .transpose()
    }

    fn select_entries(
        conn: &Connection,
        agent_id: &str,
        tail: &str,
    ) -> Result<Vec<StoredEntry>, MemoryError> {
        let sql =
            format!("SELECT {ENTRY_COLUMNS} FROM agent_memory_entries WHERE agent_id = ?1 {tail}");
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params![agent_id], row_to_stored)?;
        rows.map(|r| finish_stored(r?)).collect()
    }

    fn deny(
        &self,
        agent_id: &str,
        caller: &CallerGene,
        entry: &MemoryEntry,
        operation: &str,
        reason: String,
    ) -> MemoryError {
        self.deny_target(
            agent_id,
            caller,
            &entry.entry_id,
            entry.category,
            operation,
            reason,
        )
    }

    /// A denial: §17 telemetry event plus an audit line, then the error.
    fn deny_target(
        &self,
        agent_id: &str,
        caller: &CallerGene,
        entry_id: &str,
        category: MemoryCategory,
        operation: &str,
        reason: String,
    ) -> MemoryError {
        self.deny_in_agent(
            agent_id,
            Some(&caller.gene_id),
            Some(entry_id),
            Some(category),
            operation,
            reason,
        )
    }

    /// A call from a gene with no usable v2 id inside `agent_id` (a
    /// violation is audit + telemetry). `entry_id` is the requested
    /// entry when the call named a key.
    pub fn deny_unidentified(
        &self,
        agent_id: &str,
        entry_id: Option<&str>,
        operation: &str,
        reason: String,
    ) -> MemoryError {
        self.deny_in_agent(agent_id, None, entry_id, None, operation, reason)
    }

    /// A call from a gene running outside any agent ("no agent context").
    /// Only telemetry: an audit line belongs to an agent's memory, and there
    /// is no agent to attribute this one to.
    pub fn deny_without_agent(
        &self,
        gene_id: Option<&str>,
        operation: &str,
        reason: String,
    ) -> MemoryError {
        let err = MemoryError::AccessDenied(reason);
        self.sink.telemetry(&MemoryTelemetryEvent::access_denied(
            self.now(),
            gene_id,
            None,
            None,
            operation,
            &err,
        ));
        err
    }

    /// A denial inside an agent: §17 telemetry event plus an audit line.
    fn deny_in_agent(
        &self,
        agent_id: &str,
        gene_id: Option<&str>,
        entry_id: Option<&str>,
        category: Option<MemoryCategory>,
        operation: &str,
        reason: String,
    ) -> MemoryError {
        let err = MemoryError::AccessDenied(reason);
        self.sink.telemetry(&MemoryTelemetryEvent::access_denied(
            self.now(),
            gene_id,
            Some(agent_id),
            entry_id,
            operation,
            &err,
        ));
        let (quota, total) = {
            let conn = self.lock();
            let quota = Self::memory_row(&conn, agent_id)
                .ok()
                .flatten()
                .map_or(0, |r| r.0);
            (quota, Self::total_size(&conn, agent_id).unwrap_or(0))
        };
        self.audit_refusal(
            MemoryAction::AccessDenied,
            agent_id,
            entry_id,
            category,
            gene_id,
            total,
            quota,
            err.code(),
        );
        err
    }

    #[allow(clippy::too_many_arguments)]
    fn audit(
        &self,
        action: MemoryAction,
        agent_id: &str,
        entry_id: Option<&str>,
        category: Option<MemoryCategory>,
        gene_id: Option<&str>,
        size_delta: i64,
        total_size: u64,
        quota: u64,
        error: Option<&'static str>,
    ) -> Result<(), MemoryError> {
        self.record(&self.audit_event(
            action, agent_id, entry_id, category, gene_id, size_delta, total_size, quota, error,
        ))
    }

    /// Writes one audit line; a failure is MEMORY_STORAGE_ERROR.
    fn record(&self, event: &MemoryAuditEvent) -> Result<(), MemoryError> {
        self.sink
            .audit(event)
            .map_err(|e| MemoryError::Storage(format!("audit log not written: {e}")))
    }

    #[allow(clippy::too_many_arguments)]
    fn audit_event(
        &self,
        action: MemoryAction,
        agent_id: &str,
        entry_id: Option<&str>,
        category: Option<MemoryCategory>,
        gene_id: Option<&str>,
        size_delta: i64,
        total_size: u64,
        quota: u64,
        error: Option<&'static str>,
    ) -> MemoryAuditEvent {
        MemoryAuditEvent {
            ts: format_rfc3339_ms(self.now()),
            kind: "agent_memory",
            action,
            agent_id: agent_id.into(),
            entry_id: entry_id.map(str::to_string),
            category,
            gene_id: gene_id.map(str::to_string),
            size_delta,
            total_size,
            quota,
            error,
            actor: None,
        }
    }

    /// The audit line of a refused call. Nothing changed, so there is
    /// nothing to roll back: a failure to record it is logged and the
    /// refusal stands as it is.
    #[allow(clippy::too_many_arguments)]
    fn audit_refusal(
        &self,
        action: MemoryAction,
        agent_id: &str,
        entry_id: Option<&str>,
        category: Option<MemoryCategory>,
        gene_id: Option<&str>,
        total_size: u64,
        quota: u64,
        error: &'static str,
    ) {
        if let Err(e) = self.audit(
            action,
            agent_id,
            entry_id,
            category,
            gene_id,
            0,
            total_size,
            quota,
            Some(error),
        ) {
            tracing::warn!("agent memory refusal not recorded: {e}");
        }
    }
}
