//! A1-2 attack report (protocol v0.9.5 plan §3.1 A1, "A1-2 报告范围"):
//! three attacks run against real nodes over loopback. Each test prints the
//! numbers the report quotes, on lines starting `A1-2`.
//!
//! - Forged announcements: content self-verification only (P2P RFC §7.1
//!   rule 1). Under wire v1 the publisher is the GossipSub-authenticated
//!   source (ADR-340 D3).
//! - Eclipse: local bootstrap nodes only (ADR-313 D1); routing-table spread
//!   and outbound share (P2P RFC §8.5 items 2 and 3).
//! - Sybil: how many nodes of one account get +20 at a receiver, and where
//!   the rest of them still get in (mesh, DHT routing table).
//!
//! Cloud cross-verification (P2P RFC §8.5 item 4) is not tested here: it is
//! deferred to v1.0 (v1.0 plan, release checklist item 43).
//!
//! Run with `cargo test -p rotifer-core --features p2p-integration --lib
//! attack_a1_2 -- --test-threads=1 --nocapture`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::discover::{SearchOutcome, SearchQuery};
use super::gene_record::{encode_announcement_message, record_key, sign_record, WireGeneRecord};
use super::messages::{encode_announcement, ANNOUNCEMENTS_TOPIC};
use super::node::Node;
use super::{GeneAnnouncement, NetworkConfig};

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A syntactically valid v2 ID, distinct per label.
fn id(label: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("v2:{}", hex::encode(Sha256::digest(label.as_bytes())))
}

fn announcement(gene_id: &str, name: &str) -> GeneAnnouncement {
    GeneAnnouncement {
        gene_id: gene_id.into(),
        name: name.into(),
        domain: "test".into(),
        fidelity: "Wrapped".into(),
        ir_spec: String::new(),
        version: "1.0.0".into(),
        timestamp_ms: now_ms(),
    }
}

fn eventually(secs: u64, mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    check()
}

fn config(bootstrap: Vec<String>) -> NetworkConfig {
    NetworkConfig { listen_port: 0, enabled: true, bootstrap_peers: bootstrap, ..Default::default() }
}

/// A started node with its own throwaway identity, dialing `bootstrap`.
fn spawn(dir: &tempfile::TempDir, name: &str, bootstrap: Vec<String>) -> Node {
    let mut node = Node::with_keypair_path(config(bootstrap), dir.path().join(format!("{name}.pem"))).expect("build node");
    node.start().expect("start node");
    node.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    node
}

fn addr(node: &Node) -> String {
    node.listen_addrs().into_iter().next().expect("listen addr")
}

fn peer_of(node: &Node) -> libp2p::PeerId {
    node.local_peer_id().0.parse().expect("PeerId")
}

fn gene_search(node: &Node, gene: &str) -> SearchOutcome {
    node.search(SearchQuery::GeneId(gene.into())).expect("search")
}

fn heard(node: &Node, gene: &str) -> bool {
    node.received_announcements().iter().any(|(a, _)| a.gene_id == gene)
}

// ---------------------------------------------------------------------
// A raw attacker: plain libp2p (Kademlia on Rotifer's protocol name,
// Identify as a Rotifer node, GossipSub on the announcements topic) with
// none of the node's rules, so it can send what a `Node` never would.

/// How the raw attacker authors its GossipSub messages.
enum Authorship {
    /// Signed with its own key, as libp2p does by default.
    Signed,
    /// Unsigned, claiming another peer as the author (impersonation).
    Claiming(libp2p::PeerId),
}

enum RawCmd {
    /// Send a record straight to the victim (a Kademlia PUT).
    Put(libp2p::kad::Record),
    /// Publish on the announcements topic.
    Publish(Vec<u8>),
}

