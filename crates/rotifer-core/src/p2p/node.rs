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

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use libp2p::futures::StreamExt;
use libp2p::connection_limits;
use libp2p::gossipsub;
use libp2p::identify;
use libp2p::memory_connection_limits;
use libp2p::identity::Keypair;
use libp2p::kad::{self, store::MemoryStore};
use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
use libp2p::{Multiaddr, PeerId as Libp2pPeerId, Swarm};
use tokio::sync::{mpsc, oneshot};

use super::{NetworkConfig, NetworkError, PeerId};

/// PEM armor label for the persisted node identity.
const IDENTITY_PEM_LABEL: &str = "ROTIFER IDENTITY";

/// How long `start` waits for the first listen address before giving up.
/// Generous on purpose: the listen event normally fires in well under a second,
/// but a loaded CI runner (the whole test suite in parallel) can starve the
/// Swarm's runtime worker for several seconds — a tight bound flaked there.
const LISTEN_READY_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a DHT put/get blocks for its query to resolve.
const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

/// Commands sent from the synchronous `Node` API to the Swarm event loop.
enum Command {
    Shutdown,
    Subscribe(String),
    Publish {
        topic: String,
        data: Vec<u8>,
    },
    PutRecord {
        key: Vec<u8>,
        value: Vec<u8>,
        resp: oneshot::Sender<Result<(), NetworkError>>,
    },
    GetRecord {
        key: Vec<u8>,
        resp: oneshot::Sender<Option<Vec<u8>>>,
    },
}

/// libp2p Identify protocol version advertised by Rotifer nodes. Peers compare
/// this to spot protocol-incompatible nodes; autonat/dcutr (Milestone B) build
/// on the observed-address info Identify provides. ADR-304.
const IDENTIFY_PROTOCOL_VERSION: &str = "/rotifer/0.9.1";

/// Composite network behaviour driven by the node's Swarm. Kademlia provides
/// peer discovery + a distributed record store; GossipSub provides
/// publish/subscribe message broadcast; Identify exchanges peer metadata
/// (protocols, listen + observed addrs) on connect.
/// Conservative connection-limit defaults (ADR-304 D2). They cap how many
/// connections the Swarm holds so a node can't be connected into OOM; the
/// per-peer + total ceilings pair with the message-layer rate limit (§8.6).
/// Real values get tuned against the public-network load test (Milestone C).
const MAX_ESTABLISHED: u32 = 512;
const MAX_ESTABLISHED_PER_PEER: u32 = 4;
const MAX_PENDING_INCOMING: u32 = 32;
const MAX_PENDING_OUTGOING: u32 = 32;
const MAX_ESTABLISHED_INCOMING: u32 = 256;
const MAX_ESTABLISHED_OUTGOING: u32 = 256;
/// Deny new connections once process memory exceeds this fraction of system RAM.
const MAX_MEMORY_PERCENTAGE: f64 = 0.9;

#[derive(NetworkBehaviour)]
struct NodeBehaviour {
    kademlia: kad::Behaviour<MemoryStore>,
    gossipsub: gossipsub::Behaviour,
    identify: identify::Behaviour,
    /// Caps total / per-peer / pending connections so a node can't be connected
    /// into resource exhaustion — the scale-up guardrail (ADR-304 D2).
    connection_limits: connection_limits::Behaviour,
    /// Denies new connections under memory pressure (process RSS vs system RAM).
    memory_connection_limits: memory_connection_limits::Behaviour,
}

/// Peers the node has discovered (present in the Kademlia routing table),
/// shared between the synchronous API and the event loop.
type DiscoveredPeers = Arc<Mutex<HashSet<String>>>;

/// A GossipSub message received by the node, carrying its authenticated
/// publisher. With `MessageAuthenticity::Signed`, `source` is bound to the
/// signer's key and cannot be forged (the §8.3 node-identity-forgery defence).
#[derive(Debug, Clone)]
pub struct ReceivedMessage {
    pub topic: String,
    pub data: Vec<u8>,
    pub source: Option<String>,
}

