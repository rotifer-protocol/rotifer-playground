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
