//! A.1 — libp2p Swarm node (v0.9 stage 1 placeholder).
//!
//! The real implementation will:
//!   - construct a `libp2p::SwarmBuilder` with tokio runtime + Noise + Yamux
//!   - generate / load an Ed25519 keypair persisted at `~/.rotifer/identity.pem`
//!   - listen on the configured port (0 = OS-allocated)
//!   - drive the swarm via a background tokio task
//!
//! Stage 1 ships only the type signatures + test scaffolds (A.1.1–A.1.9).
//! `Node::new` returns `Err(NetworkError::Transport(...))` so every test
//! correctly fails until stage 2 wires libp2p in.

use std::path::PathBuf;

use super::{NetworkConfig, NetworkError, PeerId};

/// Real libp2p-backed P2P node — placeholder type for stage 1.
#[derive(Debug)]
pub struct Node {
    pub config: NetworkConfig,
    pub keypair_path: PathBuf,
    pub listening: bool,
}

impl Node {
    /// Build a Swarm with default tokio transport + Noise + Yamux.
    pub fn new(config: NetworkConfig) -> Result<Self, NetworkError> {
        let _ = config;
        Err(NetworkError::Transport(
            "A.1.x — Node::new not yet implemented (libp2p Swarm — stage 2)".into(),
        ))
    }

    /// Build with explicit keypair file location — used by A.1.4 persistence test.
    pub fn with_keypair_path(config: NetworkConfig, path: PathBuf) -> Result<Self, NetworkError> {
        let _ = (config, path);
        Err(NetworkError::Transport(
            "A.1.4 — Node::with_keypair_path not implemented (stage 2)".into(),
        ))
    }

    pub fn local_peer_id(&self) -> PeerId {
        PeerId(self.config.node_id.clone())
    }

    pub fn listen_addrs(&self) -> Vec<String> {
        Vec::new()
    }

    pub fn start(&mut self) -> Result<(), NetworkError> {
        Err(NetworkError::Transport(
            "A.1.x — Node::start not implemented (stage 2)".into(),
        ))
    }

