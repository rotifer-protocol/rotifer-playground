//! P2P gene network foundation.
//!
//! v0.5 defined the protocol identifiers, message types, and a `StubNetwork`.
//! v0.9 adds the real libp2p networking in [`node`]: a Swarm with Kademlia
//! (peer discovery + a distributed record store) and GossipSub (announcement
//! broadcast). Earlier single-node `discovery`/`gossip` placeholders were
//! folded into [`node`] once the real multi-node implementation landed.
//!
//! Supporting submodules: `messages` (wire format), `security` (peer
//! validation + rate limiting), `cloud_sync` (Cloud<->P2P consistency).

use serde::{Deserialize, Serialize};

pub mod cloud_sync;
pub mod messages;
pub mod node;
pub mod security;

// Exploratory two-node connectivity spike (test-only).
#[cfg(test)]
mod spike;

/// Protocol identifier for gene discovery.
pub const GENE_DISCOVERY_PROTOCOL: &str = "/rotifer/gene-discovery/1.0.0";

/// Protocol identifier for gene metadata gossip.
pub const GENE_GOSSIP_PROTOCOL: &str = "/rotifer/gene-gossip/1.0.0";

/// A peer in the Rotifer P2P network.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct PeerId(pub String);

/// Multiaddr-like address for a peer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerAddr {
    pub peer_id: PeerId,
    pub address: String,
    pub last_seen: u64,
}

/// Gene metadata announcement broadcast via GossipSub.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneAnnouncement {
    pub gene_id: String,
    pub name: String,
    pub domain: String,
    pub version: String,
    pub fidelity: String,
    pub publisher: PeerId,
    pub reputation_score: f64,
    pub timestamp: u64,
}

/// Discovery query for finding genes by domain or keyword.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryQuery {
    pub query: String,
    pub domain: Option<String>,
    pub max_results: u32,
    pub requester: PeerId,
}

/// Response to a discovery query.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryResponse {
    pub announcements: Vec<GeneAnnouncement>,
    pub responder: PeerId,
    pub total_known: u32,
}

/// Network configuration for a Rotifer P2P node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkConfig {
    pub node_id: String,
    pub listen_port: u16,
    pub bootstrap_peers: Vec<String>,
    pub enabled: bool,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            node_id: uuid::Uuid::new_v4().to_string(),
            listen_port: 9878,
            bootstrap_peers: vec![
                "/dns4/bootstrap.rotifer.dev/tcp/9878".to_string(),
            ],
            enabled: false,
        }
    }
}

/// Trait for P2P network operations.
/// Implementations will use libp2p in v0.6+.
pub trait GeneNetwork: Send + Sync {
    /// Announce a gene to the network.
    fn announce(&self, announcement: GeneAnnouncement) -> Result<(), NetworkError>;

    /// Search for genes matching a query.
    fn discover(&self, query: DiscoveryQuery) -> Result<DiscoveryResponse, NetworkError>;

    /// List connected peers.
    fn peers(&self) -> Vec<PeerAddr>;

    /// Check if the node is connected to the network.
    fn is_connected(&self) -> bool;
}

/// Errors from P2P network operations.
#[derive(Debug, thiserror::Error)]
pub enum NetworkError {
    #[error("node not connected")]
    NotConnected,
    #[error("peer not found: {0}")]
    PeerNotFound(String),
    #[error("timeout waiting for response")]
    Timeout,
    #[error("network error: {0}")]
    Transport(String),
}

/// Stub implementation for v0.5 — logs operations but doesn't connect.
pub struct StubNetwork {
    config: NetworkConfig,
}

impl StubNetwork {
    pub fn new(config: NetworkConfig) -> Self {
        Self { config }
    }
}

impl GeneNetwork for StubNetwork {
    fn announce(&self, _announcement: GeneAnnouncement) -> Result<(), NetworkError> {
        if !self.config.enabled {
            return Err(NetworkError::NotConnected);
        }
        Ok(())
    }

    fn discover(&self, _query: DiscoveryQuery) -> Result<DiscoveryResponse, NetworkError> {
        if !self.config.enabled {
            return Err(NetworkError::NotConnected);
        }
        Ok(DiscoveryResponse {
            announcements: vec![],
            responder: PeerId(self.config.node_id.clone()),
            total_known: 0,
        })
    }

