//! Adversarial suite: attacks a real node over loopback libp2p and asserts the
//! Cloud-independent defences hold (RFC §8), on the frozen wire format v1.
//! Each scenario has an attacker node publish hostile traffic to a victim,
//! plus a control message from the same attacker that MUST still get through
//! — so a scenario cannot pass merely because nothing was delivered at all.
//!
//! Run with `cargo test -p rotifer-core --features p2p-integration --lib
//! adversarial -- --test-threads=1`.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::messages::{encode_announcement, ANNOUNCEMENTS_TOPIC};
use super::node::Node;
use super::security::RATE_LIMIT_PER_PEER_PER_SEC;
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

fn announcement(gene_id: &str, timestamp_ms: u64) -> GeneAnnouncement {
    GeneAnnouncement {
        gene_id: gene_id.into(),
        name: "attacker-gene".into(),
        domain: "test".into(),
        fidelity: "Wrapped".into(),
        ir_spec: String::new(),
        version: "1.0.0".into(),
        timestamp_ms,
    }
}

/// A started node with its own throwaway identity, optionally dialing peers.
fn spawn(dir: &tempfile::TempDir, name: &str, bootstrap: Vec<String>) -> Node {
    spawn_with(dir, name, bootstrap, None)
}

/// As [`spawn`], optionally capping inbound connections (0 = dial-out only).
fn spawn_with(dir: &tempfile::TempDir, name: &str, bootstrap: Vec<String>, max_incoming: Option<u32>) -> Node {
    let cfg = NetworkConfig {
        listen_port: 0,
        enabled: true,
        bootstrap_peers: bootstrap,
        ..Default::default()
    };
    let mut node = Node::with_keypair_path(cfg, dir.path().join(format!("{name}.pem")))
        .expect("build node");
    if let Some(max) = max_incoming {
        node = node.with_max_established_incoming(max);
    }
    node.start().expect("start node");
    node.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    node
}

fn addr(node: &Node) -> String {
    node.listen_addrs().into_iter().next().expect("listen addr")
}

fn has(node: &Node, gene_id: &str) -> bool {
    node.received_announcements().iter().any(|(a, _)| a.gene_id == gene_id)
}

/// Keep publishing a control announcement from `from` until `to` surfaces it.
fn await_control(from: &Node, to: &Node, label: &str) {
    let control = id(label);
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let _ = from.publish(ANNOUNCEMENTS_TOPIC, &encode_announcement(&announcement(&control, now_ms())));
        if has(to, &control) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("control announcement '{label}' not received within 20s");
}

/// Victim + attacker connected on the announcements topic, mesh proven formed.
fn victim_and_attacker(dir: &tempfile::TempDir) -> (Node, Node) {
    let victim = spawn(dir, "victim", vec![]);
    let attacker = spawn(dir, "attacker", vec![addr(&victim)]);
    await_control(&attacker, &victim, "control");
    (victim, attacker)
}

/// Publish `payload`, then a probe from the same attacker. Once the probe has
/// arrived, report whether `gene_id` was surfaced — so "not delivered" means
/// rejected, not lost.
fn delivered(victim: &Node, attacker: &Node, gene_id: &str, payload: &[u8]) -> bool {
    attacker.publish(ANNOUNCEMENTS_TOPIC, payload).expect("publish");
    await_control(attacker, victim, &format!("probe-after-{gene_id}"));
    has(victim, gene_id)
}

// ---------------------------------------------------------------------
// ADV-1 — impersonation is structurally impossible: the wire has no
// publisher field, and what the victim reports is the authenticated source
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_1_publisher_is_always_the_authenticated_source() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    let attacker_id = attacker.local_peer_id().0;
    for (ann, publisher) in victim.received_announcements() {
        assert_eq!(publisher, attacker_id, "announcement {} attributed to someone else", ann.gene_id);
    }
}

// ---------------------------------------------------------------------
// ADV-2 — a directory name instead of a v2 ID is rejected and counted
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_2_non_content_id_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    let squat = encode_announcement(&announcement("someone-elses-gene", now_ms()));
    assert!(!delivered(&victim, &attacker, "someone-elses-gene", &squat));
    assert!(victim.invalid_message_count() > 0, "the rejection must be counted");
}

// ---------------------------------------------------------------------
// ADV-3 — replay of a stale announcement (outside the ±300 s window)
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_3_stale_announcement_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    let stale = id("stale");
    let payload = encode_announcement(&announcement(&stale, now_ms() - 3_600_000));
    assert!(!delivered(&victim, &attacker, &stale, &payload));
}

// ---------------------------------------------------------------------
// ADV-4 — far-future timestamp (pre-dated to outlive the window)
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_4_future_dated_announcement_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    let future = id("future");
    let payload = encode_announcement(&announcement(&future, now_ms() + 3_600_000));
    assert!(!delivered(&victim, &attacker, &future, &payload));
}

