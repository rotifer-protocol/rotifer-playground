//! Agent lifecycle management — create, activate, terminate.

pub use crate::types::agent::{Agent, AgentState};

use crate::storage::{AgentStore, StorageError};
use crate::types::GeneId;
use thiserror::Error;

/// Errors from agent management operations.
#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent not found: {0}")]
    NotFound(String),
    #[error("invalid state transition: {from:?} -> {to:?}")]
    InvalidTransition { from: AgentState, to: AgentState },
    #[error("storage error: {0}")]
    Storage(#[from] StorageError),
}

/// High-level manager for agent CRUD backed by an [`AgentStore`].
pub struct AgentManager<S: AgentStore> {
    store: S,
}

impl<S: AgentStore> AgentManager<S> {
    /// Wrap a store into a manager.
    pub fn new(store: S) -> Self {
        Self { store }
    }

    /// Create a new agent, activate it, and persist.
    pub fn create(&self, name: String, genome: Vec<GeneId>) -> Result<Agent, AgentError> {
        let mut agent = Agent::new(name);
        agent.genome = genome;
        agent.activate();
        self.store.save_agent(&agent)?;
        Ok(agent)
    }

    /// Retrieve an agent by ID or return [`AgentError::NotFound`].
    pub fn get(&self, id: &str) -> Result<Agent, AgentError> {
        self.store
            .get_agent(id)?
            .ok_or_else(|| AgentError::NotFound(id.to_string()))
    }

    /// List all agents.
    pub fn list(&self) -> Result<Vec<Agent>, AgentError> {
        Ok(self.store.list_agents()?)
    }

    /// Terminate an agent. Fails if already terminated.
    pub fn terminate(&self, id: &str) -> Result<Agent, AgentError> {
        let mut agent = self.get(id)?;
        if agent.state == AgentState::Terminated {
            return Err(AgentError::InvalidTransition {
                from: AgentState::Terminated,
                to: AgentState::Terminated,
            });
        }
        agent.terminate();
        self.store.save_agent(&agent)?;
        Ok(agent)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::SqliteStore;

    #[test]
    fn test_agent_lifecycle() {
        let store = SqliteStore::in_memory().unwrap();
        let mgr = AgentManager::new(store);

        let agent = mgr.create("test-agent".into(), vec![]).unwrap();
        assert_eq!(agent.state, AgentState::Active);

        let fetched = mgr.get(&agent.id).unwrap();
        assert_eq!(fetched.name, "test-agent");

        let list = mgr.list().unwrap();
        assert_eq!(list.len(), 1);

        let terminated = mgr.terminate(&agent.id).unwrap();
        assert_eq!(terminated.state, AgentState::Terminated);
    }

    // ── Additional edge case tests ──

    #[test]
    fn get_nonexistent_agent_returns_not_found() {
        let store = SqliteStore::in_memory().unwrap();
        let mgr = AgentManager::new(store);
        let result = mgr.get("no-such-id");
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AgentError::NotFound(_)));
    }

    #[test]
    fn terminate_already_terminated_returns_invalid_transition() {
        let store = SqliteStore::in_memory().unwrap();
        let mgr = AgentManager::new(store);
        let agent = mgr.create("a".into(), vec![]).unwrap();
        mgr.terminate(&agent.id).unwrap();
        let result = mgr.terminate(&agent.id);
        assert!(result.is_err());
        assert!(matches!(result.unwrap_err(), AgentError::InvalidTransition { .. }));
    }

    #[test]
    fn terminate_nonexistent_agent() {
        let store = SqliteStore::in_memory().unwrap();
        let mgr = AgentManager::new(store);
        let result = mgr.terminate("no-such-id");
        assert!(matches!(result.unwrap_err(), AgentError::NotFound(_)));
    }

    #[test]
    fn activate_when_already_active_is_noop() {
        let mut agent = Agent::new("x".into());
        agent.activate(); // Created -> Active
        agent.activate(); // already Active, guard prevents change
        assert_eq!(agent.state, AgentState::Active);
    }

    #[test]
    fn activate_when_terminated_is_noop() {
        let mut agent = Agent::new("x".into());
        agent.activate();
        agent.terminate();
        agent.activate(); // Terminated → guard prevents
        assert_eq!(agent.state, AgentState::Terminated);
    }

    #[test]
    fn create_multiple_agents_list_all() {
        let store = SqliteStore::in_memory().unwrap();
        let mgr = AgentManager::new(store);
        mgr.create("a1".into(), vec![]).unwrap();
        mgr.create("a2".into(), vec![]).unwrap();
        mgr.create("a3".into(), vec![]).unwrap();
        assert_eq!(mgr.list().unwrap().len(), 3);
    }

    #[test]
    fn agent_new_generates_unique_ids() {
        let a1 = Agent::new("same".into());
        let a2 = Agent::new("same".into());
        assert_ne!(a1.id, a2.id);
    }

    #[test]
    fn create_agent_with_empty_name() {
        let store = SqliteStore::in_memory().unwrap();
        let mgr = AgentManager::new(store);
        let agent = mgr.create("".into(), vec![]);
        assert!(agent.is_ok());
        assert_eq!(agent.unwrap().name, "");
    }

    #[test]
    fn create_agent_with_genome() {
        let store = SqliteStore::in_memory().unwrap();
        let mgr = AgentManager::new(store);
        let genome = vec![[1u8; 32], [2u8; 32]];
        let agent = mgr.create("x".into(), genome.clone()).unwrap();
        assert_eq!(agent.genome, genome);
        let fetched = mgr.get(&agent.id).unwrap();
        assert_eq!(fetched.genome, genome);
    }
}