struct Raw {
    peer_id: libp2p::PeerId,
    key: libp2p::identity::Keypair,
    tx: tokio::sync::mpsc::UnboundedSender<RawCmd>,
    connected: Arc<AtomicBool>,
    /// The victim has told it that it is subscribed to the announcements topic.
    victim_subscribed: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Raw {
    fn spawn(victim: &Node, authorship: Authorship) -> Self {
        use libp2p::futures::StreamExt;
        use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
        use libp2p::{gossipsub, identify, kad, Multiaddr, StreamProtocol};

        #[derive(NetworkBehaviour)]
        struct Behaviour {
            kademlia: kad::Behaviour<kad::store::MemoryStore>,
            identify: identify::Behaviour,
            gossipsub: gossipsub::Behaviour,
        }

        let key = libp2p::identity::Keypair::generate_ed25519();
        let peer_id = key.public().to_peer_id();
        let victim_addr: Multiaddr = addr(victim).parse().expect("victim multiaddr");
        let victim_id = peer_of(victim);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<RawCmd>();
        let connected = Arc::new(AtomicBool::new(false));
        let victim_subscribed = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (connected_t, subscribed_t, stop_t, key_t) =
            (Arc::clone(&connected), Arc::clone(&victim_subscribed), Arc::clone(&stop), key.clone());
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().expect("runtime");
            rt.block_on(async move {
                let mut swarm = libp2p::SwarmBuilder::with_existing_identity(key_t)
                    .with_tokio()
                    .with_tcp(libp2p::tcp::Config::default(), libp2p::noise::Config::new, libp2p::yamux::Config::default)
                    .expect("tcp")
                    .with_behaviour(|key| {
                        let id = key.public().to_peer_id();
                        let mut config = kad::Config::new(StreamProtocol::new(super::gene_record::KAD_PROTOCOL));
                        config.set_max_packet_size(1 << 20);
                        let mut kademlia = kad::Behaviour::with_config(id, kad::store::MemoryStore::new(id), config);
                        kademlia.set_mode(Some(kad::Mode::Server));
                        // An unsigned author needs a non-strict mode for its
                        // own inbound side; what it sends is unaffected.
                        let (authenticity, mode) = match authorship {
                            Authorship::Signed => (gossipsub::MessageAuthenticity::Signed(key.clone()), gossipsub::ValidationMode::Strict),
                            Authorship::Claiming(other) => (gossipsub::MessageAuthenticity::Author(other), gossipsub::ValidationMode::Permissive),
                        };
                        let gossip_config = gossipsub::ConfigBuilder::default().validation_mode(mode).build().expect("gossip config");
                        Behaviour {
                            kademlia,
                            identify: identify::Behaviour::new(identify::Config::new("/rotifer/p2p/1".into(), key.public())),
                            gossipsub: gossipsub::Behaviour::new(authenticity, gossip_config).expect("gossipsub"),
                        }
                    })
                    .expect("behaviour")
                    .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
                    .build();
                swarm.behaviour_mut().kademlia.add_address(&victim_id, victim_addr.clone());
                swarm.listen_on("/ip4/127.0.0.1/tcp/0".parse().unwrap()).expect("listen");
                swarm
                    .behaviour_mut()
                    .gossipsub
                    .subscribe(&gossipsub::IdentTopic::new(ANNOUNCEMENTS_TOPIC))
                    .expect("subscribe");
                let mut tick = tokio::time::interval(Duration::from_millis(100));
                while !stop_t.load(Ordering::Relaxed) {
                    tokio::select! {
                        _ = tick.tick() => {
                            if !swarm.is_connected(&victim_id) {
                                let _ = swarm.dial(victim_addr.clone());
                            }
                        }
                        Some(cmd) = rx.recv() => match cmd {
                            RawCmd::Put(record) => {
                                swarm.behaviour_mut().kademlia.put_record_to(record, std::iter::once(victim_id), kad::Quorum::One);
                            }
                            RawCmd::Publish(data) => {
                                let _ = swarm.behaviour_mut().gossipsub.publish(gossipsub::IdentTopic::new(ANNOUNCEMENTS_TOPIC), data);
                            }
                        },
                        event = swarm.select_next_some() => match event {
                            SwarmEvent::ConnectionEstablished { peer_id, .. } if peer_id == victim_id => {
                                connected_t.store(true, Ordering::Relaxed);
                            }
                            SwarmEvent::ConnectionClosed { peer_id, num_established: 0, .. } if peer_id == victim_id => {
                                connected_t.store(false, Ordering::Relaxed);
                            }
                            SwarmEvent::Behaviour(BehaviourEvent::Gossipsub(gossipsub::Event::Subscribed { peer_id, .. }))
                                if peer_id == victim_id =>
                            {
                                subscribed_t.store(true, Ordering::Relaxed);
                            }
                            _ => {}
                        },
                    }
                }
            });
        });
        let raw = Self { peer_id, key, tx, connected, victim_subscribed, stop, thread: Some(thread) };
        assert!(eventually(10, || raw.connected.load(Ordering::Relaxed)), "the raw attacker did not connect");
        raw
    }

    fn put(&self, record: libp2p::kad::Record) {
        self.tx.send(RawCmd::Put(record)).expect("raw attacker running");
    }

    fn publish(&self, data: Vec<u8>) {
        self.tx.send(RawCmd::Publish(data)).expect("raw attacker running");
    }

    /// A valid record for `ann`, signed by this attacker under its own key.
    fn record(&self, ann: &GeneAnnouncement) -> libp2p::kad::Record {
        let value = sign_record(&self.key, &encode_announcement_message(ann)).expect("sign");
        libp2p::kad::Record::new(record_key(&ann.gene_id, &self.peer_id), value)
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn decode(value: &[u8]) -> WireGeneRecord {
    use prost::Message as _;
    WireGeneRecord::decode(value).expect("record")
}

fn encode(record: &WireGeneRecord) -> Vec<u8> {
    use prost::Message as _;
    record.encode_to_vec()
}

// ---------------------------------------------------------------------
// Attack 1a — forged DHT records (GeneRecord v1). Every form is sent by a
// raw attacker straight to the victim, after a valid record of its own has
// proven the path. Refused means: counted as rejected, not in the victim's
// store, and not returned by a search on the victim or on a node whose only
// DHT peer is the victim.
// ---------------------------------------------------------------------

/// One way to forge a record, given the attacker and the gene it targets.
struct Forgery {
    label: &'static str,
    /// Counted as a forgery (held against the sender), not just rejected.
    forgery: bool,
    /// The forged record, and the gene IDs a search must not return from
    /// the attacker.
    build: fn(&Raw, &str) -> (libp2p::kad::Record, Vec<String>),
}

fn forgeries() -> Vec<Forgery> {
    vec![
        Forgery {
            // Fields changed after signing (name, and a Native claim): the
            // signature no longer covers them.
            label: "tampered-field",
            forgery: true,
            build: |raw, gene| {
                let real = raw.record(&announcement(gene, "honest-name"));
                let mut wire = decode(&real.value);
                let mut tampered = announcement(gene, "tampered-name");
                tampered.fidelity = "Native".into();
                tampered.ir_spec = "1.0".into();
                wire.announcement = encode_announcement_message(&tampered);
                (libp2p::kad::Record::new(real.key, encode(&wire)), vec![gene.into()])
            },
        },
        Forgery {
            // Signed by another key while naming the attacker as publisher.
            label: "wrong-signer",
            forgery: true,
            build: |raw, gene| {
                let other = libp2p::identity::Keypair::generate_ed25519();
                let ann = encode_announcement_message(&announcement(gene, "wrong-signer"));
                let mut wire = decode(&sign_record(&other, &ann).expect("sign"));
                wire.publisher = raw.peer_id.to_bytes();
                (libp2p::kad::Record::new(record_key(gene, &raw.peer_id), encode(&wire)), vec![gene.into()])
            },
        },
        Forgery {
            // A valid record of someone else's, filed under the attacker's key.
            label: "publisher-not-the-key",
            forgery: true,
            build: |raw, gene| {
                let other = libp2p::identity::Keypair::generate_ed25519();
                let ann = encode_announcement_message(&announcement(gene, "someone-else"));
                let value = sign_record(&other, &ann).expect("sign");
                (libp2p::kad::Record::new(record_key(gene, &raw.peer_id), value), vec![gene.into()])
            },
        },
        Forgery {
            // The ID in the key is not the ID of the content the record
            // describes: signed correctly, filed under another gene.
            label: "gene-id-mismatch",
            forgery: false,
            build: |raw, gene| {
                let other_gene = id(&format!("{gene}-content"));
                let value = sign_record(&raw.key, &encode_announcement_message(&announcement(&other_gene, "mismatch")))
                    .expect("sign");
                (libp2p::kad::Record::new(record_key(gene, &raw.peer_id), value), vec![gene.into(), other_gene])
            },
        },
        Forgery {
            // Not a content ID at all: a gene name where the v2 ID goes.
            label: "not-a-content-id",
            forgery: false,
            build: |raw, gene| {
                let squat = "hello-world";
                let value =
                    sign_record(&raw.key, &encode_announcement_message(&announcement(squat, "squat"))).expect("sign");
                let key = format!("{}{squat}/{}", super::gene_record::KEY_PREFIX, raw.peer_id).into_bytes();
                (libp2p::kad::Record::new(key, value), vec![gene.into()])
            },
        },
    ]
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A1-2 attack — enable the p2p-integration feature or run with --ignored")]
fn a1_2_forged_dht_records_are_refused_unstored_and_unfindable() {
    let dir = tempfile::tempdir().unwrap();
    let victim = spawn(&dir, "victim", vec![]);
    let searcher = spawn(&dir, "searcher", vec![addr(&victim)]);
    let victim_id = victim.local_peer_id().0;
    assert!(eventually(10, || searcher.dht_peers().contains(&victim_id)), "searcher reaches the victim's DHT");

    let mut refused = 0;
    let forms = forgeries();
    for form in &forms {
        let raw = Raw::spawn(&victim, Authorship::Signed);
        // Control: a valid record from the same attacker is stored.
        let control = raw.record(&announcement(&id(&format!("control-{}", form.label)), "control"));
        raw.put(control.clone());
        assert!(
            eventually(15, || victim.local_dht(control.key.as_ref()).unwrap().0.is_some()),
            "{}: the control record must be stored, or nothing is proven",
            form.label
        );
        let before = victim.dht_stats();
        let gene = id(&format!("forged-{}", form.label));
        let (forged, genes) = (form.build)(&raw, &gene);
        raw.put(forged.clone());
        assert!(
            eventually(15, || victim.dht_stats().rejected > before.rejected),
            "{}: the victim must judge the forged record (stats {:?})",
            form.label,
            victim.dht_stats()
        );
        let after = victim.dht_stats();
        let stored = victim.local_dht(forged.key.as_ref()).unwrap().0;
        let attacker = raw.peer_id.to_string();
        let found_on = |node: &Node| genes.iter().any(|g| gene_search(node, g).hits.iter().any(|h| h.publisher == attacker));
        let (on_victim, on_searcher) = (found_on(&victim), found_on(&searcher));
        println!(
            "A1-2 forged-dht form={} rejected+={} forgeries+={} stored={} found_on_victim={} found_on_searcher={}",
            form.label,
            after.rejected - before.rejected,
            after.forgeries - before.forgeries,
            stored.is_some(),
            on_victim,
            on_searcher
        );
        assert!(stored.is_none(), "{}: a forged record must not be stored", form.label);
        assert!(!on_victim && !on_searcher, "{}: a forged record must not be found", form.label);
        assert_eq!(after.forgeries - before.forgeries, u64::from(form.forgery), "{}: forgery or plain rejection", form.label);
        refused += 1;
    }
    println!("A1-2 forged-dht refused {refused}/{} forms", forms.len());
}

// ---------------------------------------------------------------------
// Attack 1b — forged gossip announcements. Field rules (§6.4) and the
// GossipSub signature (ADR-340 D3: the authenticated source is the
// publisher). Refused means: not surfaced, not returned by a search by ID
// or by keyword; a valid control from the same kind of attacker, published
// after it, gets through.
// ---------------------------------------------------------------------

/// Publish valid controls from `raw` until the victim has heard one.
fn await_control(victim: &Node, raw: &Raw, label: &str) {
    let gene = id(label);
    let ok = eventually(20, || {
        raw.publish(encode_announcement(&announcement(&gene, "control")));
        std::thread::sleep(Duration::from_millis(200));
        heard(victim, &gene)
    });
    assert!(ok, "control '{label}' must reach the victim, or nothing is proven");
}

/// Whether a search by `gene` or by the word `name` returns it.
fn found_anywhere(victim: &Node, gene: &str, name: &str) -> bool {
    let by_word = victim.search(SearchQuery::Keyword(name.into())).expect("keyword search");
    let by_id = if crate::gene_id::is_valid(gene) { gene_search(victim, gene).hits } else { Vec::new() };
    by_id.iter().chain(by_word.hits.iter()).any(|h| h.announcement.gene_id == gene || h.announcement.name == name)
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A1-2 attack — enable the p2p-integration feature or run with --ignored")]
fn a1_2_forged_gossip_announcements_are_refused_and_unfindable() {
    let dir = tempfile::tempdir().unwrap();
    let victim = spawn(&dir, "victim", vec![]);
    let raw = Raw::spawn(&victim, Authorship::Signed);
    assert!(eventually(10, || raw.victim_subscribed.load(Ordering::Relaxed)));
    await_control(&victim, &raw, "gossip-control-0");

    let gene = |label: &str| id(&format!("gossip-forged-{label}"));
    let upper = format!("v2:{}", gene("upper")[3..].to_uppercase());
    let forms: Vec<(&str, GeneAnnouncement)> = vec![
        ("name-instead-of-content-id", announcement("hello-world", "squata")),
        ("uppercase-hex-id", announcement(&upper, "squatb")),
        ("truncated-id", announcement(&gene("short")[..40], "squatc")),
        ("unknown-fidelity", GeneAnnouncement { fidelity: "Verified".into(), ..announcement(&gene("fid"), "squatd") }),
        ("wrapped-with-ir-spec", GeneAnnouncement { ir_spec: "1.0".into(), ..announcement(&gene("ir"), "squate") }),
        ("oversized-name", GeneAnnouncement { name: format!("squatf{}", "n".repeat(123)), ..announcement(&gene("name"), "") }),
        ("stale-replay", GeneAnnouncement { timestamp_ms: now_ms() - 301_000, ..announcement(&gene("stale"), "squatg") }),
    ];

    let invalid_before = victim.invalid_message_count();
    for (n, (label, ann)) in forms.iter().enumerate() {
        raw.publish(encode_announcement(ann));
        await_control(&victim, &raw, &format!("gossip-control-{}", n + 1));
        let surfaced = heard(&victim, &ann.gene_id);
        let found = found_anywhere(&victim, &ann.gene_id, &ann.name[..6]);
        println!("A1-2 forged-gossip form={label} surfaced={surfaced} found={found}");
        assert!(!surfaced && !found, "{label}: a forged announcement must be refused");
    }
    let invalid = victim.invalid_message_count() - invalid_before;
    println!("A1-2 forged-gossip rejected_and_counted={invalid} of {} forms", forms.len());
    assert_eq!(invalid, forms.len() as u64, "every form is rejected and counted, none silently ignored");

    // Impersonation: unsigned messages naming an honest peer as their
    // author. Signed controls from a raw attacker of the same build get
    // through before and after them.
    let honest = spawn(&dir, "honest", vec![addr(&victim)]);
    let honest_id = peer_of(&honest).to_string();
    let impostor = Raw::spawn(&victim, Authorship::Claiming(peer_of(&honest)));
    assert!(
        eventually(10, || impostor.victim_subscribed.load(Ordering::Relaxed)),
        "precondition: the impostor reaches the topic"
    );
    let target = gene("impersonated");
    for _ in 0..10 {
        impostor.publish(encode_announcement(&announcement(&target, "impersonated")));
        std::thread::sleep(Duration::from_millis(200));
    }
    await_control(&victim, &raw, "gossip-control-after-impersonation");
    let surfaced = heard(&victim, &target);
    let attributed = victim.received_announcements().iter().any(|(_, p)| *p == honest_id);
    let found = found_anywhere(&victim, &target, "impersonated");
    println!(
        "A1-2 forged-gossip form=claims-another-author sent=10 surfaced={surfaced} attributed_to_honest={attributed} found={found}"
    );
    assert!(!surfaced && !attributed && !found, "an unsigned message claiming another author must be dropped");
}

// ---------------------------------------------------------------------
// Attack 2 — Eclipse with local bootstrap nodes (ADR-313 D1: no official
// bootstrap is deployed). The attacker runs most of the victim's bootstrap
// nodes and a crowd of nodes behind them; honest nodes sit behind one
// honest bootstrap node. Measured on the victim, over time: who fills its
// routing table and in which k-buckets (§8.5 item 2), and how many of its
// connections it dialled itself (§8.5 item 3, "at least 50% outbound").
// The attacker's nodes run the stock node, so they answer queries
// honestly: an attacker that answers only with its own nodes does better
// than measured here.
// ---------------------------------------------------------------------

struct Eclipse {
    label: &'static str,
    honest: usize,
    attackers: usize,
    /// Of the victim's bootstrap nodes, how many the attacker runs (the
    /// victim also has one honest bootstrap node).
    attacker_bootstraps: usize,
    /// The attacker's nodes dial the victim as soon as it is up.
    dial_in: bool,
}

/// Index of the k-bucket `peer` falls in, seen from `me`.
fn bucket(me: &libp2p::PeerId, peer: &libp2p::PeerId) -> u32 {
    let (a, b) = (libp2p::kad::KBucketKey::from(*me), libp2p::kad::KBucketKey::from(*peer));
    a.distance(&b).ilog2().unwrap_or(0)
}

/// Run one Eclipse scenario and return the victim's final
/// (attacker share of the routing table, outbound share of connections,
/// whether it finds an honest node's gene).
fn run_eclipse(s: &Eclipse) -> (f64, f64, bool) {
    use std::collections::{BTreeMap, HashSet};
    let dir = tempfile::tempdir().unwrap();
    let honest_boot = spawn(&dir, "honest-boot", vec![]);
    let honest: Vec<Node> =
        (0..s.honest).map(|i| spawn(&dir, &format!("honest-{i}"), vec![addr(&honest_boot)])).collect();
    let first_boot = spawn(&dir, "attacker-boot-0", vec![]);
    let mut boots = vec![first_boot];
    for j in 1..s.attacker_bootstraps {
        let b = spawn(&dir, &format!("attacker-boot-{j}"), vec![addr(&boots[0])]);
        boots.push(b);
    }
    let attacker_addrs: Vec<String> = boots.iter().map(addr).collect();
    let mut attackers: Vec<Node> = Vec::new();
    if !s.dial_in {
        for i in 0..s.attackers {
            attackers.push(spawn(&dir, &format!("attacker-{i}"), vec![attacker_addrs[i % boots.len()].clone()]));
        }
    }
    // k-buckets hold 20 peers each, so a node does not keep every peer of a
    // large population: three quarters is enough to call it connected.
    assert!(
        eventually(60, || honest_boot.dht_peers().len() >= s.honest * 3 / 4),
        "the honest side must be connected first ({} of {})",
        honest_boot.dht_peers().len(),
        s.honest
    );
    // An honest node publishes a gene before the victim arrives.
    let gene = id(&format!("eclipse-{}", s.label));
    let publisher = peer_of(&honest[0]).to_string();
    let report = honest[0].announce(&announcement(&gene, "eclipse-target")).expect("announce");
    assert!(report.record_acked >= 1, "the honest gene is stored on the honest side: {report:?}");

    let mut victim_boot = attacker_addrs.clone();
    victim_boot.push(addr(&honest_boot));
    let victim = spawn(&dir, "victim", victim_boot);
    let me = peer_of(&victim);
    if s.dial_in {
        for i in 0..s.attackers {
            attackers.push(spawn(&dir, &format!("attacker-{i}"), vec![addr(&victim), attacker_addrs[i % boots.len()].clone()]));
        }
    }
    let attacker_ids: HashSet<String> =
        boots.iter().chain(attackers.iter()).map(|n| n.local_peer_id().0).collect();
    let honest_ids: HashSet<String> =
        std::iter::once(&honest_boot).chain(honest.iter()).map(|n| n.local_peer_id().0).collect();

    let started = Instant::now();
    let mut last = (0.0, 0.0);
    for at in [10u64, 30, 60] {
        let wait = Duration::from_secs(at).saturating_sub(started.elapsed());
        std::thread::sleep(wait);
        let table = victim.dht_peers();
        let (mut by_attacker, mut by_honest) = (0usize, 0usize);
        let mut buckets: BTreeMap<u32, (usize, usize)> = BTreeMap::new();
        for p in &table {
            let Ok(pid) = p.parse::<libp2p::PeerId>() else { continue };
            let entry = buckets.entry(bucket(&me, &pid)).or_default();
            if attacker_ids.contains(p) {
                by_attacker += 1;
                entry.0 += 1;
            } else if honest_ids.contains(p) {
                by_honest += 1;
                entry.1 += 1;
            }
        }
        let attacker_only = buckets.values().filter(|(a, h)| *a > 0 && *h == 0).count();
        let (inbound, outbound) = victim.connection_counts().expect("connection counts");
        let share = by_attacker as f64 / (by_attacker + by_honest).max(1) as f64;
        let out_share = outbound as f64 / (inbound + outbound).max(1) as f64;
        let per_bucket: Vec<String> = buckets.iter().map(|(b, (a, h))| format!("{b}:{a}a/{h}h")).collect();
        println!(
            "A1-2 eclipse scenario={} t={at}s table={} attacker={by_attacker} honest={by_honest} attacker_share={:.2} \
             buckets={} attacker_only_buckets={attacker_only} [{}] connections in={inbound} out={outbound} outbound_share={:.2}",
            s.label,
            table.len(),
            share,
            buckets.len(),
            per_bucket.join(" "),
            out_share
        );
        last = (share, out_share);
    }
    let found = gene_search(&victim, &gene).hits.iter().any(|h| h.publisher == publisher);
    println!("A1-2 eclipse scenario={} finds_honest_gene={found}", s.label);
    assert!(!victim.dht_peers().is_empty(), "the victim must have joined the DHT, or nothing was measured");
    (last.0, last.1, found)
}

/// Population of each scenario: 12 honest nodes behind 1 honest bootstrap
/// node, 36 attacker nodes behind the attacker's bootstrap nodes.
const ECLIPSE_HONEST: usize = 12;
const ECLIPSE_ATTACKERS: usize = 36;

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A1-2 attack — enable the p2p-integration feature or run with --ignored")]
fn a1_2_eclipse_attacker_runs_three_of_four_bootstraps() {
    run_eclipse(&Eclipse {
        label: "boot-3of4",
        honest: ECLIPSE_HONEST,
        attackers: ECLIPSE_ATTACKERS,
        attacker_bootstraps: 3,
        dial_in: false,
    });
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A1-2 attack — enable the p2p-integration feature or run with --ignored")]
fn a1_2_eclipse_attacker_runs_three_of_four_bootstraps_and_dials_in_first() {
    run_eclipse(&Eclipse {
        label: "boot-3of4+dial-in",
        honest: ECLIPSE_HONEST,
        attackers: ECLIPSE_ATTACKERS,
        attacker_bootstraps: 3,
        dial_in: true,
    });
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A1-2 attack — enable the p2p-integration feature or run with --ignored")]
fn a1_2_eclipse_control_attacker_runs_one_of_two_bootstraps() {
    run_eclipse(&Eclipse {
        label: "control-boot-1of2",
        honest: ECLIPSE_HONEST,
        attackers: ECLIPSE_ATTACKERS,
        attacker_bootstraps: 1,
        dial_in: false,
    });
}

/// Baseline without an attack: the same 48 nodes, all honest (the one
/// "attacker" bootstrap node has nobody behind it). Separates what the
/// attack does from what the network does anyway.
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A1-2 attack — enable the p2p-integration feature or run with --ignored")]
fn a1_2_eclipse_baseline_no_attacker() {
    run_eclipse(&Eclipse {
        label: "baseline-no-attack",
        honest: ECLIPSE_HONEST + ECLIPSE_ATTACKERS,
        attackers: 0,
        attacker_bootstraps: 1,
        dial_in: false,
    });
}