// ---------------------------------------------------------------------
// ADV-5 — malformed and legacy-JSON payloads neither crash nor surface
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_5_malformed_payload_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    let before = victim.received_announcements().len();
    attacker.publish(ANNOUNCEMENTS_TOPIC, b"\xff\xff\xffnot-protobuf").expect("publish");
    let legacy = br#"{"gene_id":"x","name":"x","domain":"d","version":"1","fidelity":"Native","publisher":"p","reputation_score":0,"timestamp":1}"#;
    attacker.publish(ANNOUNCEMENTS_TOPIC, legacy).expect("publish");
    await_control(&attacker, &victim, "probe-after-garbage");
    // Only the probe was added.
    assert_eq!(victim.received_announcements().len(), before + 1);
}

// ---------------------------------------------------------------------
// ADV-6 — flood from one identity is capped by the per-peer limit
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_6_single_identity_flood_is_rate_limited() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    // Let the window that carried the mesh-forming controls expire.
    std::thread::sleep(Duration::from_millis(1500));
    let before = victim.received_messages().len();
    let burst = 10 * RATE_LIMIT_PER_PEER_PER_SEC as usize;
    for i in 0..burst {
        let payload = encode_announcement(&announcement(&id(&format!("flood-{i}")), now_ms()));
        attacker.publish(ANNOUNCEMENTS_TOPIC, &payload).expect("publish");
    }
    std::thread::sleep(Duration::from_secs(3));
    let accepted = victim.received_messages().len() - before;
    assert!(victim.rate_limited_count() > 0, "a {burst}-message burst must trip the limiter");
    // The burst lands within ~1–2 sliding windows; allow two windows' worth.
    assert!(
        accepted <= 2 * RATE_LIMIT_PER_PEER_PER_SEC as usize,
        "accepted {accepted} of {burst}; the per-peer ceiling is {RATE_LIMIT_PER_PEER_PER_SEC}/s"
    );
}

// ---------------------------------------------------------------------
// ADV-7 — validation happens before forwarding: an invalid announcement
// stops at the first honest relay (attacker → relay → far node)
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_7_invalid_announcement_is_not_relayed() {
    let dir = tempfile::tempdir().unwrap();
    // Neither the far node nor the attacker accepts inbound connections, and
    // each dials only the relay — so the relay is the only path between them
    // (checked below), and what reaches the far node was forwarded by it.
    let relay = spawn(&dir, "relay", vec![]);
    let far = spawn_with(&dir, "far", vec![addr(&relay)], Some(0));
    let attacker = spawn_with(&dir, "attacker", vec![addr(&relay)], Some(0));
    // Valid traffic from the attacker reaches the far node through the relay.
    await_control(&attacker, &relay, "control-relay");
    await_control(&attacker, &far, "control-far");

    let stale = id("stale-relayed");
    let payload = encode_announcement(&announcement(&stale, now_ms() - 3_600_000));
    attacker.publish(ANNOUNCEMENTS_TOPIC, &payload).expect("publish");
    await_control(&attacker, &far, "probe-after-stale");

    assert!(relay.invalid_message_count() > 0, "the relay must reject it");
    assert!(!has(&far, &stale), "the far node must not surface it");
    assert!(
        !far.identified_peers().contains(&attacker.local_peer_id().0),
        "precondition: the far node must not be peered with the attacker directly"
    );
    assert!(
        far.invalid_message_count() == 0,
        "the far node is not peered with the attacker, so the stale message can only \
         have reached it through the relay — which must not forward it"
    );
}

// ---------------------------------------------------------------------
// ADV-8 — topics no validator is registered for, including the pre-freeze
// JSON topic: ignored, so neither delivered, relayed, nor held against the
// sender (ADR-340 D3: Ignore = "do not accept, do not penalize"; D6: the old
// topic is neither read nor written; RFC §6.4: validate before forwarding)
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_8_unregistered_topic_is_not_relayed_nor_penalized() {
    // The topic npm 0.9.0–0.26.x nodes publish JSON on (ADR-340 D6), and a
    // versioned topic that simply has no validator yet.
    const LEGACY: &str = "/rotifer/announcements";
    const UNREGISTERED: &str = "/rotifer/p2p/1/unregistered";
    let legacy_json = br#"{"gene_id":"legacy-dir-name","name":"legacy","domain":"test","fidelity":"Native"}"#;
    let dir = tempfile::tempdir().unwrap();
    // Same shape as ADV-7: the relay is the only path from sender to far node.
    // `Node::publish` refuses both topics, so the sender is a plain libp2p
    // swarm, as an old JSON node or a hostile one would be.
    let relay = spawn(&dir, "relay", vec![]);
    let far = spawn_with(&dir, "far", vec![addr(&relay)], Some(0));
    // Everyone subscribes, so a relay that accepted these would forward them.
    for node in [&relay, &far] {
        node.subscribe(LEGACY).expect("subscribe");
        node.subscribe(UNREGISTERED).expect("subscribe");
    }
    let sender = RawSender::spawn(
        &addr(&relay),
        vec![(LEGACY, legacy_json.to_vec()), (UNREGISTERED, b"unvalidated".to_vec())],
    );
    await_raw_control(&relay, &sender, 0);
    await_raw_control(&far, &sender, 0);

    // Keep publishing across several gossip heartbeats, under the per-peer
    // rate limit (three messages per 400 ms round).
    std::thread::sleep(Duration::from_secs(5));
    // Not penalized: the same sender's valid traffic still goes through the relay.
    await_raw_control(&far, &sender, sender.round());
    let sender_id = sender.peer_id.clone();
    drop(sender);

    for topic in [LEGACY, UNREGISTERED] {
        assert!(
            !far.received_messages().iter().any(|m| m.topic == topic),
            "the relay must not forward a message on {topic}"
        );
        assert!(
            !relay.received_messages().iter().any(|m| m.topic == topic),
            "the relay must not deliver a message on {topic}"
        );
    }
    assert_eq!(far.unregistered_topic_count(), 0, "nothing on an unregistered topic reaches the far node");
    assert!(relay.unregistered_topic_count() > 0, "the relay received them and ignored them");
    assert_eq!(relay.invalid_message_count(), 0, "ignored, not rejected: the sender is not penalized");
    assert_eq!(relay.rate_limited_count(), 0, "precondition: nothing was dropped by the flood limit instead");
    assert!(
        !far.identified_peers().contains(&sender_id),
        "precondition: the far node must not be peered with the sender directly"
    );
}

