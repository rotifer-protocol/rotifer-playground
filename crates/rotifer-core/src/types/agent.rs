//! Agent types — autonomous digital lifeforms that carry a genome of genes.

use serde::{Deserialize, Serialize};

use super::{GeneId, ReputationScore, Timestamp};

/// Lifecycle state of an agent.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AgentState {
    Created,
    Active,
    Terminated,
    /// Fallback for forward compatibility — older versions deserialize
    /// unknown future variants (e.g. `Dormant`) without crashing.
    #[serde(other)]
    Unknown,
}

/// An autonomous agent carrying a genome of [`GeneId`]s.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub state: AgentState,
    pub genome: Vec<GeneId>,
    pub created_at: Timestamp,
    pub reputation: ReputationScore,
}

impl Agent {
    /// Create a new agent in [`AgentState::Created`] with a random UUID.
    pub fn new(name: String) -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        Self {
            id,
            name,
            state: AgentState::Created,
            genome: Vec::new(),
            created_at: chrono::Utc::now().timestamp_millis() as u64,
            reputation: 0.0,
        }
    }

    /// Transition from `Created` to `Active`. No-op if already active.
    pub fn activate(&mut self) {
        if self.state == AgentState::Created {
            self.state = AgentState::Active;
        }
    }

    /// Irreversibly move the agent to `Terminated`.
    pub fn terminate(&mut self) {
        self.state = AgentState::Terminated;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_agent_starts_in_created_state() {
        let agent = Agent::new("scout".to_string());
        assert_eq!(agent.state, AgentState::Created);
        assert_eq!(agent.name, "scout");
        assert!(agent.genome.is_empty());
        assert_eq!(agent.reputation, 0.0);
        assert!(agent.created_at > 0);
    }

    #[test]
    fn new_agents_get_distinct_ids() {
        let first = Agent::new("scout".to_string());
        let second = Agent::new("scout".to_string());
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn activate_moves_created_to_active() {
        let mut agent = Agent::new("scout".to_string());
        agent.activate();
        assert_eq!(agent.state, AgentState::Active);
    }

    #[test]
    fn activate_is_idempotent() {
        let mut agent = Agent::new("scout".to_string());
        agent.activate();
        agent.activate();
        assert_eq!(agent.state, AgentState::Active);
    }

    #[test]
    fn terminate_is_reachable_from_any_state() {
        let mut created = Agent::new("scout".to_string());
        created.terminate();
        assert_eq!(created.state, AgentState::Terminated);

        let mut active = Agent::new("scout".to_string());
        active.activate();
        active.terminate();
        assert_eq!(active.state, AgentState::Terminated);
    }

    #[test]
    fn terminated_agent_cannot_be_revived() {
        let mut agent = Agent::new("scout".to_string());
        agent.terminate();
        agent.activate();
        assert_eq!(agent.state, AgentState::Terminated);
    }

    #[test]
    fn unknown_state_variant_deserializes_without_error() {
        let state: AgentState = serde_json::from_str("\"Dormant\"").unwrap();
        assert_eq!(state, AgentState::Unknown);
    }

    #[test]
    fn agent_serde_roundtrip() {
        let mut agent = Agent::new("scout".to_string());
        agent.activate();
        let json = serde_json::to_string(&agent).unwrap();
        let restored: Agent = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.id, agent.id);
        assert_eq!(restored.state, AgentState::Active);
        assert_eq!(restored.created_at, agent.created_at);
    }
}