    pub fn stop(&mut self) -> Result<(), NetworkError> {
        Err(NetworkError::Transport(
            "A.1.3 — Node::stop not implemented (stage 2)".into(),
        ))
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        // Stage 2: ensure the swarm task is aborted + port released.
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn cfg(port: u16) -> NetworkConfig {
        let mut c = NetworkConfig::default();
        c.listen_port = port;
        c.enabled = true;
        c
    }

    // -----------------------------------------------------------------
    // A.1.1 — SwarmBuilder default config starts
    // -----------------------------------------------------------------
    #[test]
    fn A_1_1_swarm_builder_default_config_starts() {
        let mut node = Node::new(cfg(0)).expect("A.1.1 — default config must build a swarm");
        node.start().expect("A.1.1 — swarm must start");
        assert!(!node.listen_addrs().is_empty(), "must allocate a listen address");
    }

    // -----------------------------------------------------------------
    // A.1.2 — Custom port listen + bind error on conflict
    // -----------------------------------------------------------------
    #[test]
    fn A_1_2_custom_port_listen() {
        let mut node = Node::new(cfg(9878)).expect("A.1.2 — custom port must build");
        node.start().expect("A.1.2 — port 9878 must bind");
        assert!(
            node.listen_addrs().iter().any(|a| a.contains("9878")),
            "listen address must contain 9878"
        );
    }

    #[test]
    fn A_1_2_port_already_in_use_returns_transport_error() {
        let mut first = Node::new(cfg(9879)).expect("A.1.2 — first node builds");
        first.start().expect("A.1.2 — first node starts");

        let mut second = Node::new(cfg(9879)).expect("A.1.2 — second build is ok");
        let err = second.start().expect_err("A.1.2 — second start must fail");
        assert!(matches!(err, NetworkError::Transport(_)));
    }

    // -----------------------------------------------------------------
    // A.1.3 — Graceful shutdown releases the port
    // -----------------------------------------------------------------
    #[test]
    fn A_1_3_drop_releases_port() {
        let port = 9880;
        {
            let mut a = Node::new(cfg(port)).expect("A.1.3 — first build");
            a.start().expect("A.1.3 — first start");
        }
        // Port should now be free again.
        let mut b = Node::new(cfg(port)).expect("A.1.3 — second build");
        b.start().expect("A.1.3 — second start must succeed after drop");
    }

    // -----------------------------------------------------------------
    // A.1.4 — Keypair persistence at ~/.rotifer/identity.pem (file mode 0600)
    // -----------------------------------------------------------------
    #[test]
    fn A_1_4_keypair_persistence_first_run_generates() {
        let tmp = std::env::temp_dir().join("rotifer-test-identity.pem");
        let _ = std::fs::remove_file(&tmp);

        let _node = Node::with_keypair_path(cfg(0), tmp.clone())
            .expect("A.1.4 — first run must generate keypair");
        assert!(tmp.is_file(), "keypair file must exist after first run");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&tmp).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "keypair file must be mode 0600");
        }

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn A_1_4_keypair_persistence_second_run_reuses() {
        let tmp = std::env::temp_dir().join("rotifer-test-identity-reuse.pem");
        let _ = std::fs::remove_file(&tmp);

        let n1 = Node::with_keypair_path(cfg(0), tmp.clone()).expect("first run");
        let id1 = n1.local_peer_id();
        let n2 = Node::with_keypair_path(cfg(0), tmp.clone()).expect("second run");
        let id2 = n2.local_peer_id();

        assert_eq!(id1.0, id2.0, "PeerId must persist across runs (same keypair)");
        let _ = std::fs::remove_file(&tmp);
    }

    // -----------------------------------------------------------------
    // A.1.5 — PeerId is deterministic from the keypair
    // -----------------------------------------------------------------
    #[test]
    fn A_1_5_peer_id_deterministic_from_keypair() {
        let path = std::env::temp_dir().join("rotifer-test-determinism.pem");
        let _ = std::fs::remove_file(&path);

        let n1 = Node::with_keypair_path(cfg(0), path.clone()).expect("first build");
        let id1 = n1.local_peer_id();
        drop(n1);

        let n2 = Node::with_keypair_path(cfg(0), path.clone()).expect("second build");
        let id2 = n2.local_peer_id();

        assert_eq!(id1.0, id2.0, "same keypair → same PeerId");
        let _ = std::fs::remove_file(&path);
    }

    // -----------------------------------------------------------------
    // A.1.6 — mDNS auto-discovery (≤3s) between two co-process nodes
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "A.1.6 integration — requires tokio multi-thread runtime; stage 2 unignores"]
    fn A_1_6_two_nodes_mdns_self_discover_within_3s() {
        // tokio::time::timeout(Duration::from_secs(3), ...) — stage 2
        let mut a = Node::new(cfg(0)).expect("A.1.6 — node A build");
        let mut b = Node::new(cfg(0)).expect("A.1.6 — node B build");
        a.start().expect("A.1.6 — A start");
        b.start().expect("A.1.6 — B start");
        // Stage 2: poll discovery events until both peers see each other.
        unimplemented!("A.1.6 — stage 2 wires mDNS event-loop");
    }

    // -----------------------------------------------------------------
    // A.1.7 — 0.0.0.0 vs 127.0.0.1 bind semantics
    // -----------------------------------------------------------------
    #[test]
    fn A_1_7_bind_loopback_rejects_external() {
        let mut c = cfg(0);
        c.bootstrap_peers = vec!["/ip4/127.0.0.1/tcp/0".into()];
        let mut node = Node::new(c).expect("A.1.7 — loopback build");
        node.start().expect("A.1.7 — loopback bind");
        assert!(node.listen_addrs().iter().all(|a| !a.contains("0.0.0.0")));
    }

    // -----------------------------------------------------------------
    // A.1.8 — Bootstrap peer unreachable → graceful degradation
    // -----------------------------------------------------------------
    #[test]
    fn A_1_8_unreachable_bootstrap_does_not_panic() {
        let mut c = cfg(0);
        c.bootstrap_peers = vec![
            "/dns4/no-such-host.invalid/tcp/9878".into(),
            "not-a-valid-multiaddr".into(),
        ];
        let mut node = Node::new(c).expect("A.1.8 — build with unreachable bootstrap");
        // Should not panic — should return Ok with empty peer set.
        node.start().expect("A.1.8 — start must succeed with unreachable bootstrap");
    }

    // -----------------------------------------------------------------
    // A.1.9 — Second swarm on a busy port returns Err while leaving the first alone
    // -----------------------------------------------------------------
    #[test]
    fn A_1_9_port_conflict_isolation() {
        let port = 9881;
        let mut first = Node::new(cfg(port)).expect("A.1.9 — first build");
        first.start().expect("A.1.9 — first start");

        let mut second = Node::new(cfg(port)).expect("A.1.9 — second build");
        let err = second.start().expect_err("A.1.9 — second start must fail");
        assert!(matches!(err, NetworkError::Transport(_)));

        // First must still be listening.
        assert!(!first.listen_addrs().is_empty(), "first listener must survive");
    }
}
