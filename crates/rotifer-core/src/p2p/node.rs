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
use libp2p::autonat;
use libp2p::connection_limits;
use libp2p::dcutr;
use libp2p::gossipsub;
use libp2p::identify;
use libp2p::memory_connection_limits;
use libp2p::identity::Keypair;
use libp2p::kad::{self, store::MemoryStore};
use libp2p::mdns;
use libp2p::multiaddr::Protocol;
use libp2p::relay;
use libp2p::swarm::behaviour::toggle::Toggle;
use libp2p::swarm::dial_opts::{DialOpts, PeerCondition};
use libp2p::swarm::{ConnectionDenied, DialError, ListenError, NetworkBehaviour, SwarmEvent};
use libp2p::{Multiaddr, PeerId as Libp2pPeerId, Swarm};
use tokio::sync::{mpsc, oneshot};

use super::heartbeat::{self, HEARTBEATS_TOPIC, WireNodeHeartbeat};
use super::peerstore;
use super::por::{self, Decision, FetchJob, Fetched, HeartbeatDesk, HeartbeatStats, KeyStore, PeerAttestation};
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

/// How often remembered peers are flushed to disk while running. A clean stop
/// also persists them; this only bounds the loss when a daemon is killed.
const PEER_FLUSH_INTERVAL: Duration = Duration::from_secs(60);

/// Shortest gap between two heartbeats from this node. Besides the timer, a
/// node also sends one when a peer joins the heartbeats topic, so that it is
/// known without waiting a full interval, and restarts the timer; keeping any
/// two heartbeats this far apart stays under the receivers' 2-per-minute rate
/// (P2P RFC §8.6) with room for network jitter.
const MIN_HEARTBEAT_GAP: Duration = Duration::from_secs(35);

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
const IDENTIFY_PROTOCOL_VERSION: &str = "/rotifer/p2p/1";

/// Composite network behaviour driven by the node's Swarm. Kademlia provides
/// peer discovery + a distributed record store; GossipSub provides
/// publish/subscribe message broadcast; Identify exchanges peer metadata
/// (protocols, listen + observed addrs) on connect.
/// Connection limits (ADR-304 D2), down from 256 in / 256 out / 512 total to
/// P2P RFC §4.1.4. They keep a node from being connected into OOM and pair with
/// the message-layer rate limit (§8.6). The inbound, outbound and pending caps
/// are `NetworkConfig` fields and these are their defaults (50 / 50 / 20); the
/// total is inbound + outbound (100 by default); the per-peer cap is fixed.
const MAX_ESTABLISHED_PER_PEER: u32 = 4;
pub(super) const MAX_ESTABLISHED_INCOMING: u32 = 50;
pub(super) const MAX_ESTABLISHED_OUTGOING: u32 = 50;
const MAX_ESTABLISHED: u32 = MAX_ESTABLISHED_INCOMING + MAX_ESTABLISHED_OUTGOING;
pub(super) const MAX_PENDING: u32 = 20;
// One peer can never hold the whole default budget.
const _: () = assert!(MAX_ESTABLISHED_PER_PEER < MAX_ESTABLISHED);
/// Deny new connections once process memory exceeds this fraction of system RAM.
const MAX_MEMORY_PERCENTAGE: f64 = 0.9;

/// mDNS query interval and record TTL (P2P RFC §5.1.1). libp2p's defaults are
/// 5 min / 6 min; the RFC's shorter values let a LAN peer that joins late be
/// found within one interval and a departed one be forgotten within two.
const MDNS_QUERY_INTERVAL: Duration = Duration::from_secs(30);
const MDNS_TTL: Duration = Duration::from_secs(120);

/// Upper bound on peers tracked as mDNS-discovered. mDNS is unauthenticated
/// (RFC §5.1.2): anyone on the LAN can answer with as many PeerIds as it likes,
/// so the bookkeeping is capped. Dials are separately capped by the
/// pending-outgoing connection limit.
const MAX_MDNS_PEERS: usize = 256;

/// Upper bound on buffered inbound GossipSub messages. Each sender is
/// rate-limited, but many identities together are not (Sybil), so the buffer
/// itself must be bounded or it grows without limit; the oldest drop first.
const MAX_RECEIVED_MESSAGES: usize = 1024;

/// How long GossipSub remembers a message id to drop re-deliveries. It must
/// span the whole anti-replay window (±`MAX_TIMESTAMP_SKEW_SECS`): the
/// timestamp check rejects replays after the window, this cache rejects them
/// inside it. libp2p's 60s default left a 1–5 minute replay gap.
const GOSSIP_DUPLICATE_CACHE: Duration =
    Duration::from_secs(2 * super::messages::MAX_TIMESTAMP_SKEW_SECS);

fn gossipsub_config() -> gossipsub::Config {
    gossipsub::ConfigBuilder::default()
        .duplicate_cache_time(GOSSIP_DUPLICATE_CACHE)
        // Application validation before forwarding: every message is held
        // until the event loop reports Accept / Reject / Ignore, so an
        // invalid announcement is never relayed to other peers.
        .validate_messages()
        .build()
        .expect("gossipsub config is valid")
}

/// Peer scoring (ADR-300 contract v2, CEO 〔T-140〕 E7): no topic scores
/// (P1–P4 off, so A4's Ignore / Reject semantics are unchanged), the
/// application score at weight [`por::APP_SPECIFIC_WEIGHT`], everything else
/// and the thresholds (gossip −10, publish −50, graylist −80) at libp2p's
/// defaults. One certain forgery (−100) is below the graylist threshold.
fn peer_score_params() -> (gossipsub::PeerScoreParams, gossipsub::PeerScoreThresholds) {
    let params = gossipsub::PeerScoreParams {
        app_specific_weight: por::APP_SPECIFIC_WEIGHT,
        ..Default::default()
    };
    (params, gossipsub::PeerScoreThresholds::default())
}

/// Wall-clock Unix milliseconds (announcement freshness is wall-clock based).
fn wall_clock_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Append `msg`, evicting the oldest entries beyond `cap`.
fn push_bounded(buf: &mut Vec<ReceivedMessage>, msg: ReceivedMessage, cap: usize) {
    buf.push(msg);
    if buf.len() > cap {
        let excess = buf.len() - cap;
        buf.drain(..excess);
    }
}

#[derive(NetworkBehaviour)]
struct NodeBehaviour {
    // The limits come first. libp2p offers a new connection to each behaviour
    // in field order, and some (request-response, under AutoNAT) record it as
    // soon as they are asked; a limit listed after them would refuse it too
    // late and leave a stale entry that panics when the peer's other
    // connection closes.
    /// Caps total / per-peer / pending connections so a node can't be connected
    /// into resource exhaustion — the scale-up guardrail (ADR-304 D2).
    connection_limits: connection_limits::Behaviour,
    /// Denies new connections under memory pressure (process RSS vs system RAM).
    memory_connection_limits: memory_connection_limits::Behaviour,
    kademlia: kad::Behaviour<MemoryStore>,
    gossipsub: gossipsub::Behaviour,
    identify: identify::Behaviour,
    /// NAT traversal (ADR-304 D1): AutoNAT asks peers to dial it back to learn
    /// whether it is reachable (and answers their probes); the relay client
    /// holds reservations on configured relays so peers can reach it through
    /// them; DCUtR then tries to replace a relayed connection with a direct one.
    autonat: autonat::Behaviour,
    relay_client: relay::client::Behaviour,
    dcutr: dcutr::Behaviour,
    /// LAN discovery (P2P RFC §5.1). Disabled unless the node listens on a
    /// non-loopback interface — see [`mdns_should_run`].
    mdns: Toggle<mdns::tokio::Behaviour>,
}

/// Whether mDNS should run for a node listening on `host`.
///
/// libp2p-mdns rewrites every advertised address to the source IP of the
/// mDNS packet that carried it, so a node bound to loopback would be announced
/// at its LAN address, where nothing listens. Running mDNS there would only
/// broadcast the node's PeerId to the LAN (RFC §8.7) without making it
/// reachable — so a loopback-only node (the default) never runs it.
fn mdns_should_run(enabled: bool, host: &str) -> bool {
    enabled
        && host
            .parse::<std::net::IpAddr>()
            .map(|ip| !ip.is_loopback())
            .unwrap_or(false)
}

/// mDNS settings (P2P RFC §5.1.1). The service name is libp2p's fixed
/// `_p2p._udp.local`, not the RFC's `_rotifer._udp.local`: libp2p-mdns does not
/// make it configurable. Non-Rotifer libp2p nodes on the LAN therefore answer
/// too; they are dropped after Identify (see the `Identify` arm of the event
/// loop), so they never enter the routing table or the peer store.
fn mdns_config() -> mdns::Config {
    mdns::Config {
        ttl: MDNS_TTL,
        query_interval: MDNS_QUERY_INTERVAL,
        enable_ipv6: false,
    }
}

/// Peers the node has discovered (present in the Kademlia routing table),
/// shared between the synchronous API and the event loop.
type DiscoveredPeers = Arc<Mutex<HashSet<String>>>;

/// Peers currently announced over mDNS, each with its unexpired addresses.
type MdnsPeers = Arc<Mutex<HashMap<String, HashSet<String>>>>;

/// A GossipSub message received by the node, carrying its authenticated
/// publisher. With `MessageAuthenticity::Signed`, `source` is bound to the
/// signer's key and cannot be forged (the §8.3 node-identity-forgery defence).
#[derive(Debug, Clone)]
pub struct ReceivedMessage {
    pub topic: String,
    pub data: Vec<u8>,
    pub source: Option<String>,
    /// Wall-clock arrival time (Unix ms), the time validation ran against.
    pub received_at_ms: u64,
}

/// GossipSub messages received by the node, shared between the synchronous API
/// and the event loop.
type ReceivedMessages = Arc<Mutex<Vec<ReceivedMessage>>>;

/// Connections this node refused under its own limits (ADR-304 D2, P2P RFC
/// §4.1.4), by cause. Transport failures are not refusals and are not counted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ConnectionDenials {
    /// Inbound connections over a cap (inbound, pending or per peer).
    pub inbound_limit: u64,
    /// Outbound dials over a cap (outbound, pending or per peer).
    pub outbound_limit: u64,
    /// Connections in either direction refused under memory pressure.
    pub memory: u64,
}

impl ConnectionDenials {
    /// All refusals, whatever the cause.
    pub fn total(&self) -> u64 {
        self.inbound_limit + self.outbound_limit + self.memory
    }
}

/// Whether peers can dial this node directly, as AutoNAT last judged it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Reachability {
    /// Not probed yet, or no peer could probe it.
    #[default]
    Unknown,
    /// Peers dialled it back on one of its addresses.
    Public,
    /// Peers could not dial it back: it is behind NAT or a firewall.
    Private,
}

/// NAT traversal state (ADR-304 D1): AutoNAT's verdict, relay reservations,
/// and how relayed connections and hole punches went.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NatTraversal {
    pub reachability: Reachability,
    /// Relays (PeerIds) currently holding a reservation for this node.
    pub relay_reservations: Vec<String>,
    /// Connections that reached this node through a relay circuit.
    pub relayed_inbound: u64,
    /// Relayed connections replaced by a direct one through hole punching (DCUtR).
    pub hole_punch_succeeded: u64,
    /// Hole-punch attempts that failed; the relayed connection stays in use.
    pub hole_punch_failed: u64,
}

