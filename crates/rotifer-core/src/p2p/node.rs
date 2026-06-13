//! libp2p-backed P2P node: identity keypair + Swarm lifecycle.
//!
//! Responsibilities:
//!   - generate or load a persistent Ed25519 identity keypair
//!     (`~/.rotifer/identity.pem`, file mode 0600), from which the node's
//!     stable `PeerId` is derived;
//!   - construct a `libp2p` Swarm (tokio transport + Noise + Yamux) and drive
//!     it from a background task on a dedicated runtime;
//!   - listen on the configured port (0 = OS-allocated) and shut down cleanly,
//!     releasing the port.
//!
//! The Swarm runs asynchronously, but `Node` exposes a synchronous API: each
//! call hands work to the event loop over a channel and, where it needs a
//! result (e.g. the first listen address), blocks on the node's runtime.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use libp2p::futures::StreamExt;
use libp2p::identity::Keypair;
use libp2p::kad::{self, store::MemoryStore};
use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
use libp2p::{Multiaddr, PeerId as Libp2pPeerId, Swarm};
use tokio::sync::{mpsc, oneshot};

use super::{NetworkConfig, NetworkError, PeerId};

/// PEM armor label for the persisted node identity.
const IDENTITY_PEM_LABEL: &str = "ROTIFER IDENTITY";

/// How long `start` waits for the first listen address before giving up.
const LISTEN_READY_TIMEOUT: Duration = Duration::from_secs(5);

/// Commands sent from the synchronous `Node` API to the Swarm event loop.
enum Command {
    Shutdown,
}

/// Composite network behaviour driven by the node's Swarm. Kademlia provides
/// peer discovery + a distributed record store; gossip/identify land here in
/// follow-up changes.
#[derive(NetworkBehaviour)]
struct NodeBehaviour {
    kademlia: kad::Behaviour<MemoryStore>,
}

/// Peers the node has discovered (present in the Kademlia routing table),
/// shared between the synchronous API and the event loop.
type DiscoveredPeers = Arc<Mutex<HashSet<String>>>;