/// A sender that is not a `Node`: plain libp2p GossipSub + Identify, as an old
/// JSON-era node or a hostile one would be. `Node::publish` refuses topics with
/// no validator, so this is the only way such traffic reaches a Rotifer node.
/// It identifies as Rotifer so the Identify guard keeps the connection, dials
/// `relay` only, never listens, and publishes every 400 ms until `stop`:
/// each of `noise`, then a fresh valid announcement whose ID is
/// `raw-control-<round>`. `round` counts finished rounds.
struct RawSender {
    peer_id: String,
    round: std::sync::Arc<std::sync::atomic::AtomicU32>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RawSender {
    fn spawn(relay: &str, noise: Vec<(&'static str, Vec<u8>)>) -> Self {
        use libp2p::futures::StreamExt;
        use libp2p::{gossipsub, identify, swarm::NetworkBehaviour, Multiaddr};
        use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
        use std::sync::Arc;

        #[derive(NetworkBehaviour)]
        struct Raw {
            gossipsub: gossipsub::Behaviour,
            identify: identify::Behaviour,
        }

        let relay: Multiaddr = relay.parse().expect("relay multiaddr");
        let key = libp2p::identity::Keypair::generate_ed25519();
        let peer_id = key.public().to_peer_id().to_string();
        let round = Arc::new(AtomicU32::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let (round_t, stop_t) = (Arc::clone(&round), Arc::clone(&stop));
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
                    .with_behaviour(|key| Raw {
                        gossipsub: gossipsub::Behaviour::new(
                            gossipsub::MessageAuthenticity::Signed(key.clone()),
                            gossipsub::Config::default(),
                        )
                        .expect("gossipsub"),
                        identify: identify::Behaviour::new(identify::Config::new(
                            "/rotifer/p2p/1".into(),
                            key.public(),
                        )),
                    })
                    .expect("behaviour")
                    .build();
                let topics: Vec<&str> = noise.iter().map(|(t, _)| *t).chain([ANNOUNCEMENTS_TOPIC]).collect();
                for t in &topics {
                    swarm.behaviour_mut().gossipsub.subscribe(&gossipsub::IdentTopic::new(*t)).expect("subscribe");
                }
                swarm.dial(relay).expect("dial relay");
                let mut tick = tokio::time::interval(Duration::from_millis(400));
                while !stop_t.load(Ordering::Relaxed) {
                    tokio::select! {
                        _ = tick.tick() => {
                            let n = round_t.load(Ordering::Relaxed);
                            for (t, data) in &noise {
                                let _ = swarm.behaviour_mut().gossipsub.publish(gossipsub::IdentTopic::new(*t), data.clone());
                            }
                            let control = encode_announcement(&announcement(&id(&format!("raw-control-{n}")), now_ms()));
                            let _ = swarm.behaviour_mut().gossipsub.publish(gossipsub::IdentTopic::new(ANNOUNCEMENTS_TOPIC), control);
                            round_t.store(n + 1, Ordering::Relaxed);
                        }
                        _ = swarm.select_next_some() => {}
                    }
                }
            });
        });
        Self { peer_id, round, stop, thread: Some(thread) }
    }

    fn round(&self) -> u32 {
        self.round.load(std::sync::atomic::Ordering::Relaxed)
    }
}

impl Drop for RawSender {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

/// Wait until `node` surfaces a `raw-control-<n>` announcement with `n >= from`.
fn await_raw_control(node: &Node, sender: &RawSender, from: u32) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if (from..sender.round()).any(|n| has(node, &id(&format!("raw-control-{n}")))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("no raw-control announcement from round {from} on reached the node within 20s");
}