/// Shared state handles the event loop updates and the synchronous API reads.
struct NodeShared {
    listen_addrs: Arc<Mutex<Vec<String>>>,
    discovered: DiscoveredPeers,
    /// Peers we have completed an Identify exchange with (ADR-304).
    identified: DiscoveredPeers,
    /// Dialable addresses of peers met this session, persisted on shutdown.
    met_peers: Arc<Mutex<Vec<String>>>,
    received: ReceivedMessages,
    rate_limited: Arc<Mutex<u64>>,
    /// Count of inbound messages rejected by wire-format validation.
    invalid: Arc<Mutex<u64>>,
    /// Count of inbound messages ignored for arriving on a topic with no
    /// registered validator.
    unregistered: Arc<Mutex<u64>>,
    /// Connections refused by this node's own limits (ADR-304 D2).
    denials: Arc<Mutex<ConnectionDenials>>,
    /// NAT traversal state (ADR-304 D1).
    nat: Arc<Mutex<NatTraversal>>,
    /// Peers currently announced over mDNS (RFC §5.1).
    mdns_peers: MdnsPeers,
    /// Whether mDNS actually started (false when disabled, loopback-only, or
    /// the mDNS socket could not be created).
    mdns_active: Arc<Mutex<bool>>,
    /// Count of peers disconnected because Identify showed they are not
    /// Rotifer nodes.
    foreign: Arc<Mutex<u64>>,
    /// Token this node's heartbeats carry.
    attestation: Arc<Mutex<Option<String>>>,
    /// Other nodes' heartbeats and attestations.
    heartbeats: Arc<Mutex<HeartbeatDesk>>,
    /// Connected peers' GossipSub scores, as of the last recompute.
    scores: Arc<Mutex<HashMap<String, f64>>>,
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
    /// Where remembered peers are cached across restarts (see `peerstore`).
    pub peerstore_path: PathBuf,
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
    /// Dialable addresses of peers met this session. Written back to
    /// `peerstore_path` on shutdown so the next start needs no bootstrap.
    met_peers: Arc<Mutex<Vec<String>>>,
    /// GossipSub messages received so far, appended by the event loop.
    received: ReceivedMessages,
    /// Count of inbound messages dropped by the per-peer rate limiter (§8.6).
    rate_limited: Arc<Mutex<u64>>,
    /// Count of inbound messages rejected by wire-format validation.
    invalid: Arc<Mutex<u64>>,
    /// Count of inbound messages ignored for arriving on a topic with no
    /// registered validator.
    unregistered: Arc<Mutex<u64>>,
    /// Connections refused by this node's own limits (ADR-304 D2).
    denials: Arc<Mutex<ConnectionDenials>>,
    /// NAT traversal state (ADR-304 D1).
    nat: Arc<Mutex<NatTraversal>>,
    /// Peers currently announced over mDNS (RFC §5.1).
    mdns_peers: MdnsPeers,
    /// Whether mDNS is running (set on `start`).
    mdns_active: Arc<Mutex<bool>>,
    /// Count of peers dropped after Identify showed a non-Rotifer protocol.
    foreign: Arc<Mutex<u64>>,
    /// Proof-of-registration token this node's heartbeats carry (`None` =
    /// anonymous). See [`Node::set_attestation`].
    attestation: Arc<Mutex<Option<String>>>,
    /// Other nodes' heartbeats: trust anchors, cached issuer keys, and each
    /// source's attestation (ADR-300). Rebuilt from the config on `start`.
    heartbeats: Arc<Mutex<HeartbeatDesk>>,
    /// Connected peers' GossipSub scores, as of the last recompute.
    scores: Arc<Mutex<HashMap<String, f64>>>,
    /// How often this node publishes its heartbeat.
    heartbeat_interval: Duration,
    /// How often peer scores are recomputed besides after each heartbeat.
    score_refresh_interval: Duration,
    /// Let AutoNAT probe and be probed on loopback / private addresses. Off in
    /// production (AutoNAT only trusts peers seen at global IPs); tests turn it
    /// on to check reachability on one machine.
    autonat_on_loopback: bool,
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

    /// Build a node with explicit identity and peer-store locations. Tests use
    /// this to keep per-node state isolated.
    pub fn with_paths(
        config: NetworkConfig,
        keypair_path: PathBuf,
        peerstore_path: PathBuf,
    ) -> Result<Self, NetworkError> {
        let mut node = Self::with_keypair_path(config, keypair_path)?;
        node.peerstore_path = peerstore_path;
        Ok(node)
    }