/// libp2p-backed P2P node.
pub struct Node {
    pub config: NetworkConfig,
    pub keypair_path: PathBuf,
    pub listening: bool,
    /// Persistent Ed25519 identity, cloned into the Swarm on `start`; never
    /// logged.
    keypair: Keypair,
    /// PeerId derived from `keypair` — stable across restarts.
    peer_id: Libp2pPeerId,
    /// Live listen addresses, updated by the Swarm event loop.
    listen_addrs: Arc<Mutex<Vec<String>>>,
    /// Peers discovered via Kademlia, updated by the event loop.
    discovered: DiscoveredPeers,
    /// Dedicated runtime hosting the Swarm event loop (`None` until `start`).
    runtime: Option<tokio::runtime::Runtime>,
    /// Command channel into the event loop (`None` until `start`).
    cmd_tx: Option<mpsc::UnboundedSender<Command>>,
    /// Handle to the spawned event-loop task (`None` until `start`).
    task: Option<tokio::task::JoinHandle<()>>,
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
            listen_addrs: Arc::new(Mutex::new(Vec::new())),
            discovered: Arc::new(Mutex::new(HashSet::new())),
            runtime: None,
            cmd_tx: None,
            task: None,
        })
    }

    /// Stable libp2p `PeerId` derived from the persistent keypair.
    pub fn local_peer_id(&self) -> PeerId {
        PeerId(self.peer_id.to_string())
    }

    /// Active listen addresses (empty until the Swarm is started).
    pub fn listen_addrs(&self) -> Vec<String> {
        self.listen_addrs
            .lock()
            .expect("listen_addrs mutex")
            .clone()
    }

    /// Peers discovered via Kademlia so far (empty until the Swarm is started
    /// and its routing table populates).
    pub fn discovered_peers(&self) -> Vec<String> {
        self.discovered
            .lock()
            .map(|peers| peers.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Start the Swarm: bind the listener and drive events from a background
    /// task on a dedicated runtime.
    ///
    /// Blocks until the first listen address is confirmed, or returns
    /// `Transport` if the bind fails (e.g. the port is already in use).
    /// Idempotent — a second call on a running node is a no-op.
    pub fn start(&mut self) -> Result<(), NetworkError> {
        if self.cmd_tx.is_some() {
            return Ok(());
        }

        // Pre-flight a busy-port check. libp2p's TCP transport sets
        // SO_REUSEPORT, which would otherwise let a second node silently share
        // a fixed port; a plain bind (without SO_REUSEPORT) fails fast instead.
        // Skipped for port 0, where the OS allocates a free port.
        if self.config.listen_port != 0 {
            std::net::TcpListener::bind(("127.0.0.1", self.config.listen_port))
                .map_err(|e| NetworkError::Transport(format!("listen: {e}")))?;
            // Probe dropped here — the port is free for the Swarm to bind.
        }

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|e| NetworkError::Transport(format!("runtime: {e}")))?;

        let keypair = self.keypair.clone();
        let port = self.config.listen_port;
        let bootstrap = self.config.bootstrap_peers.clone();
        let listen_addrs = Arc::clone(&self.listen_addrs);
        let discovered = Arc::clone(&self.discovered);
        let (ready_tx, ready_rx) = oneshot::channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        let task = runtime.spawn(run_event_loop(
            keypair,
            port,
            bootstrap,
            listen_addrs,
            discovered,
            ready_tx,
            cmd_rx,
        ));

        // Block until the listener comes up (or fails) before returning.
        let ready =
            runtime.block_on(async { tokio::time::timeout(LISTEN_READY_TIMEOUT, ready_rx).await });
        match ready {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => return Err(e),
            Ok(Err(_)) => {
                return Err(NetworkError::Transport(
                    "listener task ended before binding".into(),
                ));
            }
            Err(_) => {
                return Err(NetworkError::Transport(
                    "timed out waiting for listener".into(),
                ));
            }
        }

        self.runtime = Some(runtime);
        self.cmd_tx = Some(cmd_tx);
        self.task = Some(task);
        self.listening = true;
        Ok(())
    }

    /// Stop the Swarm, abort the event loop, and release the listener port.
    pub fn stop(&mut self) -> Result<(), NetworkError> {
        self.shutdown();
        Ok(())
    }

    /// Tear down the runtime + event loop. Safe to call when not started.
    fn shutdown(&mut self) {
        if let Some(tx) = self.cmd_tx.take() {
            let _ = tx.send(Command::Shutdown);
        }
        // Detach the join handle; the runtime shutdown below finishes or aborts
        // the task, which drops the Swarm and releases the port.
        self.task = None;
        if let Some(rt) = self.runtime.take() {
            rt.shutdown_timeout(Duration::from_secs(1));
        }
        self.listening = false;
        if let Ok(mut addrs) = self.listen_addrs.lock() {
            addrs.clear();
        }
        if let Ok(mut peers) = self.discovered.lock() {
            peers.clear();
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        if self.runtime.is_some() {
            self.shutdown();
        }
    }
}

/// Default identity path: `$HOME/.rotifer/identity.pem`.
fn default_identity_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".rotifer").join("identity.pem")
}

/// Load an existing identity keypair from `path`, or generate + persist a new
/// one. Race-safe: the file is created atomically, so if two nodes generate
/// concurrently the loser adopts the winner's persisted identity.
fn load_or_generate_keypair(path: &Path) -> Result<Keypair, NetworkError> {
    if let Some(keypair) = try_read_keypair(path)? {
        return Ok(keypair);
    }
    let keypair = Keypair::generate_ed25519();
    let written = persist_new_keypair(path, &keypair)
        .map_err(|e| NetworkError::Transport(format!("write identity: {e}")))?;
    if written {
        Ok(keypair)
    } else {
        // Another node won the create race — adopt its persisted identity.
        try_read_keypair(path)?
            .ok_or_else(|| NetworkError::Transport("identity missing after create race".into()))
    }
}

