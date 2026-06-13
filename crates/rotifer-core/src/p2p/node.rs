//! libp2p-backed P2P node: identity keypair + Swarm lifecycle.
//!
//! Responsibilities:
//!   - generate or load a persistent Ed25519 identity keypair
//!     (`~/.rotifer/identity.pem`, file mode 0600), from which the node's
//!     stable `PeerId` is derived;
//!   - construct a `libp2p` Swarm (tokio transport + Noise + Yamux) driven
//!     from a background task — wired in a follow-up change;
//!   - listen on the configured port (0 = OS-allocated) and shut down cleanly.
//!
//! This change implements the identity layer. The Swarm event loop
//! (`start` / `stop` / `listen_addrs`) is still a stub that returns
//! `NetworkError::Transport`.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use libp2p::PeerId as Libp2pPeerId;
use libp2p::identity::Keypair;

use super::{NetworkConfig, NetworkError, PeerId};

/// PEM armor label for the persisted node identity.
const IDENTITY_PEM_LABEL: &str = "ROTIFER IDENTITY";

/// libp2p-backed P2P node.
pub struct Node {
    pub config: NetworkConfig,
    pub keypair_path: PathBuf,
    pub listening: bool,
    /// Persistent Ed25519 identity; consumed by the Swarm in a follow-up
    /// change, never logged.
    #[allow(dead_code)]
    keypair: Keypair,
    /// PeerId derived from `keypair` — stable across restarts.
    peer_id: Libp2pPeerId,
}

impl std::fmt::Debug for Node {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Deliberately omit `keypair` — never expose private key material.
        f.debug_struct("Node")
            .field("config", &self.config)
            .field("keypair_path", &self.keypair_path)
            .field("listening", &self.listening)
            .field("peer_id", &self.peer_id)
            .finish_non_exhaustive()
    }
}

impl Node {
    /// Build a node using the default identity path (`~/.rotifer/identity.pem`).
    ///
    /// Loads an existing keypair or generates and persists a new one. The
    /// Swarm is started separately via [`Node::start`].
    pub fn new(config: NetworkConfig) -> Result<Self, NetworkError> {
        Self::with_keypair_path(config, default_identity_path())
    }

    /// Build a node with an explicit identity-file location.
    ///
    /// First run generates a fresh Ed25519 keypair and writes it (mode 0600);
    /// later runs reuse it, so the derived `PeerId` is stable.
    pub fn with_keypair_path(config: NetworkConfig, path: PathBuf) -> Result<Self, NetworkError> {
        let keypair = load_or_generate_keypair(&path)?;
        let peer_id = keypair.public().to_peer_id();
        Ok(Self {
            config,
            keypair_path: path,
            listening: false,
            keypair,
            peer_id,
        })
    }

    /// Stable libp2p `PeerId` derived from the persistent keypair.
    pub fn local_peer_id(&self) -> PeerId {
        PeerId(self.peer_id.to_string())
    }

    /// Active listen addresses (empty until the Swarm is started).
    pub fn listen_addrs(&self) -> Vec<String> {
        Vec::new()
    }

    /// Start the Swarm event loop — not yet wired.
    pub fn start(&mut self) -> Result<(), NetworkError> {
        Err(NetworkError::Transport("swarm event loop not yet wired".into()))
    }

    /// Stop the Swarm and release the port — not yet wired.
    pub fn stop(&mut self) -> Result<(), NetworkError> {
        Err(NetworkError::Transport("swarm event loop not yet wired".into()))
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        // Swarm task abort + port release land with the event-loop change.
    }
}

/// Default identity path: `$HOME/.rotifer/identity.pem`.
fn default_identity_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".rotifer").join("identity.pem")
}

/// Load an existing identity keypair from `path`, or generate + persist one.
fn load_or_generate_keypair(path: &Path) -> Result<Keypair, NetworkError> {
    if path.exists() {
        let text = std::fs::read_to_string(path)
            .map_err(|e| NetworkError::Transport(format!("read identity: {e}")))?;
        let bytes = decode_identity_pem(&text)?;
        Keypair::from_protobuf_encoding(&bytes)
            .map_err(|e| NetworkError::Transport(format!("parse identity: {e}")))
    } else {
        let keypair = Keypair::generate_ed25519();
        persist_keypair(path, &keypair)?;
        Ok(keypair)
    }
}

/// Serialize a keypair to PEM and write it with private-key permissions.
fn persist_keypair(path: &Path, keypair: &Keypair) -> Result<(), NetworkError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| NetworkError::Transport(format!("create identity dir: {e}")))?;
        }
    }
    let bytes = keypair
        .to_protobuf_encoding()
        .map_err(|e| NetworkError::Transport(format!("encode identity: {e}")))?;
    let pem = encode_identity_pem(&bytes);
    write_private(path, pem.as_bytes())
        .map_err(|e| NetworkError::Transport(format!("write identity: {e}")))?;
    Ok(())
}

/// PEM-armor raw bytes with the identity label, wrapped at 64 base64 chars.
fn encode_identity_pem(bytes: &[u8]) -> String {
    let b64 = BASE64.encode(bytes);
    let mut out = format!("-----BEGIN {IDENTITY_PEM_LABEL}-----\n");
    for line in b64.as_bytes().chunks(64) {
        // base64 output is ASCII, so each chunk is valid UTF-8.
        out.push_str(std::str::from_utf8(line).expect("base64 is ascii"));
        out.push('\n');
    }
    out.push_str(&format!("-----END {IDENTITY_PEM_LABEL}-----\n"));
    out
}

/// Strip PEM armor and base64-decode the identity body.
fn decode_identity_pem(text: &str) -> Result<Vec<u8>, NetworkError> {
    let body: String = text
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .flat_map(|l| l.chars())
        .filter(|c| !c.is_whitespace())
        .collect();
    BASE64
        .decode(body.as_bytes())
        .map_err(|e| NetworkError::Transport(format!("decode identity: {e}")))
}

/// Write `data` to `path`, owner read/write only (0600), created atomically.
#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    // Force exact 0600 regardless of the process umask.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, data)
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
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
    fn A_1_1_swarm_builder_default_config_starts() {
        let mut node = Node::new(cfg(0)).expect("A.1.1 — default config must build a swarm");
        node.start().expect("A.1.1 — swarm must start");
        assert!(!node.listen_addrs().is_empty(), "must allocate a listen address");
    }

    // -----------------------------------------------------------------
    // A.1.2 — Custom port listen + bind error on conflict
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
    fn A_1_2_custom_port_listen() {
        let mut node = Node::new(cfg(9878)).expect("A.1.2 — custom port must build");
        node.start().expect("A.1.2 — port 9878 must bind");
        assert!(
            node.listen_addrs().iter().any(|a| a.contains("9878")),
            "listen address must contain 9878"
        );
    }

    #[test]
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
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
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
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
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
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
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
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
    #[ignore = "stage 1 TDD baseline — stage 2 unignores"]
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