    fn peers(&self) -> Vec<PeerAddr> {
        self.config
            .bootstrap_peers
            .iter()
            .map(|addr| PeerAddr {
                peer_id: PeerId("bootstrap".to_string()),
                address: addr.clone(),
                last_seen: 0,
            })
            .collect()
    }

    fn is_connected(&self) -> bool {
        self.config.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config() {
        let config = NetworkConfig::default();
        assert_eq!(config.listen_port, 9878);
        assert!(!config.enabled);
        assert!(!config.bootstrap_peers.is_empty());
    }

    #[test]
    fn stub_not_connected_by_default() {
        let net = StubNetwork::new(NetworkConfig::default());
        assert!(!net.is_connected());
    }

    #[test]
    fn stub_announce_fails_when_disconnected() {
        let net = StubNetwork::new(NetworkConfig::default());
        let ann = GeneAnnouncement {
            gene_id: "test".into(),
            name: "test-gene".into(),
            domain: "test".into(),
            version: "0.1.0".into(),
            fidelity: "Native".into(),
            publisher: PeerId("me".into()),
            reputation_score: 0.5,
            timestamp: 0,
        };
        assert!(net.announce(ann).is_err());
    }

    #[test]
    fn stub_announce_succeeds_when_connected() {
        let config = NetworkConfig {
            enabled: true,
            ..Default::default()
        };
        let net = StubNetwork::new(config);
        let ann = GeneAnnouncement {
            gene_id: "test".into(),
            name: "test-gene".into(),
            domain: "test".into(),
            version: "0.1.0".into(),
            fidelity: "Native".into(),
            publisher: PeerId("me".into()),
            reputation_score: 0.5,
            timestamp: 0,
        };
        assert!(net.announce(ann).is_ok());
    }

    #[test]
    fn stub_discover_returns_empty() {
        let config = NetworkConfig {
            enabled: true,
            ..Default::default()
        };
        let net = StubNetwork::new(config);
        let query = DiscoveryQuery {
            query: "search".into(),
            domain: None,
            max_results: 10,
            requester: PeerId("me".into()),
        };
        let resp = net.discover(query).unwrap();
        assert!(resp.announcements.is_empty());
        assert_eq!(resp.total_known, 0);
    }

    #[test]
    fn stub_peers_returns_bootstrap() {
        let config = NetworkConfig::default();
        let bootstrap_count = config.bootstrap_peers.len();
        let net = StubNetwork::new(config);
        assert_eq!(net.peers().len(), bootstrap_count);
    }

    #[test]
    fn peer_id_equality() {
        let a = PeerId("abc".into());
        let b = PeerId("abc".into());
        let c = PeerId("xyz".into());
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn gene_announcement_serde() {
        let ann = GeneAnnouncement {
            gene_id: "id-123".into(),
            name: "my-gene".into(),
            domain: "search.web".into(),
            version: "0.1.0".into(),
            fidelity: "Native".into(),
            publisher: PeerId("peer-1".into()),
            reputation_score: 0.85,
            timestamp: 1000,
        };
        let json = serde_json::to_string(&ann).unwrap();
        let decoded: GeneAnnouncement = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.gene_id, "id-123");
        assert_eq!(decoded.name, "my-gene");
        assert_eq!(decoded.reputation_score, 0.85);
    }

    #[test]
    fn network_config_serde() {
        let config = NetworkConfig {
            node_id: "node-1".into(),
            listen_port: 4001,
            bootstrap_peers: vec!["/ip4/127.0.0.1/tcp/4001".into()],
            enabled: true,
        };
        let json = serde_json::to_string(&config).unwrap();
        let decoded: NetworkConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.node_id, "node-1");
        assert_eq!(decoded.listen_port, 4001);
        assert!(decoded.enabled);
    }

    #[test]
    fn discovery_query_with_domain() {
        let query = DiscoveryQuery {
            query: "web search".into(),
            domain: Some("search.web".into()),
            max_results: 5,
            requester: PeerId("me".into()),
        };
        assert_eq!(query.domain.unwrap(), "search.web");
    }

    #[test]
    fn network_error_display() {
        let e = NetworkError::NotConnected;
        assert_eq!(e.to_string(), "node not connected");

        let e = NetworkError::PeerNotFound("abc".into());
        assert!(e.to_string().contains("abc"));

        let e = NetworkError::Timeout;
        assert_eq!(e.to_string(), "timeout waiting for response");
    }
}