/// Read and decode the identity at `path`, or `None` if it does not exist.
fn try_read_keypair(path: &Path) -> Result<Option<Keypair>, NetworkError> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let bytes = decode_identity_pem(&text)?;
            let keypair = Keypair::from_protobuf_encoding(&bytes)
                .map_err(|e| NetworkError::Transport(format!("parse identity: {e}")))?;
            Ok(Some(keypair))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(NetworkError::Transport(format!("read identity: {e}"))),
    }
}

/// Serialize a keypair to PEM and create the file atomically (mode 0600).
/// Returns `Ok(false)` if the file already exists (lost a create race).
fn persist_new_keypair(path: &Path, keypair: &Keypair) -> std::io::Result<bool> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = keypair
        .to_protobuf_encoding()
        .map_err(std::io::Error::other)?;
    let pem = encode_identity_pem(&bytes);
    match write_new_private(path, pem.as_bytes()) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
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

/// Write `data` to a freshly created `path`, owner read/write only (0600).
/// Fails with `AlreadyExists` if the file is already there (atomic create).
#[cfg(unix)]
fn write_new_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(data)?;
    f.sync_all()?;
    // Force exact 0600 regardless of the process umask.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

#[cfg(not(unix))]
fn write_new_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(data)
}

/// Build a libp2p Swarm with TCP + QUIC transports (Noise + Yamux) over the
/// tokio runtime, carrying the node's composite behaviour (Kademlia in server
/// mode). Gossip/identify protocols are added in follow-up changes.
fn build_swarm(keypair: Keypair) -> Result<Swarm<NodeBehaviour>, NetworkError> {
    let swarm = libp2p::SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default(),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .map_err(|e| NetworkError::Transport(format!("tcp transport: {e}")))?
        .with_quic()
        .with_dns()
        .map_err(|e| NetworkError::Transport(format!("dns transport: {e}")))?
        .with_behaviour(|key| {
            let peer_id = key.public().to_peer_id();
            let mut kademlia = kad::Behaviour::new(peer_id, MemoryStore::new(peer_id));
            kademlia.set_mode(Some(kad::Mode::Server));
            NodeBehaviour { kademlia }
        })
        .expect("behaviour construction is infallible")
        .build();
    Ok(swarm)
}