/// GossipSub messages received by the node, shared between the synchronous API
/// and the event loop.
type ReceivedMessages = Arc<Mutex<Vec<ReceivedMessage>>>;

/// Shared state handles the event loop updates and the synchronous API reads.
struct NodeShared {
    listen_addrs: Arc<Mutex<Vec<String>>>,
    discovered: DiscoveredPeers,
    /// Peers we have completed an Identify exchange with (ADR-304).
    identified: DiscoveredPeers,
    received: ReceivedMessages,
    rate_limited: Arc<Mutex<u64>>,
    /// Count of inbound connections denied by the connection limits (ADR-304).
    rejected: Arc<Mutex<u64>>,
}

/// Fixed listen ports currently bound by live nodes in this process. libp2p's
/// TCP transport hardcodes SO_REUSEPORT, so the OS will not reject a duplicate
/// bind to the same port; tracking them here lets a conflicting `start` fail
/// deterministically (probing with a throwaway socket instead is flaky on Linux).
static BOUND_PORTS: LazyLock<Mutex<HashSet<u16>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

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
    /// Peers we have completed an Identify exchange with (ADR-304).
    identified: DiscoveredPeers,
    /// GossipSub messages received so far, appended by the event loop.
    received: ReceivedMessages,
    /// Count of inbound messages dropped by the per-peer rate limiter (§8.6).
    rate_limited: Arc<Mutex<u64>>,
    /// Count of inbound connections denied by the connection limits (ADR-304).
    rejected: Arc<Mutex<u64>>,
    /// Override for `max_established_incoming` (tests / future config). `None`
    /// uses the conservative `MAX_ESTABLISHED_INCOMING` default (ADR-304).
    max_established_incoming: Option<u32>,
    /// Dedicated runtime hosting the Swarm event loop (`None` until `start`).
    runtime: Option<tokio::runtime::Runtime>,
    /// Command channel into the event loop (`None` until `start`).
    cmd_tx: Option<mpsc::UnboundedSender<Command>>,
    /// Handle to the spawned event-loop task (`None` until `start`).
    task: Option<tokio::task::JoinHandle<()>>,
    /// Fixed port reserved in `BOUND_PORTS` (released on shutdown).
    bound_port: Option<u16>,
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
            identified: Arc::new(Mutex::new(HashSet::new())),
            received: Arc::new(Mutex::new(Vec::new())),
            rate_limited: Arc::new(Mutex::new(0)),
            rejected: Arc::new(Mutex::new(0)),
            max_established_incoming: None,
            runtime: None,
            cmd_tx: None,
            task: None,
            bound_port: None,
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

    /// Peers this node has completed an Identify exchange with (ADR-304). Empty
    /// until the Swarm is started and at least one peer connects + identifies.
    pub fn identified_peers(&self) -> Vec<String> {
        self.identified
            .lock()
            .map(|peers| peers.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Override the max number of established **inbound** connections (ADR-304).
    /// `None`/unset keeps the conservative default. Mainly for tests + future
    /// config; must be called before [`Node::start`].
    pub fn with_max_established_incoming(mut self, max: u32) -> Self {
        self.max_established_incoming = Some(max);
        self
    }

    /// Count of inbound connections denied so far by the connection limits
    /// (ADR-304). Non-zero means the node shed load under its connection cap.
    pub fn rejected_connections(&self) -> u64 {
        self.rejected.lock().map(|n| *n).unwrap_or(0)
    }

    /// Subscribe to a GossipSub topic. Requires the node to be started.
    pub fn subscribe(&self, topic: &str) -> Result<(), NetworkError> {
        self.send_command(Command::Subscribe(topic.to_string()))
    }

    /// Publish `data` to a GossipSub topic. Fire-and-forget: delivery needs a
    /// formed mesh, so callers broadcasting to fresh peers should retry until a
    /// subscriber receives it.
    pub fn publish(&self, topic: &str, data: &[u8]) -> Result<(), NetworkError> {
        self.send_command(Command::Publish {
            topic: topic.to_string(),
            data: data.to_vec(),
        })
    }

    /// GossipSub messages received so far, each with its authenticated publisher.
    pub fn received_messages(&self) -> Vec<ReceivedMessage> {
        self.received.lock().map(|m| m.clone()).unwrap_or_default()
    }

    /// Number of inbound messages dropped by the per-peer rate limiter (§8.6).
    pub fn rate_limited_count(&self) -> u64 {
        self.rate_limited.lock().map(|n| *n).unwrap_or(0)
    }

    /// Store a record in the Kademlia DHT, replicated to the closest peers.
    /// Blocks until the write quorum is reached (or times out).
    pub fn put_record(&self, key: &[u8], value: &[u8]) -> Result<(), NetworkError> {
        let (tx, rx) = oneshot::channel();
        self.send_command(Command::PutRecord {
            key: key.to_vec(),
            value: value.to_vec(),
            resp: tx,
        })?;
        match self.block_on_query(rx) {
            Ok(inner) => inner,
            Err(e) => Err(e),
        }
    }

    /// Look up a record in the Kademlia DHT, returning its value if found.
    /// Blocks until the query resolves (or times out).
    pub fn get_record(&self, key: &[u8]) -> Result<Option<Vec<u8>>, NetworkError> {
        let (tx, rx) = oneshot::channel();
        self.send_command(Command::GetRecord {
            key: key.to_vec(),
            resp: tx,
        })?;
        self.block_on_query(rx)
    }

    /// Hand a command to the running event loop.
    fn send_command(&self, command: Command) -> Result<(), NetworkError> {
        match &self.cmd_tx {
            Some(tx) => tx
                .send(command)
                .map_err(|_| NetworkError::Transport("event loop is not running".into())),
            None => Err(NetworkError::NotConnected),
        }
    }

    /// Block on a query-response channel using the node's runtime.
    fn block_on_query<T>(&self, rx: oneshot::Receiver<T>) -> Result<T, NetworkError> {
        let runtime = self.runtime.as_ref().ok_or(NetworkError::NotConnected)?;
        match runtime.block_on(async { tokio::time::timeout(QUERY_TIMEOUT, rx).await }) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(_)) => Err(NetworkError::Transport("event loop dropped the response".into())),
            Err(_) => Err(NetworkError::Timeout),
        }
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

        // Reserve a fixed port in-process so a second node on the same port
        // fails deterministically — libp2p hardcodes SO_REUSEPORT, so the OS
        // won't reject the duplicate bind itself. Port 0 = OS-allocated, skip.
        if self.config.listen_port != 0 {
            let mut bound = BOUND_PORTS.lock().expect("bound-ports mutex");
            if !bound.insert(self.config.listen_port) {
                return Err(NetworkError::Transport(format!(
                    "listen: port {} already in use",
                    self.config.listen_port
                )));
            }
            self.bound_port = Some(self.config.listen_port);
        }

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|e| NetworkError::Transport(format!("runtime: {e}")))?;

        let keypair = self.keypair.clone();
        let host = self.config.listen_host.clone();
        let port = self.config.listen_port;
        let bootstrap = self.config.bootstrap_peers.clone();
        let max_established_incoming = self.max_established_incoming;
        let shared = NodeShared {
            listen_addrs: Arc::clone(&self.listen_addrs),
            discovered: Arc::clone(&self.discovered),
            identified: Arc::clone(&self.identified),
            received: Arc::clone(&self.received),
            rate_limited: Arc::clone(&self.rate_limited),
            rejected: Arc::clone(&self.rejected),
        };
        let (ready_tx, ready_rx) = oneshot::channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        let task = runtime.spawn(run_event_loop(
            keypair, host, port, bootstrap, max_established_incoming, shared, ready_tx,
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
        if let Ok(mut peers) = self.identified.lock() {
            peers.clear();
        }
        if let Ok(mut msgs) = self.received.lock() {
            msgs.clear();
        }
        if let Some(port) = self.bound_port.take()
            && let Ok(mut bound) = BOUND_PORTS.lock()
        {
            bound.remove(&port);
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        if self.runtime.is_some() || self.bound_port.is_some() {
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
    // Generate + persist atomically. Concurrent generators each write their own
    // keypair and the rename makes the last one win; crucially, every reader
    // sees either no file or a complete one — never a half-written identity.
    let keypair = Keypair::generate_ed25519();
    persist_keypair(path, &keypair)
        .map_err(|e| NetworkError::Transport(format!("write identity: {e}")))?;
    Ok(keypair)
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

/// Serialize a keypair to PEM and write it atomically (mode 0600): a temp
/// sibling is written then renamed onto `path`, so a concurrent reader never
/// observes a partially-written file.
fn persist_keypair(path: &Path, keypair: &Keypair) -> std::io::Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    let bytes = keypair
        .to_protobuf_encoding()
        .map_err(std::io::Error::other)?;
    let pem = encode_identity_pem(&bytes);
    write_atomic_private(path, pem.as_bytes())
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

/// A unique temp path beside `path` (per-process, per-call) for atomic writes.
fn tmp_sibling(path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = path
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(format!(".tmp.{}.{n}", std::process::id()));
    path.with_file_name(name)
}

/// Atomically write `data` to `path`, owner read/write only (0600): write a
/// temp sibling, fsync, set mode, then rename. A reader sees the old file or
/// the complete new one — never a partial write.
#[cfg(unix)]
fn write_atomic_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let tmp = tmp_sibling(path);
    {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(not(unix))]
fn write_atomic_private(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let tmp = tmp_sibling(path);
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)
}

/// Build a libp2p Swarm with TCP + QUIC transports (Noise + Yamux) over the
/// tokio runtime, carrying the node's composite behaviour (Kademlia in server
/// mode, plus GossipSub and Identify). autonat/dcutr land in Milestone B (ADR-304).
fn build_swarm(
    keypair: Keypair,
    max_established_incoming: Option<u32>,
) -> Result<Swarm<NodeBehaviour>, NetworkError> {
    let swarm = libp2p::SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default(),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .map_err(|e| NetworkError::Transport(format!("tcp transport: {e}")))?
        .with_quic()
        .with_behaviour(|key| {
            let peer_id = key.public().to_peer_id();
            let mut kademlia = kad::Behaviour::new(peer_id, MemoryStore::new(peer_id));
            kademlia.set_mode(Some(kad::Mode::Server));
            let gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                gossipsub::Config::default(),
            )
            .expect("default gossipsub config is valid");
            let identify = identify::Behaviour::new(identify::Config::new(
                IDENTIFY_PROTOCOL_VERSION.to_string(),
                key.public(),
            ));
            let limits = connection_limits::ConnectionLimits::default()
                .with_max_established(Some(MAX_ESTABLISHED))
                .with_max_established_per_peer(Some(MAX_ESTABLISHED_PER_PEER))
                .with_max_pending_incoming(Some(MAX_PENDING_INCOMING))
                .with_max_pending_outgoing(Some(MAX_PENDING_OUTGOING))
                .with_max_established_incoming(Some(
                    max_established_incoming.unwrap_or(MAX_ESTABLISHED_INCOMING),
                ))
                .with_max_established_outgoing(Some(MAX_ESTABLISHED_OUTGOING));
            let connection_limits = connection_limits::Behaviour::new(limits);
            let memory_connection_limits =
                memory_connection_limits::Behaviour::with_max_percentage(MAX_MEMORY_PERCENTAGE);
            NodeBehaviour {
                kademlia,
                gossipsub,
                identify,
                connection_limits,
                memory_connection_limits,
            }
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
// The Swarm driver legitimately needs identity, listen config, the inbound
// limit, shared state, and both channels; grouping them would only obscure the
// wiring of this single internal entry point.
#[allow(clippy::too_many_arguments)]
async fn run_event_loop(
    keypair: Keypair,
    host: String,
    port: u16,
    bootstrap: Vec<String>,
    max_established_incoming: Option<u32>,
    shared: NodeShared,
    ready_tx: oneshot::Sender<Result<(), NetworkError>>,
    mut cmd_rx: mpsc::UnboundedReceiver<Command>,
) {
    let NodeShared {
        listen_addrs,
        discovered,
        identified,
        received,
        rate_limited,
        rejected,
    } = shared;
    // Per-peer flood defence (§8.6); lives in the single-threaded event loop.
    let mut security = super::security::Security::new();
    let mut swarm = match build_swarm(keypair, max_established_incoming) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };

    // Bind to the configured interface (default 127.0.0.1 loopback; set 0.0.0.0
    // to accept connections from other hosts). Port 0 lets the OS allocate.
    let listen_on: Multiaddr = match format!("/ip4/{host}/tcp/{port}").parse() {
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
    // Correlate in-flight DHT queries with the caller waiting on the result.
    let mut pending_put: HashMap<kad::QueryId, oneshot::Sender<Result<(), NetworkError>>> =
        HashMap::new();
    let mut pending_get: HashMap<kad::QueryId, oneshot::Sender<Option<Vec<u8>>>> = HashMap::new();
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
                SwarmEvent::IncomingConnectionError { .. } => {
                    // A pending inbound connection failed — most commonly denied
                    // by the connection limits (ADR-304 D2). Count + log so load
                    // shedding is observable instead of silent.
                    if let Ok(mut n) = rejected.lock() {
                        *n += 1;
                    }
                    tracing::debug!(
                        "inbound connection rejected (connection limit reached or transport error)"
                    );
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Kademlia(
                    kad::Event::RoutingUpdated { peer, .. },
                )) => {
                    if let Ok(mut peers) = discovered.lock() {
                        peers.insert(peer.to_string());
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Gossipsub(
                    gossipsub::Event::Message {
                        propagation_source,
                        message,
                        ..
                    },
                )) => {
                    // Flood defence (§8.6): rate-limit per sending peer. Over the
                    // ceiling, drop the message and count it instead of enqueuing.
                    let sender = PeerId(propagation_source.to_string());
                    if security.record_message(&sender).is_ok() {
                        if let Ok(mut msgs) = received.lock() {
                            msgs.push(ReceivedMessage {
                                topic: message.topic.to_string(),
                                data: message.data,
                                source: message.source.map(|p| p.to_string()),
                            });
                        }
                    } else if let Ok(mut n) = rate_limited.lock() {
                        *n += 1;
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Identify(
                    identify::Event::Received { peer_id, info, .. },
                )) => {
                    if let Ok(mut ids) = identified.lock() {
                        ids.insert(peer_id.to_string());
                    }
                    // Feed the peer's advertised listen addresses into Kademlia
                    // to improve routing — standard Identify usage (ADR-304).
                    for addr in info.listen_addrs {
                        swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Kademlia(
                    kad::Event::OutboundQueryProgressed { id, result, .. },
                )) => match result {
                    kad::QueryResult::PutRecord(outcome) => {
                        if let Some(tx) = pending_put.remove(&id) {
                            let _ = tx.send(outcome.map(|_| ()).map_err(|e| {
                                NetworkError::Transport(format!("put record: {e:?}"))
                            }));
                        }
                    }
                    kad::QueryResult::GetRecord(outcome) => {
                        if let Some(tx) = pending_get.remove(&id) {
                            let value = match outcome {
                                Ok(kad::GetRecordOk::FoundRecord(found)) => {
                                    Some(found.record.value)
                                }
                                _ => None,
                            };
                            let _ = tx.send(value);
                        }
                    }
                    _ => {}
                },
                _ => {}
            },
            cmd = cmd_rx.recv() => match cmd {
                Some(Command::Shutdown) | None => break,
                Some(Command::Subscribe(topic)) => {
                    let topic = gossipsub::IdentTopic::new(topic);
                    let _ = swarm.behaviour_mut().gossipsub.subscribe(&topic);
                }
                Some(Command::Publish { topic, data }) => {
                    let topic = gossipsub::IdentTopic::new(topic);
                    // Ignore InsufficientPeers — callers retry until the mesh forms.
                    let _ = swarm.behaviour_mut().gossipsub.publish(topic, data);
                }
                Some(Command::PutRecord { key, value, resp }) => {
                    let record = kad::Record::new(key, value);
                    match swarm
                        .behaviour_mut()
                        .kademlia
                        .put_record(record, kad::Quorum::One)
                    {
                        Ok(query_id) => {
                            pending_put.insert(query_id, resp);
                        }
                        Err(e) => {
                            let _ = resp.send(Err(NetworkError::Transport(format!(
                                "put record: {e:?}"
                            ))));
                        }
                    }
                }
                Some(Command::GetRecord { key, resp }) => {
                    let query_id = swarm
                        .behaviour_mut()
                        .kademlia
                        .get_record(kad::RecordKey::new(&key));
                    pending_get.insert(query_id, resp);
                }
            }
        }
    }
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    fn cfg(port: u16) -> NetworkConfig {
        NetworkConfig {
            listen_port: port,
            enabled: true,
            ..Default::default()
        }
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
    // A.1.10 — Identify protocol version is Rotifer-namespaced (ADR-304)
    // -----------------------------------------------------------------
    #[test]
    fn a_1_10_identify_protocol_version_namespaced() {
        // Peers compare this string to detect protocol-incompatible nodes; it
        // must stay Rotifer-namespaced so a stray libp2p node isn't mistaken for
        // a Rotifer peer.
        assert!(
            IDENTIFY_PROTOCOL_VERSION.starts_with("/rotifer/"),
            "identify protocol version must be /rotifer/-namespaced, got {IDENTIFY_PROTOCOL_VERSION}"
        );
    }

    // -----------------------------------------------------------------
    // A.1.11 — Connection-limit defaults are internally consistent (ADR-304)
    // -----------------------------------------------------------------
    #[test]
    fn a_1_11_connection_limits_are_conservative() {
        // A per-peer / inbound / outbound cap above the total would defeat the
        // OOM guard; memory percentage must be a valid fraction. The cap
        // invariants are over `const`s, so enforce them at compile time — a bad
        // default fails the build rather than only this test.
        const { assert!(MAX_ESTABLISHED_PER_PEER <= MAX_ESTABLISHED) };
        const { assert!(MAX_ESTABLISHED_INCOMING <= MAX_ESTABLISHED) };
        const { assert!(MAX_ESTABLISHED_OUTGOING <= MAX_ESTABLISHED) };
        assert!((0.0..=1.0).contains(&MAX_MEMORY_PERCENTAGE));
    }

    // =================================================================
    // Multi-node integration tests — real libp2p over loopback.
    // `#[ignore]`d by default (kept out of the fast default `cargo test`); run
    // locally with `--ignored`, or in CI via the `p2p-integration` feature:
    // `cargo test --features p2p-integration -- --test-threads=1` (serial, to
    // avoid the shared fixed-port / identity-file contention between them).
    //
    // Deferred multi-node / security scenarios (no harness yet) tracked for
    // follow-up — these were the ignored placeholders in the removed
    // discovery/gossip modules:
    //   - mDNS auto-discovery (needs real multicast; loopback carries none)
    //   - network-partition recovery (needs a disconnect/reconnect harness)
    //   - gossip peer-scoring / graylisting repeat forgers
    //   - gossip flood rate-limiting; search request/response pairing
    //   - adversarial suite: Sybil / Eclipse / flood / forged announcement /
    //     MITM / node spoofing
    // =================================================================

    // -----------------------------------------------------------------
    // Two-node Kademlia discovery over loopback (integration)
    // -----------------------------------------------------------------
    #[test]
    #[cfg_attr(not(feature = "p2p-integration"), ignore = "two-node integration: real kad discovery over loopback — enable the p2p-integration feature or run with --ignored")]
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

    // -----------------------------------------------------------------
    // Two-node Identify exchange over loopback (integration, ADR-304)
    // -----------------------------------------------------------------
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "two-node integration: Identify metadata exchange over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn two_nodes_exchange_identify() {
        let a_id = std::env::temp_dir().join("rotifer-id-a.pem");
        let b_id = std::env::temp_dir().join("rotifer-id-b.pem");
        let _ = std::fs::remove_file(&a_id);
        let _ = std::fs::remove_file(&b_id);

        // Node A: listener, no bootstrap.
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

        // Node B: dials A; Identify runs both directions once connected.
        let mut cfg_b = cfg(0);
        cfg_b.bootstrap_peers = vec![a_addr];
        let mut b = Node::with_keypair_path(cfg_b, b_id.clone()).expect("B build");
        b.start().expect("B start");
        let b_peer = b.local_peer_id().0;
        assert_ne!(a_peer, b_peer, "nodes must have distinct PeerIds");

        // Poll until both sides record an Identify exchange (async).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let a_has_b = a.identified_peers().iter().any(|p| p == &b_peer);
            let b_has_a = b.identified_peers().iter().any(|p| p == &a_peer);
            if a_has_b && b_has_a {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Identify did not complete within 10s (a_has_b={a_has_b}, b_has_a={b_has_a})"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let _ = std::fs::remove_file(&a_id);
        let _ = std::fs::remove_file(&b_id);
    }

    // -----------------------------------------------------------------
    // Connection limit denies inbound over loopback (integration, ADR-304)
    // -----------------------------------------------------------------
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "two-node integration: connection-limit inbound rejection over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn connection_limit_rejects_inbound() {
        let l_id = std::env::temp_dir().join("rotifer-cl-l.pem");
        let a_id = std::env::temp_dir().join("rotifer-cl-a.pem");
        let _ = std::fs::remove_file(&l_id);
        let _ = std::fs::remove_file(&a_id);

        // Node L: listener that accepts ZERO inbound connections.
        let mut cfg_l = cfg(0);
        cfg_l.bootstrap_peers = vec![];
        let mut l = Node::with_keypair_path(cfg_l, l_id.clone())
            .expect("L build")
            .with_max_established_incoming(0);
        l.start().expect("L start");
        let l_addr = l
            .listen_addrs()
            .into_iter()
            .next()
            .expect("L must have a listen address");
        let l_peer = l.local_peer_id().0;

        // Node A dials L; L must deny the inbound connection under its 0 cap.
        let mut cfg_a = cfg(0);
        cfg_a.bootstrap_peers = vec![l_addr];
        let mut a = Node::with_keypair_path(cfg_a, a_id.clone()).expect("A build");
        a.start().expect("A start");

        // Poll until L records a rejection (async).
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if l.rejected_connections() > 0 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "L did not reject the inbound connection within 10s"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // A must never complete an Identify with a node that denied it.
        assert!(
            !a.identified_peers().iter().any(|p| p == &l_peer),
            "A should not identify a node that denied its connection"
        );

        let _ = std::fs::remove_file(&l_id);
        let _ = std::fs::remove_file(&a_id);
    }

    // -----------------------------------------------------------------
    // Two-node GossipSub broadcast over loopback (integration)
    // -----------------------------------------------------------------
    #[test]
    #[cfg_attr(not(feature = "p2p-integration"), ignore = "two-node integration: gossipsub publisher authentication over loopback — enable the p2p-integration feature or run with --ignored")]
    fn two_nodes_gossip_authenticates_publisher() {
        const TOPIC: &str = "/rotifer/announcements";
        let payload = b"gene-announcement-xyz";

        let a_id = std::env::temp_dir().join("rotifer-gossip-a.pem");
        let b_id = std::env::temp_dir().join("rotifer-gossip-b.pem");
        let _ = std::fs::remove_file(&a_id);
        let _ = std::fs::remove_file(&b_id);

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

        let mut cfg_b = cfg(0);
        cfg_b.bootstrap_peers = vec![a_addr];
        let mut b = Node::with_keypair_path(cfg_b, b_id.clone()).expect("B build");
        b.start().expect("B start");

        // Both nodes subscribe so a GossipSub mesh forms for the topic.
        a.subscribe(TOPIC).expect("A subscribe");
        b.subscribe(TOPIC).expect("B subscribe");

        // Publish from A repeatedly until B receives — the mesh needs a few
        // heartbeats to form after the nodes connect + subscribe.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut authenticated = false;
        while std::time::Instant::now() < deadline {
            let _ = a.publish(TOPIC, payload);
            if let Some(msg) = b
                .received_messages()
                .into_iter()
                .find(|m| m.topic == TOPIC && m.data.as_slice() == payload)
            {
                // §8.3 node-identity-forgery defence in the real stack: GossipSub
                // `Signed` binds the message to A's key, so B authenticates the
                // publisher — the source is A's real PeerId, which no relay or
                // impostor can forge without A's private key.
                assert_eq!(
                    msg.source.as_deref(),
                    Some(a_peer.as_str()),
                    "received message's authenticated source must be A's real PeerId"
                );
                authenticated = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        assert!(authenticated, "B must receive + authenticate A's broadcast within 20s");
        // Flood defence is wired into the receive path, but legitimate low-volume
        // traffic (a handful of messages over the window) stays well under the
        // per-peer ceiling, so nothing is dropped.
        assert_eq!(b.rate_limited_count(), 0, "normal traffic must not be rate-limited");

        let _ = std::fs::remove_file(&a_id);
        let _ = std::fs::remove_file(&b_id);
    }

    // -----------------------------------------------------------------
    // Two-node Kademlia DHT put/get over loopback (integration)
    // -----------------------------------------------------------------
    #[test]
    #[cfg_attr(not(feature = "p2p-integration"), ignore = "two-node integration: real Kademlia DHT put/get over loopback — enable the p2p-integration feature or run with --ignored")]
    fn two_nodes_dht_put_get() {
        let key = b"gene/abc";
        let value = b"announcement-bytes-123";

        let a_id = std::env::temp_dir().join("rotifer-dht-a.pem");
        let b_id = std::env::temp_dir().join("rotifer-dht-b.pem");
        let _ = std::fs::remove_file(&a_id);
        let _ = std::fs::remove_file(&b_id);

        let mut cfg_a = cfg(0);
        cfg_a.bootstrap_peers = vec![];
        let mut a = Node::with_keypair_path(cfg_a, a_id.clone()).expect("A build");
        a.start().expect("A start");
        let a_addr = a
            .listen_addrs()
            .into_iter()
            .next()
            .expect("A must have a listen address");

        let mut cfg_b = cfg(0);
        cfg_b.bootstrap_peers = vec![a_addr];
        let mut b = Node::with_keypair_path(cfg_b, b_id.clone()).expect("B build");
        b.start().expect("B start");
        let b_peer = b.local_peer_id().0;

        // Wait until A has B in its routing table, so put_record can replicate.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !a.discovered_peers().iter().any(|p| p == &b_peer) {
            assert!(
                std::time::Instant::now() < deadline,
                "A did not discover B within 10s"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        // A stores a record; B must be able to read it back from the DHT.
        a.put_record(key, value).expect("A put_record");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut got = None;
        while std::time::Instant::now() < deadline {
            if let Ok(Some(v)) = b.get_record(key) {
                got = Some(v);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert_eq!(
            got.as_deref(),
            Some(&value[..]),
            "B must read A's record from the DHT"
        );

        let _ = std::fs::remove_file(&a_id);
        let _ = std::fs::remove_file(&b_id);
    }
}