    /// Build a node with an explicit identity-file location.
    ///
    /// First run generates a fresh Ed25519 keypair and writes it (mode 0600);
    /// later runs reuse it, so the derived `PeerId` is stable.
    pub fn with_keypair_path(config: NetworkConfig, path: PathBuf) -> Result<Self, NetworkError> {
        let keypair = load_or_generate_keypair(&path)?;
        let peer_id = keypair.public().to_peer_id();
        // Keep the peer store beside the identity: callers that relocate the
        // identity (tests, isolated daemons) get an isolated peer store too,
        // without having to remember a second path.
        let peerstore_path = match path.parent() {
            Some(dir) if !dir.as_os_str().is_empty() => dir.join("peers.json"),
            _ => peerstore::default_peerstore_path(),
        };
        Ok(Self {
            config,
            keypair_path: path,
            peerstore_path,
            listening: false,
            keypair,
            peer_id,
            listen_addrs: Arc::new(Mutex::new(Vec::new())),
            discovered: Arc::new(Mutex::new(HashSet::new())),
            identified: Arc::new(Mutex::new(HashSet::new())),
            met_peers: Arc::new(Mutex::new(Vec::new())),
            received: Arc::new(Mutex::new(Vec::new())),
            rate_limited: Arc::new(Mutex::new(0)),
            invalid: Arc::new(Mutex::new(0)),
            unregistered: Arc::new(Mutex::new(0)),
            denials: Arc::new(Mutex::new(ConnectionDenials::default())),
            nat: Arc::new(Mutex::new(NatTraversal::default())),
            mdns_peers: Arc::new(Mutex::new(HashMap::new())),
            mdns_active: Arc::new(Mutex::new(false)),
            foreign: Arc::new(Mutex::new(0)),
            attestation: Arc::new(Mutex::new(None)),
            heartbeats: Arc::new(Mutex::new(HeartbeatDesk::new(Vec::new(), KeyStore::default()))),
            scores: Arc::new(Mutex::new(HashMap::new())),
            heartbeat_interval: Duration::from_secs(heartbeat::HEARTBEAT_INTERVAL_SECS),
            score_refresh_interval: por::SCORE_REFRESH_INTERVAL,
            autonat_on_loopback: false,
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

    /// Set `NetworkConfig::max_inbound_connections` (ADR-304 D2; 0 = dial-out
    /// only). Must be called before [`Node::start`].
    pub fn with_max_established_incoming(mut self, max: u32) -> Self {
        self.config.max_inbound_connections = max;
        self
    }

    /// Let AutoNAT work on loopback and private addresses (tests only; see
    /// the field). Must be called before [`Node::start`].
    #[cfg(test)]
    fn with_autonat_on_loopback(mut self) -> Self {
        self.autonat_on_loopback = true;
        self
    }

    /// Connections refused so far by this node's own limits, in either
    /// direction (ADR-304 D2). Non-zero means the node shed load.
    pub fn rejected_connections(&self) -> u64 {
        self.connection_denials().total()
    }

    /// Connections refused so far by this node's own limits, by cause.
    pub fn connection_denials(&self) -> ConnectionDenials {
        self.denials.lock().map(|d| *d).unwrap_or_default()
    }

    /// Whether peers can dial this node directly, as AutoNAT last judged it.
    pub fn nat_status(&self) -> Reachability {
        self.nat_traversal().reachability
    }

    /// NAT traversal state: AutoNAT's verdict, relay reservations, relayed
    /// connections and hole punches (ADR-304 D1).
    pub fn nat_traversal(&self) -> NatTraversal {
        self.nat.lock().map(|n| n.clone()).unwrap_or_default()
    }

    /// Whether mDNS is running (`NetworkConfig::mdns_enabled` asks for it).
    /// False before `start`, when disabled, when the
    /// node listens on loopback only, or if the mDNS socket could not be opened.
    pub fn mdns_active(&self) -> bool {
        self.mdns_active.lock().map(|a| *a).unwrap_or(false)
    }

    /// Peers currently announced on the LAN over mDNS (`PeerId` strings).
    /// mDNS is unauthenticated: an entry only means something answered with
    /// that PeerId; [`Node::identified_peers`] is the authenticated view.
    pub fn mdns_peers(&self) -> Vec<String> {
        self.mdns_peers
            .lock()
            .map(|peers| peers.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// Count of peers disconnected because Identify showed they are not
    /// Rotifer nodes (protocol version other than `/rotifer/p2p/1`).
    pub fn foreign_peers_dropped(&self) -> u64 {
        self.foreign.lock().map(|n| *n).unwrap_or(0)
    }

    /// Carry this proof-of-registration token in this node's heartbeats from
    /// now on; `None` makes them anonymous (a full participant, no bonus).
    /// Refused unless it is a PoR token for this node's own PeerId: other
    /// nodes would reject the heartbeat as a forgery and penalise this node.
    /// The signature and expiry are left to the receivers, who hold the
    /// issuer keys.
    pub fn set_attestation(&self, token: Option<String>) -> Result<(), NetworkError> {
        if let Some(t) = &token {
            let parsed = por::parse_token(t.as_bytes()).map_err(|why| NetworkError::Config(format!("attestation: {why}")))?;
            if parsed.claims.peer_id != self.peer_id.to_string() {
                return Err(NetworkError::Config("attestation is for another PeerId".into()));
            }
        }
        if let Ok(mut a) = self.attestation.lock() {
            *a = token;
        }
        Ok(())
    }

    /// What `peer`'s newest heartbeat said about its registration, or `None`
    /// if no heartbeat from it has been accepted.
    pub fn peer_attestation(&self, peer: &str) -> Option<PeerAttestation> {
        self.heartbeats.lock().ok()?.peer(peer)
    }

    /// Heartbeat counters: applied, rate-limited, undecidable, malformed,
    /// forged.
    pub fn heartbeat_stats(&self) -> HeartbeatStats {
        self.heartbeats.lock().map(|d| d.stats()).unwrap_or_default()
    }

    /// A connected peer's GossipSub score as of the last recompute (after
    /// each heartbeat decision and every minute), or `None` if it was not
    /// connected then. Below −80 the peer is graylisted.
    pub fn peer_score(&self, peer: &str) -> Option<f64> {
        self.scores.lock().ok()?.get(peer).copied()
    }

    /// Publish heartbeats this often instead of every five minutes (tests).
    #[cfg(test)]
    fn with_heartbeat_interval(mut self, interval: Duration) -> Self {
        self.heartbeat_interval = interval;
        self
    }

    /// Recompute peer scores this often instead of every minute (tests).
    #[cfg(test)]
    pub(crate) fn with_score_refresh_interval(mut self, interval: Duration) -> Self {
        self.score_refresh_interval = interval;
        self
    }

    /// Subscribe to a GossipSub topic. Requires the node to be started.
    pub fn subscribe(&self, topic: &str) -> Result<(), NetworkError> {
        self.send_command(Command::Subscribe(topic.to_string()))
    }

    /// Publish `data` to a GossipSub topic. Fire-and-forget: delivery needs a
    /// formed mesh, so callers broadcasting to fresh peers should retry until a
    /// subscriber receives it.
    ///
    /// Only topics with a registered validator are allowed: other nodes ignore
    /// everything else, and the pre-freeze `/rotifer/announcements` is never
    /// written (ADR-340 D6). Refused with `UnregisteredTopic`.
    pub fn publish(&self, topic: &str, data: &[u8]) -> Result<(), NetworkError> {
        use super::messages::topic_validator;
        if topic_validator(topic).is_none() {
            return Err(NetworkError::UnregisteredTopic(topic.to_string()));
        }
        self.send_command(Command::Publish {
            topic: topic.to_string(),
            data: data.to_vec(),
        })
    }

    /// GossipSub messages received so far, each with its authenticated publisher.
    pub fn received_messages(&self) -> Vec<ReceivedMessage> {
        self.received.lock().map(|m| m.clone()).unwrap_or_default()
    }

    /// Gene announcements accepted on the announcements topic, each with its
    /// authenticated publisher. One entry per `(gene_id, publisher)` — the
    /// newest: a content ID can have many publishers, and each one's latest
    /// announcement replaces its earlier ones, never another publisher's.
    pub fn received_announcements(&self) -> Vec<(super::GeneAnnouncement, String)> {
        use super::messages::{ANNOUNCEMENTS_TOPIC, Verdict, validate_gossip};
        // Messages were validated on arrival; re-validate against the time
        // they arrived at so a long-running node keeps showing them.
        let mut latest: Vec<(super::GeneAnnouncement, String)> = Vec::new();
        for m in self.received_messages() {
            let (true, Some(source)) = (m.topic == ANNOUNCEMENTS_TOPIC, m.source) else { continue };
            let Verdict::Accept(ann) = validate_gossip(&m.data, Some(&source), m.received_at_ms) else {
                continue;
            };
            match latest.iter_mut().find(|(a, s)| a.gene_id == ann.gene_id && *s == source) {
                Some(slot) if slot.0.timestamp_ms <= ann.timestamp_ms => slot.0 = ann,
                Some(_) => {}
                None => latest.push((ann, source)),
            }
        }
        latest
    }

    /// Number of inbound messages rejected by wire-format validation.
    pub fn invalid_message_count(&self) -> u64 {
        self.invalid.lock().map(|n| *n).unwrap_or(0)
    }

    /// Number of inbound messages dropped by the per-peer rate limiter (§8.6).
    pub fn rate_limited_count(&self) -> u64 {
        self.rate_limited.lock().map(|n| *n).unwrap_or(0)
    }

    /// Number of inbound messages ignored because their topic has no
    /// registered validator (see `messages::TOPIC_VALIDATORS`).
    pub fn unregistered_topic_count(&self) -> u64 {
        self.unregistered.lock().map(|n| *n).unwrap_or(0)
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
        // Trust anchors are configured on purpose: a bad one fails `start`
        // rather than silently trusting nobody.
        por::check_trust_anchors(&self.config.trust_anchors).map_err(NetworkError::Config)?;

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

        let jwks_cache = self.peerstore_path.with_file_name("jwks-cache.json");
        if let Ok(mut desk) = self.heartbeats.lock() {
            let anchors = self.config.trust_anchors.clone();
            let store = KeyStore::load(Some(jwks_cache), &anchors);
            *desk = HeartbeatDesk::new(anchors, store);
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
        let limits = self.swarm_options()?;
        let shared = NodeShared {
            listen_addrs: Arc::clone(&self.listen_addrs),
            discovered: Arc::clone(&self.discovered),
            identified: Arc::clone(&self.identified),
            met_peers: Arc::clone(&self.met_peers),
            received: Arc::clone(&self.received),
            rate_limited: Arc::clone(&self.rate_limited),
            invalid: Arc::clone(&self.invalid),
            unregistered: Arc::clone(&self.unregistered),
            denials: Arc::clone(&self.denials),
            nat: Arc::clone(&self.nat),
            mdns_peers: Arc::clone(&self.mdns_peers),
            mdns_active: Arc::clone(&self.mdns_active),
            foreign: Arc::clone(&self.foreign),
            attestation: Arc::clone(&self.attestation),
            heartbeats: Arc::clone(&self.heartbeats),
            scores: Arc::clone(&self.scores),
        };
        let (ready_tx, ready_rx) = oneshot::channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        let peerstore_path = self.peerstore_path.clone();
        let task = runtime.spawn(run_event_loop(
            keypair, host, port, bootstrap, peerstore_path, limits, shared, ready_tx, cmd_rx,
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
        // Persist remembered peers from this thread, before tearing the runtime
        // down. Doing it inside the event loop would be unreliable: shutting the
        // runtime down cancels that task at its next await point, so work queued
        // behind the shutdown command may never run.
        if let Ok(met) = self.met_peers.lock()
            && let Err(e) = persist_peers(&self.peerstore_path, &met)
        {
            tracing::debug!("could not persist peer store: {e}");
        }
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
        if let Ok(mut peers) = self.mdns_peers.lock() {
            peers.clear();
        }
        if let Ok(mut active) = self.mdns_active.lock() {
            *active = false;
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

impl Node {
    /// The Swarm options `start` builds with, read from the config.
    fn swarm_options(&self) -> Result<SwarmOptions, NetworkError> {
        Ok(SwarmOptions {
            max_inbound: self.config.max_inbound_connections,
            max_outbound: self.config.max_outbound_connections,
            max_pending: self.config.max_pending_connections,
            mdns: mdns_should_run(self.config.mdns_enabled, &self.config.listen_host),
            relays: parse_relays(&self.config.relays)?,
            autonat_on_loopback: self.autonat_on_loopback,
            heartbeat_interval: self.heartbeat_interval,
            score_refresh_interval: self.score_refresh_interval,
        })
    }
}

/// Per-start Swarm options decided on the synchronous side.
struct SwarmOptions {
    /// Inbound / outbound / pending connection caps (P2P RFC §4.1.4).
    max_inbound: u32,
    max_outbound: u32,
    max_pending: u32,
    /// Run mDNS (already gated by [`mdns_should_run`]).
    mdns: bool,
    /// Relays to hold a reservation on, each ending in `/p2p/<PeerId>`.
    relays: Vec<(Multiaddr, Libp2pPeerId)>,
    /// See `Node::autonat_on_loopback`.
    autonat_on_loopback: bool,
    /// See `Node::heartbeat_interval`.
    heartbeat_interval: Duration,
    /// See `Node::score_refresh_interval`.
    score_refresh_interval: Duration,
}

/// Parse `NetworkConfig::relays`. A relay is configured on purpose, so a bad
/// entry fails `start` instead of being skipped: the node would otherwise run
/// unreachable behind NAT without saying why.
fn parse_relays(relays: &[String]) -> Result<Vec<(Multiaddr, Libp2pPeerId)>, NetworkError> {
    relays
        .iter()
        .map(|raw| {
            let addr: Multiaddr = raw
                .parse()
                .map_err(|e| NetworkError::Transport(format!("relay address {raw}: {e}")))?;
            match addr.iter().last() {
                Some(Protocol::P2p(peer)) => Ok((addr, peer)),
                _ => Err(NetworkError::Transport(format!(
                    "relay address {raw} must end in /p2p/<relay PeerId>"
                ))),
            }
        })
        .collect()
}

/// AutoNAT (v1) settings. libp2p's defaults, except on loopback for tests,
/// where it must trust local addresses and probe without the boot delay.
fn autonat_config(on_loopback: bool) -> autonat::Config {
    let default = autonat::Config::default();
    if on_loopback {
        autonat::Config {
            only_global_ips: false,
            boot_delay: Duration::from_millis(500),
            retry_interval: Duration::from_secs(1),
            throttle_server_period: Duration::ZERO,
            ..default
        }
    } else {
        default
    }
}

/// Build a libp2p Swarm with TCP + QUIC transports (Noise + Yamux) and a
/// Circuit Relay v2 client transport over the tokio runtime, carrying the
/// node's composite behaviour: Kademlia in server mode, GossipSub, Identify,
/// the NAT traversal set (AutoNAT, relay client, DCUtR; ADR-304 D1), the
/// connection limits and — when requested — mDNS.
fn build_swarm(keypair: Keypair, options: &SwarmOptions) -> Result<Swarm<NodeBehaviour>, NetworkError> {
    let swarm = libp2p::SwarmBuilder::with_existing_identity(keypair)
        .with_tokio()
        .with_tcp(
            libp2p::tcp::Config::default(),
            libp2p::noise::Config::new,
            libp2p::yamux::Config::default,
        )
        .map_err(|e| NetworkError::Transport(format!("tcp transport: {e}")))?
        .with_quic()
        // Relayed connections are encrypted end to end like any other:
        // the relay only forwards Noise ciphertext (P2P RFC §8.2).
        .with_relay_client(libp2p::noise::Config::new, libp2p::yamux::Config::default)
        .map_err(|e| NetworkError::Transport(format!("relay client transport: {e}")))?
        .with_behaviour(|key, relay_client| {
            let peer_id = key.public().to_peer_id();
            let mut kademlia = kad::Behaviour::new(peer_id, MemoryStore::new(peer_id));
            kademlia.set_mode(Some(kad::Mode::Server));
            let mut gossipsub = gossipsub::Behaviour::new(
                gossipsub::MessageAuthenticity::Signed(key.clone()),
                gossipsub_config(),
            )
            .expect("gossipsub config is valid");
            let (params, thresholds) = peer_score_params();
            gossipsub.with_peer_score(params, thresholds).expect("peer score parameters are valid");
            let identify = identify::Behaviour::new(identify::Config::new(
                IDENTIFY_PROTOCOL_VERSION.to_string(),
                key.public(),
            ));
            let limits = connection_limits::ConnectionLimits::default()
                .with_max_established(Some(options.max_inbound.saturating_add(options.max_outbound)))
                .with_max_established_per_peer(Some(MAX_ESTABLISHED_PER_PEER))
                .with_max_pending_incoming(Some(options.max_pending))
                .with_max_pending_outgoing(Some(options.max_pending))
                .with_max_established_incoming(Some(options.max_inbound))
                .with_max_established_outgoing(Some(options.max_outbound));
            let connection_limits = connection_limits::Behaviour::new(limits);
            let memory_connection_limits =
                memory_connection_limits::Behaviour::with_max_percentage(MAX_MEMORY_PERCENTAGE);
            // mDNS is best-effort: if its socket cannot be opened (no
            // multicast-capable interface, sandboxed host) the node still
            // starts and reaches peers through bootstrap and the peer store.
            let mdns = if options.mdns {
                match mdns::tokio::Behaviour::new(mdns_config(), peer_id) {
                    Ok(behaviour) => Some(behaviour),
                    Err(e) => {
                        tracing::warn!("mDNS unavailable, continuing without LAN discovery: {e}");
                        None
                    }
                }
            } else {
                None
            };
            NodeBehaviour {
                connection_limits,
                memory_connection_limits,
                kademlia,
                gossipsub,
                identify,
                autonat: autonat::Behaviour::new(peer_id, autonat_config(options.autonat_on_loopback)),
                relay_client,
                dcutr: dcutr::Behaviour::new(peer_id),
                mdns: Toggle::from(mdns),
            }
        })
        .expect("behaviour construction is infallible")
        .build();
    Ok(swarm)
}

/// Count a connection refused by one of this node's own limits (ADR-304 D2).
fn record_denial(denials: &Mutex<ConnectionDenials>, inbound: bool, cause: &ConnectionDenied) {
    let memory = cause
        .downcast_ref::<memory_connection_limits::MemoryUsageLimitExceeded>()
        .is_some();
    let limit = cause.downcast_ref::<connection_limits::Exceeded>().is_some();
    if !memory && !limit {
        tracing::debug!(inbound, "connection refused: {cause}");
        return;
    }
    if let Ok(mut d) = denials.lock() {
        match (memory, inbound) {
            (true, _) => d.memory += 1,
            (false, true) => d.inbound_limit += 1,
            (false, false) => d.outbound_limit += 1,
        }
    }
    tracing::debug!(inbound, "connection refused by local limit: {cause}");
}

/// AutoNAT's verdict as the node reports it.
fn reachability_of(status: &autonat::NatStatus) -> Reachability {
    match status {
        autonat::NatStatus::Public(_) => Reachability::Public,
        autonat::NatStatus::Private => Reachability::Private,
        autonat::NatStatus::Unknown => Reachability::Unknown,
    }
}

/// The relay's PeerId if `addr` is one of our relay circuit listen addresses
/// (`.../p2p/<relay>/p2p-circuit`).
fn circuit_relay(addr: &Multiaddr) -> Option<String> {
    let mut relay = None;
    for protocol in addr.iter() {
        match protocol {
            Protocol::P2p(peer) => relay = Some(peer.to_string()),
            Protocol::P2pCircuit => return relay,
            _ => {}
        }
    }
    None
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
    peerstore_path: PathBuf,
    options: SwarmOptions,
    shared: NodeShared,
    ready_tx: oneshot::Sender<Result<(), NetworkError>>,
    mut cmd_rx: mpsc::UnboundedReceiver<Command>,
) {
    let NodeShared {
        listen_addrs,
        discovered,
        identified,
        met_peers,
        received,
        rate_limited,
        invalid,
        unregistered,
        denials,
        nat,
        mdns_peers,
        mdns_active,
        foreign,
        attestation,
        heartbeats,
        scores,
    } = shared;
    // Per-peer flood defence (§8.6); lives in the single-threaded event loop.
    let mut security = super::security::Security::new();
    let mut swarm = match build_swarm(keypair, &options) {
        Ok(s) => s,
        Err(e) => {
            let _ = ready_tx.send(Err(e));
            return;
        }
    };
    let mdns_running = swarm.behaviour().mdns.is_enabled();
    if let Ok(mut active) = mdns_active.lock() {
        *active = mdns_running;
    }
    if mdns_running {
        tracing::info!("mDNS LAN discovery on (turn it off on untrusted networks, RFC §5.1.2)");
    }

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

    // Dial configured bootstrap peers plus everyone we met in earlier sessions.
    // Remembered peers are what makes bootstrap infrastructure non-critical: a
    // node that has been online before can re-enter the network on its own, so a
    // bootstrap node being down (or absent entirely, which is the case today)
    // only affects a node's very first run.
    //
    // Best-effort throughout: malformed or unreachable entries are skipped
    // without failing startup.
    let remembered = peerstore::load(&peerstore_path);
    if !remembered.is_empty() {
        tracing::debug!("dialling {} remembered peer(s)", remembered.len());
    }
    for addr in bootstrap.iter().chain(remembered.iter()) {
        if let Ok(ma) = addr.parse::<Multiaddr>() {
            let _ = swarm.dial(ma);
        }
    }

    // Hold a reservation on each configured relay (ADR-304 D1): listening on
    // its circuit address dials the relay and asks it to accept circuits for
    // us. Peers that cannot dial us directly reach us through it.
    for (relay_addr, _) in &options.relays {
        let circuit = relay_addr.clone().with(Protocol::P2pCircuit);
        if let Err(e) = swarm.listen_on(circuit) {
            tracing::warn!("relay {relay_addr}: cannot request a reservation: {e}");
        }
    }
    // A relay must be a Rotifer node: every Rotifer peer dialling through it
    // runs the Identify guard below and would hang up on anything else. Kept
    // to say so when a configured relay fails that check.
    let relay_peers: HashSet<Libp2pPeerId> = options.relays.iter().map(|(_, p)| *p).collect();

    // Dialable addresses of peers met this session, in encounter order, written
    // back to the store on shutdown. Identify is the source: it reports the
    // peer's advertised *listen* addresses, which are reachable again later —
    // unlike a connection's remote address, which for inbound connections is an
    // ephemeral source port that cannot be dialled back.
    if let Ok(mut met) = met_peers.lock() {
        *met = remembered.clone();
    }

    // Every node takes part in the heartbeats topic (ADR-300): it publishes
    // its own heartbeat and checks everyone else's. The timer's first tick
    // fires at once; with no peers yet that publish simply finds nobody.
    let heartbeats_topic = gossipsub::IdentTopic::new(HEARTBEATS_TOPIC);
    let _ = swarm.behaviour_mut().gossipsub.subscribe(&heartbeats_topic);
    let started = std::time::Instant::now();
    let mut heartbeat_timer = tokio::time::interval(options.heartbeat_interval);
    heartbeat_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_heartbeat: Option<std::time::Instant> = None;
    // Issuer keys are fetched off the event loop, which never waits on the
    // network (ADR-300 R18); results come back on this channel.
    let (fetch_tx, mut fetch_rx) = mpsc::unbounded_channel::<(FetchJob, Result<Fetched, String>)>();
    // Application scores follow the desk: recomputed after every heartbeat
    // decision and on this timer (forgeries age out, tokens expire, peers
    // connect).
    let mut score_timer = tokio::time::interval(options.score_refresh_interval);
    score_timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    // Periodic peer-store flush; the first tick fires immediately, so consume it
    // up front rather than writing an empty store on startup.
    let mut peer_flush = tokio::time::interval(PEER_FLUSH_INTERVAL);
    peer_flush.tick().await;

    let mut ready_tx = Some(ready_tx);
    // Peers already dropped as non-Rotifer, so a refreshed mDNS record does not
    // make us dial them again. Bounded like the mDNS table it filters.
    let mut foreign_peers: HashSet<Libp2pPeerId> = HashSet::new();
    // Correlate in-flight DHT queries with the caller waiting on the result.
    let mut pending_put: HashMap<kad::QueryId, oneshot::Sender<Result<(), NetworkError>>> =
        HashMap::new();
    let mut pending_get: HashMap<kad::QueryId, oneshot::Sender<Option<Vec<u8>>>> = HashMap::new();
    loop {
        tokio::select! {
            _ = peer_flush.tick() => {
                // A clean shutdown persists peers too, but daemons are often
                // killed rather than stopped; flushing periodically bounds how
                // much of the peer cache a hard kill can cost.
                if let Ok(met) = met_peers.lock()
                    && let Err(e) = persist_peers(&peerstore_path, &met)
                {
                    tracing::debug!("periodic peer-store flush failed: {e}");
                }
            }
            _ = heartbeat_timer.tick() => {
                let data = own_heartbeat(started, &attestation);
                if swarm.behaviour_mut().gossipsub.publish(heartbeats_topic.clone(), data).is_ok() {
                    last_heartbeat = Some(std::time::Instant::now());
                }
            }
            _ = score_timer.tick() => {
                refresh_scores(&mut swarm, &heartbeats, &scores, started);
            }
            Some((job, result)) = fetch_rx.recv() => {
                let (now_s, mono_s) = (wall_clock_ms() / 1000, started.elapsed().as_secs());
                let next = heartbeats.lock().ok().and_then(|mut d| d.on_fetched(&job, result, now_s, mono_s));
                if let Some(next) = next {
                    spawn_jwks_fetch(next, &fetch_tx);
                }
            }
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
                    if let Some(relay_peer) = circuit_relay(&address)
                        && let Ok(mut n) = nat.lock()
                    {
                        n.relay_reservations.retain(|r| r != &relay_peer);
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
                    // Remember only addresses we dialled ourselves: those are
                    // reachable again by definition. An inbound connection's
                    // remote address is the peer's ephemeral source port, which
                    // is useless to dial back.
                    if endpoint.is_dialer()
                        && let Ok(mut met) = met_peers.lock()
                    {
                        remember(&mut met, &addr, &peer_id);
                    }
                    swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
                }
                // Refusals by our own limits are counted by cause so load
                // shedding is observable (ADR-304 D2); a transport failure
                // is not a refusal. Logged at debug: a flood would spam warn.
                SwarmEvent::IncomingConnectionError {
                    error: ListenError::Denied { cause }, ..
                } => record_denial(&denials, true, &cause),
                SwarmEvent::OutgoingConnectionError {
                    error: DialError::Denied { cause }, ..
                } => record_denial(&denials, false, &cause),
                SwarmEvent::Behaviour(NodeBehaviourEvent::Autonat(
                    autonat::Event::StatusChanged { new, .. },
                )) => {
                    let reachability = reachability_of(&new);
                    tracing::info!(?reachability, "AutoNAT reachability changed");
                    if let Ok(mut n) = nat.lock() {
                        n.reachability = reachability;
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::RelayClient(event)) => {
                    let Ok(mut n) = nat.lock() else { continue };
                    match event {
                        relay::client::Event::ReservationReqAccepted { relay_peer_id, renewal, .. } => {
                            let relay_peer = relay_peer_id.to_string();
                            if !n.relay_reservations.contains(&relay_peer) {
                                n.relay_reservations.push(relay_peer);
                            }
                            if !renewal {
                                tracing::info!(%relay_peer_id, "relay reservation accepted");
                            }
                        }
                        relay::client::Event::InboundCircuitEstablished { src_peer_id, .. } => {
                            n.relayed_inbound += 1;
                            tracing::debug!(%src_peer_id, "peer connected through a relay");
                        }
                        relay::client::Event::OutboundCircuitEstablished { .. } => {}
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Dcutr(dcutr::Event {
                    remote_peer_id,
                    result,
                })) => {
                    let Ok(mut n) = nat.lock() else { continue };
                    match result {
                        Ok(_) => {
                            n.hole_punch_succeeded += 1;
                            tracing::debug!(%remote_peer_id, "hole punch succeeded: direct connection");
                        }
                        Err(e) => {
                            n.hole_punch_failed += 1;
                            tracing::debug!(%remote_peer_id, "hole punch failed, staying on the relay: {e}");
                        }
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Kademlia(
                    kad::Event::RoutingUpdated { peer, .. },
                )) => {
                    if let Ok(mut peers) = discovered.lock() {
                        peers.insert(peer.to_string());
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Gossipsub(
                    gossipsub::Event::Subscribed { topic, .. },
                )) if topic == heartbeats_topic.hash()
                    && last_heartbeat.is_none_or(|t| t.elapsed() >= MIN_HEARTBEAT_GAP) =>
                {
                    // A peer joined: let it know this node now rather than
                    // after up to a whole interval.
                    let data = own_heartbeat(started, &attestation);
                    if swarm.behaviour_mut().gossipsub.publish(heartbeats_topic.clone(), data).is_ok() {
                        last_heartbeat = Some(std::time::Instant::now());
                        heartbeat_timer.reset();
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Gossipsub(
                    gossipsub::Event::Message {
                        propagation_source,
                        message_id,
                        message,
                    },
                )) => {
                    use super::messages::{Verdict, topic_validator};
                    use gossipsub::MessageAcceptance;
                    let now_ms = wall_clock_ms();
                    let topic = message.topic.to_string();
                    let source = message.source.map(|p| p.to_string());
                    // Flood defence (§8.6) first: over the per-peer ceiling the
                    // message is dropped unforwarded (not penalized — the
                    // relay may be honest).
                    let sender = PeerId(propagation_source.to_string());
                    // Only gene announcements are kept for the API; heartbeats
                    // update the heartbeat desk instead.
                    let mut surface = false;
                    let acceptance = if security.record_message(&sender).is_err() {
                        if let Ok(mut n) = rate_limited.lock() {
                            *n += 1;
                        }
                        MessageAcceptance::Ignore
                    } else if let Some(validate) = topic_validator(&topic) {
                        // The topic's validator runs before forwarding (RFC
                        // §6.4, ADR-340): invalid messages are dropped and
                        // their sender penalized, never relayed.
                        match validate(&message.data, source.as_deref(), now_ms) {
                            Verdict::Accept(_) => {
                                surface = true;
                                MessageAcceptance::Accept
                            }
                            Verdict::Heartbeat(hb) => {
                                // Well-formed and fresh; the desk decides its
                                // attestation (ADR-300 contract v2). The
                                // validator has already refused a missing source.
                                let from = source.as_deref().unwrap_or_default();
                                let mono_ms = started.elapsed().as_millis() as u64;
                                let (decision, fetch) = heartbeats
                                    .lock()
                                    .map(|mut d| d.on_heartbeat(from, &hb, now_ms, mono_ms))
                                    .unwrap_or((Decision::Ignore, None));
                                if let Some(job) = fetch {
                                    spawn_jwks_fetch(job, &fetch_tx);
                                }
                                refresh_scores(&mut swarm, &heartbeats, &scores, started);
                                match decision {
                                    Decision::Accept => MessageAcceptance::Accept,
                                    Decision::Ignore => MessageAcceptance::Ignore,
                                    Decision::Reject => {
                                        if let Ok(mut n) = invalid.lock() {
                                            *n += 1;
                                        }
                                        MessageAcceptance::Reject
                                    }
                                }
                            }
                            Verdict::Ignore => MessageAcceptance::Ignore,
                            Verdict::Reject(_) => {
                                if let Ok(mut n) = invalid.lock() {
                                    *n += 1;
                                }
                                MessageAcceptance::Reject
                            }
                        }
                    } else {
                        // No validator registered: nothing has checked these
                        // bytes, so they are not surfaced or forwarded. Not
                        // penalized either — the topic may be one a newer
                        // node speaks (ADR-340 D3's Ignore).
                        if let Ok(mut n) = unregistered.lock() {
                            *n += 1;
                        }
                        MessageAcceptance::Ignore
                    };
                    if surface
                        && matches!(acceptance, MessageAcceptance::Accept)
                        && let Ok(mut msgs) = received.lock()
                    {
                        push_bounded(
                            &mut msgs,
                            ReceivedMessage { topic, data: message.data, source, received_at_ms: now_ms },
                            MAX_RECEIVED_MESSAGES,
                        );
                    }
                    // Always report: with `validate_messages` a message stays
                    // queued until its fate is reported.
                    let _ = swarm.behaviour_mut().gossipsub.report_message_validation_result(
                        &message_id,
                        &propagation_source,
                        acceptance,
                    );
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Identify(
                    identify::Event::Received { peer_id, info, .. },
                )) if info.protocol_version != IDENTIFY_PROTOCOL_VERSION => {
                    if relay_peers.contains(&peer_id) {
                        tracing::warn!(
                            %peer_id,
                            protocol_version = %info.protocol_version,
                            "configured relay is not a Rotifer node; dropping it, so no circuit can run through it"
                        );
                    }
                    // Not a Rotifer node. mDNS's shared `_p2p._udp.local`
                    // service makes this routine on a LAN (IPFS and other
                    // libp2p apps answer too), and Kademlia speaks libp2p's
                    // default protocol name, so without this an unrelated
                    // node would enter our routing table and peer store. Drop
                    // everything learned about it and hang up.
                    let peer = peer_id.to_string();
                    let suffix = format!("/p2p/{peer}");
                    swarm.behaviour_mut().kademlia.remove_peer(&peer_id);
                    if let Ok(mut peers) = discovered.lock() {
                        peers.remove(&peer);
                    }
                    if let Ok(mut met) = met_peers.lock() {
                        met.retain(|addr| !addr.ends_with(&suffix));
                    }
                    if let Ok(mut n) = foreign.lock() {
                        *n += 1;
                    }
                    if foreign_peers.len() < MAX_MDNS_PEERS {
                        foreign_peers.insert(peer_id);
                    }
                    tracing::debug!(
                        %peer_id,
                        protocol_version = %info.protocol_version,
                        "dropping non-Rotifer peer"
                    );
                    let _ = swarm.disconnect_peer_id(peer_id);
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Identify(
                    identify::Event::Received { peer_id, info, .. },
                )) => {
                    if let Ok(mut ids) = identified.lock() {
                        ids.insert(peer_id.to_string());
                    }
                    // Feed the peer's advertised listen addresses into Kademlia
                    // to improve routing — standard Identify usage (ADR-304) —
                    // and remember them so a restart can re-dial this peer
                    // without any bootstrap node.
                    for addr in info.listen_addrs {
                        if let Ok(mut met) = met_peers.lock() {
                            remember(&mut met, &addr, &peer_id);
                        }
                        swarm.behaviour_mut().kademlia.add_address(&peer_id, addr);
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Mdns(mdns::Event::Discovered(found))) => {
                    // RFC §5.1.1: connect to each newly announced peer. What
                    // follows is the ordinary path — Identify confirms it is a
                    // Rotifer node and feeds Kademlia, GossipSub meshes it in.
                    // The Noise handshake authenticates the PeerId, so a forged
                    // mDNS answer cannot impersonate a node (§5.1.2).
                    let mut by_peer: HashMap<Libp2pPeerId, Vec<Multiaddr>> = HashMap::new();
                    if let Ok(mut known) = mdns_peers.lock() {
                        for (peer, addr) in found {
                            if foreign_peers.contains(&peer) {
                                continue;
                            }
                            let key = peer.to_string();
                            if !known.contains_key(&key) && known.len() >= MAX_MDNS_PEERS {
                                tracing::debug!(%peer, "mDNS peer table full, ignoring");
                                continue;
                            }
                            known.entry(key).or_default().insert(addr.to_string());
                            by_peer.entry(peer).or_default().push(addr);
                        }
                    }
                    for (peer, addrs) in by_peer {
                        // mDNS discovery is mutual, so both nodes dial at the
                        // same instant. With libp2p's default port reuse each
                        // dial leaves from the dialer's listen port, the two
                        // SYNs cross, and TCP simultaneous open merges them
                        // into one connection on which both sides start the
                        // Noise handshake as initiator — it fails ("input
                        // error") and neither node connects. A fresh source
                        // port keeps the two dials separate connections.
                        let opts = DialOpts::peer_id(peer)
                            .addresses(addrs)
                            .condition(PeerCondition::DisconnectedAndNotDialing)
                            .allocate_new_port()
                            .build();
                        if let Err(e) = swarm.dial(opts) {
                            tracing::debug!(%peer, "mDNS dial skipped: {e}");
                        }
                    }
                }
                SwarmEvent::Behaviour(NodeBehaviourEvent::Mdns(mdns::Event::Expired(gone))) => {
                    if let Ok(mut known) = mdns_peers.lock() {
                        for (peer, addr) in gone {
                            let key = peer.to_string();
                            if let Some(addrs) = known.get_mut(&key) {
                                addrs.remove(&addr.to_string());
                                if addrs.is_empty() {
                                    known.remove(&key);
                                }
                            }
                        }
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

/// This node's heartbeat as of now.
fn own_heartbeat(started: std::time::Instant, attestation: &Arc<Mutex<Option<String>>>) -> Vec<u8> {
    let token = attestation.lock().ok().and_then(|a| a.clone()).unwrap_or_default();
    heartbeat::encode_heartbeat(&WireNodeHeartbeat {
        // The network layer holds no gene store of its own yet, so a node
        // claims none rather than a number nothing backs.
        genes_hosted: 0,
        uptime_seconds: started.elapsed().as_secs(),
        rotifer_version: env!("CARGO_PKG_VERSION").into(),
        bindings: Vec::new(),
        cloud_attestation: token.into_bytes(),
        timestamp_ms: wall_clock_ms(),
    })
}

/// Set every connected peer's GossipSub application score from the heartbeat
/// desk, and record the resulting scores for [`Node::peer_score`].
fn refresh_scores(
    swarm: &mut Swarm<NodeBehaviour>,
    desk: &Mutex<HeartbeatDesk>,
    scores: &Mutex<HashMap<String, f64>>,
    started: std::time::Instant,
) {
    let connected: Vec<Libp2pPeerId> = swarm.connected_peers().copied().collect();
    let names: Vec<String> = connected.iter().map(|p| p.to_string()).collect();
    let app = match desk.lock() {
        Ok(d) => d.scores(
            names.iter().map(String::as_str),
            wall_clock_ms(),
            started.elapsed().as_millis() as u64,
        ),
        Err(_) => return,
    };
    let gossipsub = &mut swarm.behaviour_mut().gossipsub;
    let mut now = HashMap::with_capacity(connected.len());
    for (peer, (name, score)) in connected.iter().zip(app) {
        gossipsub.set_application_score(peer, score);
        if let Some(total) = gossipsub.peer_score(peer) {
            now.insert(name.to_string(), total);
        }
    }
    if let Ok(mut s) = scores.lock() {
        *s = now;
    }
}

/// Fetch an issuer's keys on the blocking pool and hand the result back to
/// the event loop.
fn spawn_jwks_fetch(job: FetchJob, tx: &mpsc::UnboundedSender<(FetchJob, Result<Fetched, String>)>) {
    let tx = tx.clone();
    tokio::task::spawn_blocking(move || {
        let result = por::fetch_jwks(&job.url);
        let _ = tx.send((job, result));
    });
}

/// Record a peer address in dialable form (`<transport>/p2p/<peer-id>`, the same
/// syntax as `--bootstrap`), skipping duplicates. Addresses that already carry a
/// `/p2p/` component are kept as-is so the suffix is never doubled.
fn remember(met: &mut Vec<String>, addr: &Multiaddr, peer_id: &Libp2pPeerId) {
    let text = addr.to_string();
    let dialable = if text.contains("/p2p/") {
        text
    } else {
        format!("{text}/p2p/{peer_id}")
    };
    if !met.contains(&dialable) {
        met.push(dialable);
    }
}

/// Write remembered peers to disk (atomic, same durability as the identity file).
fn persist_peers(path: &Path, addrs: &[String]) -> std::io::Result<()> {
    if addrs.is_empty() {
        return Ok(());
    }
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic_private(path, peerstore::encode(addrs).as_bytes())
}

#[cfg(test)]
#[allow(non_snake_case)]
mod tests {
    use super::*;

    /// Gossip topics and the Identify version string move together (ADR-340
    /// D3): every registered topic sits under the version a peer identifies by.
    #[test]
    fn registered_topics_share_the_identify_version() {
        for (topic, _) in super::super::messages::TOPIC_VALIDATORS {
            assert!(
                topic.starts_with(&format!("{IDENTIFY_PROTOCOL_VERSION}/")),
                "{topic} is not under {IDENTIFY_PROTOCOL_VERSION}"
            );
        }
    }

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
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "A.1.6 integration: real mDNS multicast on a non-loopback interface — enable the p2p-integration feature or run with --ignored"
    )]
    fn A_1_6_two_nodes_mdns_self_discover_within_3s() {
        // No bootstrap, no peer store: mDNS is the only way these two can meet.
        // They listen on 0.0.0.0 because mDNS announces a node at the source
        // IP of its multicast packet, never at loopback (see mdns_should_run).
        let dir = tempfile::tempdir().expect("temp dir");
        let start = |name: &str| {
            let c = NetworkConfig { listen_host: "0.0.0.0".into(), ..cfg(0) };
            let mut node = Node::with_paths(
                c,
                dir.path().join(format!("{name}.pem")),
                dir.path().join(format!("{name}-peers.json")),
            )
            .expect("A.1.6 — build");
            node.start().expect("A.1.6 — start");
            assert!(
                node.mdns_active(),
                "A.1.6 — mDNS did not start: this host has no multicast-capable non-loopback interface"
            );
            node
        };
        let a = start("a");
        let b = start("b");
        let (a_peer, b_peer) = (a.local_peer_id().0, b.local_peer_id().0);
        assert_ne!(a_peer, b_peer, "nodes must have distinct PeerIds");

        // A.1.6 bound: both sides see the other's mDNS announcement within 3s.
        let started = std::time::Instant::now();
        let deadline = started + Duration::from_secs(3);
        loop {
            let a_saw_b = a.mdns_peers().contains(&b_peer);
            let b_saw_a = b.mdns_peers().contains(&a_peer);
            if a_saw_b && b_saw_a {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "A.1.6 — no mutual mDNS discovery within 3s (a_saw_b={a_saw_b}, b_saw_a={b_saw_a})"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        eprintln!("A.1.6 — mutual mDNS discovery after {:?}", started.elapsed());

        // RFC §5.1.1 steps 1–2: the discovery turns into an authenticated
        // connection — each side completes Identify with the other.
        await_peer(&a, &b_peer, "A.1.6 — A never identified B after mDNS discovery");
        await_peer(&b, &a_peer, "A.1.6 — B never identified A after mDNS discovery");
        eprintln!("A.1.6 — mutual Identify after {:?}", started.elapsed());
    }

    // -----------------------------------------------------------------
    // mDNS only runs on a non-loopback listen interface (RFC §5.1, §8.7)
    // -----------------------------------------------------------------
    #[test]
    fn mdns_runs_only_on_a_non_loopback_listen_host() {
        assert!(mdns_should_run(true, "0.0.0.0"));
        assert!(mdns_should_run(true, "192.168.1.20"));
        assert!(!mdns_should_run(true, "127.0.0.1"), "loopback would be announced at an unreachable LAN address");
        assert!(!mdns_should_run(true, "::1"));
        assert!(!mdns_should_run(true, "not-an-ip"));
        assert!(!mdns_should_run(false, "0.0.0.0"), "disabled means disabled");
    }

    #[test]
    fn mdns_timing_follows_rfc_5_1_1() {
        let c = mdns_config();
        assert_eq!(c.query_interval, Duration::from_secs(30));
        assert_eq!(c.ttl, Duration::from_secs(120));
        assert!(!c.enable_ipv6);
    }

    #[test]
    fn loopback_node_does_not_run_mdns() {
        // The default node (127.0.0.1) asked for mDNS but must not run it.
        let dir = tempfile::tempdir().expect("temp dir");
        let c = NetworkConfig { mdns_enabled: true, ..cfg(0) };
        let mut node = Node::with_keypair_path(c, dir.path().join("id.pem")).expect("build");
        node.start().expect("start");
        assert!(!node.mdns_active());
        assert!(node.mdns_peers().is_empty());
    }

    #[test]
    fn publish_refuses_topics_without_a_validator() {
        use super::super::messages::ANNOUNCEMENTS_TOPIC;
        // A started node, so a refusal can only come from the topic check.
        let dir = tempfile::tempdir().expect("temp dir");
        let mut node = Node::with_keypair_path(cfg(0), dir.path().join("id.pem")).expect("build");
        node.start().expect("start");
        // ADR-340 D6: the pre-freeze JSON topic is never written. The others
        // have no validator, so every Rotifer node would ignore them.
        for topic in [
            "/rotifer/announcements",
            "/rotifer/announcements/text",
            "/rotifer/p2p/1/unregistered",
            "",
        ] {
            match node.publish(topic, b"x") {
                Err(NetworkError::UnregisteredTopic(t)) => assert_eq!(t, topic),
                other => panic!("publish on {topic:?} must be refused as unregistered, got {other:?}"),
            }
        }
        node.publish(ANNOUNCEMENTS_TOPIC, b"x").expect("the registered topic is allowed");
        node.publish(HEARTBEATS_TOPIC, b"x").expect("the heartbeats topic is registered too (ADR-300)");
    }

    // -----------------------------------------------------------------
    // With mDNS switched off, LAN nodes stay strangers (RFC §5.1.2)
    // -----------------------------------------------------------------
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "integration: mDNS off-switch on a non-loopback interface — enable the p2p-integration feature or run with --ignored"
    )]
    fn mdns_disabled_nodes_do_not_discover_each_other() {
        let dir = tempfile::tempdir().expect("temp dir");
        let start = |name: &str| {
            let c = NetworkConfig { listen_host: "0.0.0.0".into(), mdns_enabled: false, ..cfg(0) };
            let mut node = Node::with_paths(
                c,
                dir.path().join(format!("{name}.pem")),
                dir.path().join(format!("{name}-peers.json")),
            )
            .expect("build");
            node.start().expect("start");
            assert!(!node.mdns_active(), "mdns_enabled: false must keep mDNS off");
            node
        };
        let a = start("a");
        let b = start("b");
        // Three times the window A.1.6 needs for discovery to happen at all.
        std::thread::sleep(Duration::from_secs(9));
        assert!(a.mdns_peers().is_empty() && b.mdns_peers().is_empty());
        assert!(!a.identified_peers().contains(&b.local_peer_id().0));
        assert!(!b.identified_peers().contains(&a.local_peer_id().0));
    }

    // -----------------------------------------------------------------
    // A libp2p node that is not a Rotifer node is dropped after Identify
    // -----------------------------------------------------------------
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "integration: non-Rotifer libp2p peer over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn non_rotifer_peer_is_dropped_after_identify() {
        use libp2p::swarm::NetworkBehaviour;

        // What an IPFS node answering our mDNS query looks like to us: plain
        // libp2p, Kademlia on the shared default protocol, a foreign Identify
        // version.
        #[derive(NetworkBehaviour)]
        struct Foreign {
            identify: identify::Behaviour,
            kademlia: kad::Behaviour<MemoryStore>,
        }

        let dir = tempfile::tempdir().expect("temp dir");
        let mut node = Node::with_paths(cfg(0), dir.path().join("id.pem"), dir.path().join("peers.json"))
            .expect("build");
        node.start().expect("start");
        let target: Multiaddr = format!("{}/p2p/{}", node.listen_addrs()[0], node.local_peer_id().0)
            .parse()
            .expect("dialable addr");

        let rt = tokio::runtime::Runtime::new().expect("runtime");
        let (foreign_peer, closed, closed_after) = rt.block_on(async {
            let mut swarm = libp2p::SwarmBuilder::with_new_identity()
                .with_tokio()
                .with_tcp(
                    libp2p::tcp::Config::default(),
                    libp2p::noise::Config::new,
                    libp2p::yamux::Config::default,
                )
                .expect("tcp")
                .with_behaviour(|key| {
                    let id = key.public().to_peer_id();
                    let mut kademlia = kad::Behaviour::new(id, MemoryStore::new(id));
                    kademlia.set_mode(Some(kad::Mode::Server));
                    Foreign {
                        identify: identify::Behaviour::new(identify::Config::new(
                            "/ipfs/0.1.0".into(),
                            key.public(),
                        )),
                        kademlia,
                    }
                })
                .expect("behaviour")
                .build();
            let me = *swarm.local_peer_id();
            swarm.dial(target).expect("dial");
            let mut connected_at = None;
            let closed_after = tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    match swarm.select_next_some().await {
                        SwarmEvent::ConnectionEstablished { .. } => {
                            connected_at.get_or_insert_with(std::time::Instant::now);
                        }
                        SwarmEvent::ConnectionClosed { num_established: 0, .. } if connected_at.is_some() => {
                            return connected_at.map(|t| t.elapsed());
                        }
                        _ => {}
                    }
                }
            })
            .await
            .unwrap_or(None);
            (me.to_string(), closed_after.is_some(), closed_after)
        });

        assert!(closed, "the Rotifer node must hang up on a non-Rotifer peer");
        // libp2p closes an idle connection after 10 s (the swarm default; neither
        // side changes it), so a hang-up that slow could be idleness, not the
        // guard. Identify completes in milliseconds; 5 s is half the idle timeout.
        let closed_after = closed_after.expect("closed");
        assert!(
            closed_after < Duration::from_secs(5),
            "the guard must hang up right after Identify, not leave it to the 10 s idle timeout (closed after {closed_after:?})"
        );
        assert_eq!(node.foreign_peers_dropped(), 1);
        assert!(!node.identified_peers().contains(&foreign_peer));
        assert!(!node.discovered_peers().contains(&foreign_peer));
        let _ = node.stop();
        assert!(
            peerstore::load(&dir.path().join("peers.json")).iter().all(|a| !a.contains(&foreign_peer)),
            "a non-Rotifer peer must not be remembered"
        );
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
    // Replay inside the freshness window is de-duplicated by GossipSub
    // -----------------------------------------------------------------
    #[test]
    fn gossip_duplicate_cache_spans_the_replay_window() {
        let window = Duration::from_secs(2 * super::super::messages::MAX_TIMESTAMP_SKEW_SECS);
        assert!(
            gossipsub_config().duplicate_cache_time() >= window,
            "a re-injected message still inside the timestamp window must hit the duplicate cache"
        );
    }

    // -----------------------------------------------------------------
    // Inbound message buffer is bounded (many identities, each under the
    // per-peer rate limit, must not grow memory without limit)
    // -----------------------------------------------------------------
    #[test]
    fn received_buffer_is_bounded_and_drops_oldest() {
        let mut buf = Vec::new();
        for i in 0..10u8 {
            push_bounded(
                &mut buf,
                ReceivedMessage { topic: "t".into(), data: vec![i], source: None, received_at_ms: 0 },
                4,
            );
        }
        assert_eq!(buf.len(), 4);
        assert_eq!(buf.first().unwrap().data, vec![6], "oldest entries are evicted first");
        assert_eq!(buf.last().unwrap().data, vec![9]);
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
    // Remembered peers survive a restart and remove the bootstrap dependency
    // -----------------------------------------------------------------
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "two-node integration: peer-store reconnect over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn remembered_peers_let_a_restart_reconnect_without_bootstrap() {
        // The point of the peer store: B meets A once *using* bootstrap, then
        // restarts with an empty bootstrap list and still finds A. Without
        // persistence this is impossible — which is precisely what makes a
        // bootstrap node a single point of failure.
        let dir = std::env::temp_dir().join("rotifer-peerstore-reconnect");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        let a_id = dir.join("a-identity.pem");
        let b_id = dir.join("b-identity.pem");
        let b_store = dir.join("b-peers.json");

        // Node A listens on a fixed port so it is at the same address after
        // B restarts (an OS-allocated port would change and defeat the test).
        let a_port = 39871;
        let mut cfg_a = cfg(a_port);
        cfg_a.bootstrap_peers = vec![];
        let mut a = Node::with_paths(cfg_a, a_id.clone(), dir.join("a-peers.json"))
            .expect("A build");
        a.start().expect("A start");
        let a_peer = a.local_peer_id().0;
        let a_addr = a
            .listen_addrs()
            .into_iter()
            .next()
            .expect("A must have a listen address");

        // First run: B learns about A through bootstrap.
        let mut cfg_b = cfg(0);
        cfg_b.bootstrap_peers = vec![a_addr];
        let mut b = Node::with_paths(cfg_b, b_id.clone(), b_store.clone()).expect("B build");
        b.start().expect("B start");
        await_peer(&b, &a_peer, "B did not identify A on the first run");
        let _ = b.stop();

        // The store must now name A, so the knowledge outlived the process.
        let remembered = peerstore::load(&b_store);
        assert!(
            remembered.iter().any(|addr| addr.contains(&a_peer)),
            "peer store should remember A after a clean shutdown; got {remembered:?}"
        );

        // Second run: no bootstrap at all. Reconnection can only come from the
        // store.
        let mut cfg_b2 = cfg(0);
        cfg_b2.bootstrap_peers = vec![];
        let mut b2 = Node::with_paths(cfg_b2, b_id.clone(), b_store.clone()).expect("B restart");
        b2.start().expect("B restart start");
        await_peer(
            &b2,
            &a_peer,
            "B failed to reconnect to A from the peer store with no bootstrap peers",
        );

        let _ = b2.stop();
        let _ = a.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Poll until `node` has completed an Identify exchange with `peer`, or fail
    /// with `msg`. Identify (not Kademlia discovery) is the right signal here:
    /// it means the connection is fully established, which is when addresses
    /// become worth remembering.
    fn await_peer(node: &Node, peer: &str, msg: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if node.identified_peers().iter().any(|p| p == peer) {
                return;
            }
            assert!(std::time::Instant::now() < deadline, "{msg}");
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
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
        use super::super::messages::{ANNOUNCEMENTS_TOPIC as TOPIC, encode_announcement};
        // A valid wire-v1 announcement on the real topic: only a validated
        // topic's messages are surfaced and forwarded (ADR-340 D3 / D6).
        let encoded = encode_announcement(&super::super::GeneAnnouncement {
            gene_id: format!("v2:{}", "ab".repeat(32)),
            name: "gossip-auth".into(),
            domain: "test".into(),
            fidelity: "Wrapped".into(),
            ir_spec: String::new(),
            version: "1.0.0".into(),
            timestamp_ms: wall_clock_ms(),
        });
        let payload = encoded.as_slice();

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

    // -----------------------------------------------------------------
    // A3 — NAT traversal client and connection limits (ADR-304 D1–D2)
    // -----------------------------------------------------------------

    /// Poll `check` every 100 ms until it holds or `secs` pass.
    fn wait_until(secs: u64, mut check: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(secs);
        while std::time::Instant::now() < deadline {
            if check() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        check()
    }

    /// A Circuit Relay v2 server on loopback, as a plain libp2p swarm: the node
    /// is a relay client only (ADR-304 D3). It identifies as a Rotifer node,
    /// as a relay must: peers dialling through it drop anything else.
    struct LocalRelay {
        /// `/ip4/127.0.0.1/tcp/<port>/p2p/<relay PeerId>`
        addr: String,
        peer_id: String,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl LocalRelay {
        fn spawn() -> Self {
            use libp2p::swarm::NetworkBehaviour;

            #[derive(NetworkBehaviour)]
            struct RelayServer {
                relay: relay::Behaviour,
                identify: identify::Behaviour,
            }

            let key = Keypair::generate_ed25519();
            let peer_id = key.public().to_peer_id();
            let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let stop_t = Arc::clone(&stop);
            let (tx, rx) = std::sync::mpsc::channel();
            let thread = std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("runtime");
                rt.block_on(async move {
                    let mut swarm = libp2p::SwarmBuilder::with_existing_identity(key)
                        .with_tokio()
                        .with_tcp(
                            libp2p::tcp::Config::default(),
                            libp2p::noise::Config::new,
                            libp2p::yamux::Config::default,
                        )
                        .expect("tcp")
                        .with_behaviour(|key| RelayServer {
                            relay: relay::Behaviour::new(key.public().to_peer_id(), relay::Config::default()),
                            identify: identify::Behaviour::new(identify::Config::new(
                                IDENTIFY_PROTOCOL_VERSION.into(),
                                key.public(),
                            )),
                        })
                        .expect("behaviour")
                        .build();
                    swarm.listen_on("/ip4/127.0.0.1/tcp/0".parse().expect("addr")).expect("listen");
                    let mut ready = Some(tx);
                    let mut tick = tokio::time::interval(Duration::from_millis(100));
                    while !stop_t.load(Ordering::Relaxed) {
                        tokio::select! {
                            _ = tick.tick() => {}
                            event = swarm.select_next_some() => {
                                if let SwarmEvent::NewListenAddr { address, .. } = event {
                                    // A relay hands its reachable addresses to the
                                    // peers that reserve on it.
                                    swarm.add_external_address(address.clone());
                                    if let Some(tx) = ready.take() {
                                        let _ = tx.send(address);
                                    }
                                }
                            }
                        }
                    }
                });
            });
            let addr = rx.recv_timeout(Duration::from_secs(10)).expect("relay listening");
            Self { addr: format!("{addr}/p2p/{peer_id}"), peer_id: peer_id.to_string(), stop, thread: Some(thread) }
        }
    }

    impl Drop for LocalRelay {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    // A3-1: a node that peers can only reach through a relay holds a
    // reservation there, and a peer that knows only its relayed address
    // connects, identifies and exchanges gossip with it.
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "integration: Circuit Relay v2 through a local relay — enable the p2p-integration feature or run with --ignored"
    )]
    fn nat_node_is_reached_through_a_local_relay() {
        use super::super::messages::{ANNOUNCEMENTS_TOPIC, encode_announcement};

        let relay = LocalRelay::spawn();
        let dir = tempfile::tempdir().expect("temp dir");
        let start = |name: &str, c: NetworkConfig| {
            let mut node = Node::with_paths(
                c,
                dir.path().join(format!("{name}.pem")),
                dir.path().join(format!("{name}-peers.json")),
            )
            .expect("build");
            node.start().expect("start");
            node
        };

        // The node "behind NAT": it advertises nothing anyone is told about
        // except its circuit address on the relay.
        let behind = start("behind", NetworkConfig { relays: vec![relay.addr.clone()], ..cfg(0) });
        let behind_id = behind.local_peer_id().0;
        assert!(
            wait_until(15, || behind.nat_traversal().relay_reservations.contains(&relay.peer_id)),
            "the relay must accept a reservation (state: {:?})",
            behind.nat_traversal()
        );

        // The dialler is given only the relayed address.
        let circuit = format!("{}/p2p-circuit/p2p/{behind_id}", relay.addr);
        let dialer = start("dialer", NetworkConfig { bootstrap_peers: vec![circuit], ..cfg(0) });
        assert!(
            wait_until(15, || dialer.identified_peers().contains(&behind_id)),
            "the dialler must reach and identify the node through the relay"
        );
        assert!(
            behind.nat_traversal().relayed_inbound >= 1,
            "the connection must have arrived as a relay circuit (state: {:?})",
            behind.nat_traversal()
        );

        // Useful traffic crosses: a valid announcement from the node behind
        // NAT reaches the dialler, authenticated as its publisher.
        behind.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
        dialer.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
        let gene_id = format!("v2:{}", "cd".repeat(32));
        let delivered = wait_until(20, || {
            let payload = encode_announcement(&super::super::GeneAnnouncement {
                gene_id: gene_id.clone(),
                name: "behind-nat".into(),
                domain: "test".into(),
                fidelity: "Wrapped".into(),
                ir_spec: String::new(),
                version: "1.0.0".into(),
                timestamp_ms: wall_clock_ms(),
            });
            let _ = behind.publish(ANNOUNCEMENTS_TOPIC, &payload);
            dialer
                .received_announcements()
                .iter()
                .any(|(a, from)| a.gene_id == gene_id && from == &behind_id)
        });
        assert!(delivered, "an announcement from the node behind NAT must reach the dialler");

        // DCUtR then replaces the relayed connection with a direct one. Both
        // ends try at once and one attempt wins, so at least one side reports
        // success; on loopback the direct path always exists.
        assert!(
            wait_until(15, || behind.nat_traversal().hole_punch_succeeded + dialer.nat_traversal().hole_punch_succeeded >= 1),
            "the relayed connection must be upgraded by hole punching (behind: {:?}, dialer: {:?})",
            behind.nat_traversal(),
            dialer.nat_traversal()
        );
    }

    // A3-1: a relay entry that cannot be used fails `start` loudly.
    #[test]
    fn a_relay_without_a_peer_id_fails_start() {
        let dir = tempfile::tempdir().expect("temp dir");
        for bad in ["/ip4/127.0.0.1/tcp/4001", "not a multiaddr"] {
            let c = NetworkConfig { relays: vec![bad.into()], ..cfg(0) };
            let mut node = Node::with_keypair_path(c, dir.path().join("id.pem")).expect("build");
            match node.start() {
                Err(NetworkError::Transport(msg)) => assert!(msg.contains(bad), "error names the entry: {msg}"),
                other => panic!("relay {bad:?} must fail start, got {other:?}"),
            }
        }
    }

    // A3-1: AutoNAT asks a connected peer to dial it back, and a node the
    // peer could dial is judged Public. (A refused dial-back still completes
    // the handshake first, so loopback cannot stage Private; the mapping is
    // pinned by `autonat_verdicts_map_to_reachability`.)
    //
    // Loopback is not a global IP, so this only works with the test-only
    // relaxation. The second half pins that a node built the production way
    // keeps libp2p's rule of trusting only global IPs: it neither answers a
    // loopback peer's probe nor probes through one.
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "integration: AutoNAT dial-back on loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn autonat_judges_a_dialable_node_public() {
        let dir = tempfile::tempdir().expect("temp dir");
        let id = |name: &str| dir.path().join(format!("{name}.id"));

        // A separate pair, started first so it is watched the whole time:
        // `asker` probes at the test pace, and its only peer is `production`,
        // built without `with_autonat_on_loopback`.
        let mut production = Node::with_keypair_path(cfg(0), id("production")).expect("build");
        production.start().expect("start");
        let production_id = production.local_peer_id().0;
        let production_addr = format!("{}/p2p/{production_id}", production.listen_addrs()[0]);
        let c = NetworkConfig { bootstrap_peers: vec![production_addr], ..cfg(0) };
        let mut asker = Node::with_keypair_path(c, id("asker")).expect("build").with_autonat_on_loopback();
        asker.start().expect("start");
        let pair_started = std::time::Instant::now();

        let mut server = Node::with_keypair_path(cfg(0), id("server")).expect("build").with_autonat_on_loopback();
        server.start().expect("start");
        let server_addr = format!("{}/p2p/{}", server.listen_addrs()[0], server.local_peer_id().0);
        let c = NetworkConfig { bootstrap_peers: vec![server_addr], ..cfg(0) };
        let mut node = Node::with_keypair_path(c, id("node")).expect("build").with_autonat_on_loopback();
        assert_eq!(node.nat_status(), Reachability::Unknown, "unknown before any probe");
        node.start().expect("start");
        assert!(
            wait_until(20, || node.nat_status() == Reachability::Public),
            "a node the server can dial back must be judged Public (state: {:?})",
            node.nat_traversal()
        );

        assert!(
            asker.identified_peers().contains(&production_id),
            "asker must be connected to the production node"
        );
        // A production node that trusted loopback would answer asker's probes
        // and asker would turn Public within seconds. Watch for 25 s: past
        // libp2p's 15 s boot delay, in case a change to `build_swarm` drops
        // the test pace along with the global-IP rule.
        let remaining = Duration::from_secs(25).saturating_sub(pair_started.elapsed()).as_secs();
        assert!(
            !wait_until(remaining, || asker.nat_status() != Reachability::Unknown
                || production.nat_status() != Reachability::Unknown),
            "a node built the production way must keep AutoNAT's global-IP rule \
             (asker: {:?}, production: {:?})",
            asker.nat_traversal(),
            production.nat_traversal()
        );
    }

    #[test]
    fn autonat_keeps_libp2p_defaults_outside_tests() {
        // Only test code relaxes AutoNAT (`with_autonat_on_loopback` is
        // `#[cfg(test)]`); a node built normally uses libp2p's defaults,
        // which trust only peers seen at global IPs.
        let dir = tempfile::tempdir().expect("temp dir");
        let node = Node::with_keypair_path(cfg(0), dir.path().join("n.id")).expect("build");
        assert!(!node.autonat_on_loopback);
        let used = autonat_config(node.autonat_on_loopback);
        let libp2p = autonat::Config::default();
        assert!(used.only_global_ips);
        assert_eq!(
            (used.boot_delay, used.retry_interval, used.refresh_interval, used.throttle_server_period, used.confidence_max),
            (libp2p.boot_delay, libp2p.retry_interval, libp2p.refresh_interval, libp2p.throttle_server_period, libp2p.confidence_max)
        );
        assert_eq!(
            (used.throttle_clients_global_max, used.throttle_clients_peer_max, used.max_peer_addresses),
            (libp2p.throttle_clients_global_max, libp2p.throttle_clients_peer_max, libp2p.max_peer_addresses)
        );
        assert_eq!(node.nat_status(), Reachability::Unknown);
    }

    // A3-2: the total established cap is inbound + outbound (100 by default)
    // and follows the config. Read off the swarm `start` builds: the per-way
    // caps hide the total in any connection test.
    #[test]
    fn total_connection_cap_is_inbound_plus_outbound() {
        let dir = tempfile::tempdir().expect("temp dir");
        let limits_of = |name: &str, c: NetworkConfig| {
            let node = Node::with_keypair_path(c, dir.path().join(format!("{name}.id"))).expect("build");
            let options = node.swarm_options().expect("options");
            let mut swarm = build_swarm(node.keypair.clone(), &options).expect("swarm");
            format!("{:?}", swarm.behaviour_mut().connection_limits.limits_mut())
        };
        let no_mdns = NetworkConfig { mdns_enabled: false, ..cfg(0) };

        let defaults = limits_of("defaults", no_mdns.clone());
        for field in [
            "max_established_total: Some(100)",
            "max_established_incoming: Some(50)",
            "max_established_outgoing: Some(50)",
        ] {
            assert!(defaults.contains(field), "default limits must have {field}: {defaults}");
        }

        let c = NetworkConfig { max_inbound_connections: 3, max_outbound_connections: 4, ..no_mdns };
        let custom = limits_of("custom", c);
        for field in [
            "max_established_total: Some(7)",
            "max_established_incoming: Some(3)",
            "max_established_outgoing: Some(4)",
        ] {
            assert!(custom.contains(field), "limits must follow the config ({field}): {custom}");
        }
    }

    #[test]
    fn autonat_verdicts_map_to_reachability() {
        let addr: Multiaddr = "/ip4/203.0.113.7/tcp/4001".parse().expect("addr");
        assert_eq!(reachability_of(&autonat::NatStatus::Public(addr)), Reachability::Public);
        assert_eq!(reachability_of(&autonat::NatStatus::Private), Reachability::Private);
        assert_eq!(reachability_of(&autonat::NatStatus::Unknown), Reachability::Unknown);
    }

    // A3-2: refusals are counted by direction and cause, and the outbound cap
    // from the config is enforced.
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "integration: outbound connection cap over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn outbound_cap_refuses_dials_and_counts_them() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut target = Node::with_keypair_path(cfg(0), dir.path().join("target.pem")).expect("build");
        target.start().expect("start");
        let target_addr = format!("{}/p2p/{}", target.listen_addrs()[0], target.local_peer_id().0);
        let target_id = target.local_peer_id().0;

        let c = NetworkConfig { bootstrap_peers: vec![target_addr], max_outbound_connections: 0, ..cfg(0) };
        let mut capped = Node::with_keypair_path(c, dir.path().join("capped.pem")).expect("build");
        capped.start().expect("start");

        assert!(
            wait_until(10, || capped.connection_denials().outbound_limit >= 1),
            "the dial must be refused by the outbound cap (denials: {:?})",
            capped.connection_denials()
        );
        let d = capped.connection_denials();
        assert_eq!((d.inbound_limit, d.memory), (0, 0), "counted under its own cause only: {d:?}");
        assert_eq!(capped.rejected_connections(), d.total());
        assert!(!capped.identified_peers().contains(&target_id), "no connection was made");
    }

    // A connection refused by a limit must leave no trace in the other
    // behaviours. libp2p asks behaviours in field order; one that records a
    // connection before a later limit refuses it keeps a stale entry, and
    // request-response (under AutoNAT) then panics in the event loop when the
    // peer's real connection closes. The limits are listed first for this.
    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "integration: refused connection and AutoNAT over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn a_refused_connection_does_not_crash_the_event_loop() {
        let dir = tempfile::tempdir().expect("temp dir");
        let id = |name: &str| dir.path().join(format!("{name}.id"));
        let mut prober = Node::with_keypair_path(cfg(0), id("prober")).expect("build").with_autonat_on_loopback();
        prober.start().expect("start");
        let prober_addr = format!("{}/p2p/{}", prober.listen_addrs()[0], prober.local_peer_id().0);

        // Connects out to the prober, then refuses the prober's AutoNAT
        // dial-back under its zero inbound cap.
        let c = NetworkConfig { bootstrap_peers: vec![prober_addr], ..cfg(0) };
        let mut node = Node::with_keypair_path(c, id("node"))
            .expect("build")
            .with_autonat_on_loopback()
            .with_max_established_incoming(0);
        node.start().expect("start");
        assert!(
            wait_until(20, || node.connection_denials().inbound_limit >= 1),
            "precondition: the dial-back must be refused (denials: {:?})",
            node.connection_denials()
        );

        // Closing the real connection is what tripped the stale entry.
        prober.stop().expect("stop");
        std::thread::sleep(Duration::from_secs(2));
        assert!(
            node.subscribe("/rotifer/p2p/1/announcements").is_ok(),
            "the event loop must still be running after a refused connection"
        );
    }

    // -----------------------------------------------------------------
    // A1 — heartbeats with proof of registration (ADR-300 contract v2)
    // -----------------------------------------------------------------

    #[test]
    fn set_attestation_refuses_tokens_that_would_brand_this_node_a_forger() {
        use super::super::por::tests::{claims, header, sign};
        let dir = tempfile::tempdir().expect("temp dir");
        let node = Node::with_keypair_path(cfg(0), dir.path().join("n.id")).expect("build");
        let kp = libp2p::identity::ed25519::Keypair::generate();
        let me = node.local_peer_id().0;
        let mine = sign(&kp, &header("k1"), &claims(&me, 1_800_000_000));
        let theirs = sign(&kp, &header("k1"), &claims("12D3KooWSomeoneElse", 1_800_000_000));
        assert!(node.set_attestation(Some(mine)).is_ok());
        assert!(matches!(node.set_attestation(Some(theirs)), Err(NetworkError::Config(_))));
        assert!(matches!(node.set_attestation(Some("not a token".into())), Err(NetworkError::Config(_))));
        assert!(node.set_attestation(None).is_ok());
    }

    #[test]
    fn peer_score_params_are_the_ruled_ones() {
        // The parameters the swarm is built with (CEO 〔T-140〕 E7), not
        // libp2p's defaults: if either side drifts, this fails.
        let (params, thresholds) = peer_score_params();
        assert_eq!(params.app_specific_weight, 1.0);
        assert!(params.topics.is_empty(), "no topic scores: P1–P4 stay off");
        assert_eq!(
            (thresholds.gossip_threshold, thresholds.publish_threshold, thresholds.graylist_threshold),
            (-10.0, -50.0, -80.0)
        );
    }

    #[test]
    fn a_bad_trust_anchor_fails_start() {
        let dir = tempfile::tempdir().expect("temp dir");
        let anchors = vec![super::super::por::TrustAnchor {
            iss: "https://rotifer.dev".into(),
            jwks_url: "http://rotifer.dev/.well-known/jwks.json".into(),
        }];
        let mut node = Node::with_keypair_path(NetworkConfig { trust_anchors: anchors, ..cfg(0) }, dir.path().join("n.id"))
            .expect("build");
        assert!(matches!(node.start(), Err(NetworkError::Config(_))));
        assert!(!node.listening);
    }

    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "two-node integration: heartbeat attestation over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn heartbeats_carry_a_checked_attestation_between_two_nodes() {
        use super::super::por::tests::{JwksServer, claims, header, jwks_json, sign};
        use super::super::por::{AttestationStatus, DEFAULT_ISSUER, TrustAnchor};
        let issuer = libp2p::identity::ed25519::Keypair::generate();
        let server = JwksServer::serve(jwks_json(&issuer, "k1", ""));
        let anchors = vec![TrustAnchor { iss: DEFAULT_ISSUER.into(), jwks_url: server.url.clone() }];
        let dir = tempfile::tempdir().expect("temp dir");

        let mut a = Node::with_keypair_path(cfg(0), dir.path().join("a.id"))
            .expect("build")
            .with_heartbeat_interval(Duration::from_secs(2));
        let iat = wall_clock_ms() / 1000 - 60;
        a.set_attestation(Some(sign(&issuer, &header("k1"), &claims(&a.local_peer_id().0, iat)))).expect("attest");
        a.start().expect("start");
        let a_addr = a.listen_addrs()[0].clone();
        let c = NetworkConfig { bootstrap_peers: vec![a_addr], trust_anchors: anchors, ..cfg(0) };
        let mut b = Node::with_keypair_path(c, dir.path().join("b.id"))
            .expect("build")
            .with_heartbeat_interval(Duration::from_secs(2));
        b.start().expect("start");

        let a_id = a.local_peer_id().0;
        let b_id = b.local_peer_id().0;
        assert!(
            wait_until(30, || b.peer_attestation(&a_id).is_some_and(|p| p.status == AttestationStatus::Valid)),
            "B must see A as registered (A: {:?}, stats {:?}, JWKS fetches {})",
            b.peer_attestation(&a_id),
            b.heartbeat_stats(),
            server.hits.load(Ordering::Relaxed)
        );
        let seen = b.peer_attestation(&a_id).unwrap();
        assert_eq!(seen.iss.as_deref(), Some(DEFAULT_ISSUER));
        assert_eq!(seen.forged, 0);
        assert!(
            wait_until(20, || a.peer_attestation(&b_id).is_some()),
            "A must hear B's anonymous heartbeat too"
        );
        assert_eq!(a.peer_attestation(&b_id).unwrap().status, AttestationStatus::None);
        assert_eq!(server.hits.load(Ordering::Relaxed), 1, "keys are fetched once and cached");
        assert!(dir.path().join("jwks-cache.json").exists(), "and kept on disk for offline restarts");
        assert!(
            !b.received_messages().iter().any(|m| m.topic == HEARTBEATS_TOPIC),
            "heartbeats are not surfaced as gossip messages"
        );
        assert_eq!(b.invalid_message_count(), 0);
    }

    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "two-node integration: peer scores over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn peer_scores_follow_registration_between_two_nodes() {
        use super::super::por::tests::{JwksServer, claims, header, jwks_json, sign};
        use super::super::por::{DEFAULT_ISSUER, REGISTERED_BONUS, TrustAnchor};
        let issuer = libp2p::identity::ed25519::Keypair::generate();
        let server = JwksServer::serve(jwks_json(&issuer, "k1", ""));
        let anchors = vec![TrustAnchor { iss: DEFAULT_ISSUER.into(), jwks_url: server.url.clone() }];
        let dir = tempfile::tempdir().expect("temp dir");
        let mut a = Node::with_keypair_path(NetworkConfig { trust_anchors: anchors.clone(), ..cfg(0) }, dir.path().join("a.id"))
            .expect("build")
            .with_heartbeat_interval(Duration::from_secs(2));
        let iat = wall_clock_ms() / 1000 - 60;
        a.set_attestation(Some(sign(&issuer, &header("k1"), &claims(&a.local_peer_id().0, iat)))).expect("attest");
        a.start().expect("start");
        let c = NetworkConfig { bootstrap_peers: vec![a.listen_addrs()[0].clone()], trust_anchors: anchors, ..cfg(0) };
        let mut b = Node::with_keypair_path(c, dir.path().join("b.id"))
            .expect("build")
            .with_heartbeat_interval(Duration::from_secs(2));
        b.start().expect("start");
        let (a_id, b_id) = (a.local_peer_id().0, b.local_peer_id().0);
        assert!(
            wait_until(30, || b.peer_score(&a_id) == Some(REGISTERED_BONUS)),
            "B must score registered A at +20 (score {:?}, A: {:?})",
            b.peer_score(&a_id),
            b.peer_attestation(&a_id)
        );
        assert!(
            wait_until(20, || a.peer_attestation(&b_id).is_some()),
            "A must hear B's anonymous heartbeat"
        );
        assert_eq!(a.peer_score(&b_id), Some(0.0), "anonymous: a full participant at 0");
        assert_eq!(b.peer_score("12D3KooWNotConnected"), None);
    }

    #[test]
    #[cfg_attr(
        not(feature = "p2p-integration"),
        ignore = "cross-layer: the Cloud issuer's code under Deno, two nodes over loopback — enable the p2p-integration feature or run with --ignored"
    )]
    fn cross_layer_a_node_registered_by_the_real_issuer_is_seen_as_registered() {
        use super::super::por::tests::DenoIssuer;
        use super::super::por::{AttestationStatus, DEFAULT_ISSUER, TrustAnchor};
        let dir = tempfile::tempdir().expect("temp dir");
        let mut a = Node::with_keypair_path(cfg(0), dir.path().join("a.id"))
            .expect("build")
            .with_heartbeat_interval(Duration::from_secs(2));
        let a_id = a.local_peer_id().0;
        let Some(issuer) = DenoIssuer::start(&a_id, "12D3KooWDoesNotMatterHere") else { return };
        a.set_attestation(Some(issuer.token("valid"))).expect("attest");
        a.start().expect("start");
        let anchors = vec![TrustAnchor { iss: DEFAULT_ISSUER.into(), jwks_url: issuer.url.clone() }];
        let c = NetworkConfig { bootstrap_peers: vec![a.listen_addrs()[0].clone()], trust_anchors: anchors, ..cfg(0) };
        let mut b = Node::with_keypair_path(c, dir.path().join("b.id")).expect("build");
        b.start().expect("start");
        assert!(
            wait_until(30, || b.peer_attestation(&a_id).is_some_and(|p| p.status == AttestationStatus::Valid)),
            "B must see A as registered (A: {:?}, stats {:?})",
            b.peer_attestation(&a_id),
            b.heartbeat_stats()
        );
        assert_eq!(b.peer_attestation(&a_id).unwrap().sub.as_deref(), Some(issuer.sub.as_str()));
    }
}