/// Drive the Swarm: bind the listener, best-effort dial bootstrap peers, then
/// pump events (tracking listen addresses) until told to shut down.
///
/// Signals `ready_tx` exactly once: `Ok(())` on the first listen address, or
/// `Err` if the listener fails to bind.
async fn run_event_loop(
    keypair: Keypair,
    port: u16,
    bootstrap: Vec<String>,
    listen_addrs: Arc<Mutex<Vec<String>>>,
    discovered: DiscoveredPeers,
    ready_tx: oneshot::Sender<Result<(), NetworkError>>,
    mut cmd_rx: mpsc::UnboundedReceiver<Command>,
) {
    let mut swarm = match build_swarm(keypair) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    // Bind to loopback only; the listen address never reports the 0.0.0.0
    // wildcard. Port 0 lets the OS allocate.
    let listen_on: Multiaddr = match format!("/ip4/127.0.0.1/tcp/{port}").parse() {
        Ok(addr) => addr,
        Err(e) => {
            let _ = ready_tx.send(Err(NetworkError::Transport(format!("listen addr: {e}"))));
            return;
        }
    };
    if let Err(e) = swarm.listen_on(listen_on) {
        let _ = ready_tx.send(Err(NetworkError::Transport(format!("listen: {e}"))));
        return;
    }

    // Best-effort: malformed or unreachable bootstrap entries are skipped
    // without failing startup.
    for addr in &bootstrap {
        if let Ok(ma) = addr.parse::<Multiaddr>() {
            let _ = swarm.dial(ma);
        }
    }

    let mut ready_tx = Some(ready_tx);
    loop {
        tokio::select! {
            event = swarm.select_next_some() => match event {
                SwarmEvent::NewListenAddr { address, .. } => {
                    if let Ok(mut addrs) = listen_addrs.lock() {
                        addrs.push(address.to_string());
                    }
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Ok(()));
                    }
                }
                SwarmEvent::ExpiredListenAddr { address, .. } => {
                    if let Ok(mut addrs) = listen_addrs.lock() {
                        let gone = address.to_string();
                        addrs.retain(|a| a != &gone);
                    }
                }
                SwarmEvent::ListenerError { .. } => {
                    if let Some(tx) = ready_tx.take() {
                        let _ = tx.send(Err(NetworkError::Transport("listener error".into())));
                    }
                }
                SwarmEvent::ListenerClosed { reason, .. } => {
                    if let Some(tx) = ready_tx.take() {
                        let msg = match reason {
                            Ok(()) => "listener closed before binding".to_string(),
                            Err(e) => format!("listener closed: {e}"),
                        };
                        let _ = tx.send(Err(NetworkError::Transport(msg)));
                    }
                }
                SwarmEvent::ConnectionEstablished {
                    peer_id, endpoint, ..
                } => {
                    // Feed the connected peer's address into Kademlia so it
                    // enters the routing table — this drives discovery of
                    // dialed (e.g. bootstrap) peers.
                    let addr = endpoint.get_remote_address().clone();
                    swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Kademlia(
                    kad::Event::RoutingUpdated { peer, .. },
                )) => {
                    if let Ok(mut peers) = discovered.lock() {
                        peers.insert(peer.to_string());
                    }
                }
                _ => {}
            },
            cmd = cmd_rx.recv() => match cmd {
                Some(Command::Shutdown) | None => break,
            }
        }
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
        assert!(
            !node.listen_addrs().is_empty(),
            "must allocate a listen address"
        );
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
        b.start()
            .expect("A.1.3 — second start must succeed after drop");
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

        assert_eq!(
            id1.0, id2.0,
            "PeerId must persist across runs (same keypair)"
        );
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
        node.start()
            .expect("A.1.8 — start must succeed with unreachable bootstrap");
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
        assert!(
            !first.listen_addrs().is_empty(),
            "first listener must survive"
        );
    }

    // -----------------------------------------------------------------
    // Two-node Kademlia discovery over loopback (integration)
    // -----------------------------------------------------------------
    #[test]
    #[ignore = "two-node integration: real kad discovery over loopback — run with --ignored"]
    fn two_nodes_discover_via_kademlia() {
        // Distinct identity files so the two nodes get distinct PeerIds
        // (Node::new would share the default identity path).
        let a_id = std::env::temp_dir().join("rotifer-2node-a.pem");
        let b_id = std::env::temp_dir().join("rotifer-2node-b.pem");
        let _ = std::fs::remove_file(&a_id);
        let _ = std::fs::remove_file(&b_id);

        // Node A: listener with no bootstrap peers.
        let mut cfg_a = cfg(0);
        cfg_a.bootstrap_peers = vec![];
        let mut a = Node::with_keypair_path(cfg_a, a_id.clone()).expect("A build");
        a.start().expect("A start");
        let a_addr = a
            .listen_addrs()
            .into_iter()
            .next()
            .expect("A must have a listen address");
        let a_peer = a.local_peer_id().0;

        // Node B: bootstraps from A's address.
        let mut cfg_b = cfg(0);
        cfg_b.bootstrap_peers = vec![a_addr];
        let mut b = Node::with_keypair_path(cfg_b, b_id.clone()).expect("B build");
        b.start().expect("B start");
        assert_ne!(a_peer, b.local_peer_id().0, "nodes must have distinct PeerIds");

        // Poll until B's Kademlia routing table holds A (discovery is async).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if b.discovered_peers().iter().any(|p| p == &a_peer) {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "B did not discover A via Kademlia within 10s"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let _ = std::fs::remove_file(&a_id);
        let _ = std::fs::remove_file(&b_id);
    }
}
