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

// ---------------------------------------------------------------------
// ADV-9 — a heartbeat carrying a forged attestation (ADR-300 contract v2,
// R16/R17): the relay rejects it before forwarding and holds it against the
// authenticated source, which gets no registered standing
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_9_forged_attestation_is_rejected_and_not_relayed() {
    use super::heartbeat::{encode_heartbeat, HEARTBEATS_TOPIC};
    use super::por::tests::{claims, header, hb, jwks_json, sign};
    use super::por::{default_trust_anchors, AttestationStatus, Fetched, KeyStore};
    let dir = tempfile::tempdir().unwrap();
    // Every node here already holds the issuer's keys (a primed on-disk
    // cache), so the forgery is certain from the first heartbeat on.
    let issuer = libp2p::identity::ed25519::Keypair::generate();
    let anchors = default_trust_anchors();
    let mut store = KeyStore::load(Some(dir.path().join("jwks-cache.json")), &anchors);
    let job = store.request(&anchors[0], 0).expect("fetch job");
    let body = jwks_json(&issuer, "k1", "").into_bytes();
    store.finish(&job, Ok(Fetched { body, max_age_secs: None }), now_ms() / 1000, 0);

    // The attacker signs a token for its own PeerId with a key the issuer
    // never published, under the issuer's kid.
    let key = libp2p::identity::Keypair::generate_ed25519();
    let attacker = key.public().to_peer_id().to_string();
    let forger = libp2p::identity::ed25519::Keypair::generate();
    let token = sign(&forger, &header("k1"), &claims(&attacker, now_ms() / 1000 - 60));
    let heartbeat = encode_heartbeat(&hb(&token, now_ms()));

    let relay = spawn(&dir, "relay", vec![]);
    let far = spawn_with(&dir, "far", vec![addr(&relay)], Some(0));
    // The sender's path through the relay is proven before the forgery: one
    // forgery graylists it at the relay, so nothing of its gets through after.
    let sender = RawSender::spawn_gated(key, &addr(&relay), vec![(HEARTBEATS_TOPIC, heartbeat)], false);
    await_raw_control(&relay, &sender, 0);
    await_raw_control(&far, &sender, 0);
    sender.start_noise();
    let deadline = Instant::now() + Duration::from_secs(20);
    while relay.heartbeat_stats().forged == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
    }
    // A few more gossip rounds, so anything the relay forwarded would arrive,
    // and the relay's own path to the far node is still up.
    std::thread::sleep(Duration::from_secs(3));
    await_control(&relay, &far, "adv-9-relay-still-forwards");
    drop(sender);

    let seen = relay.peer_attestation(&attacker).expect("the relay records the source");
    assert!(seen.forged >= 1, "held against the authenticated source: {seen:?}");
    assert_ne!(seen.status, AttestationStatus::Valid, "no registered standing from a forged token");
    assert!(relay.invalid_message_count() >= 1, "rejected, not ignored");
    assert!(far.peer_attestation(&attacker).is_none(), "the forged heartbeat must not be relayed");
    assert_eq!(far.heartbeat_stats().forged, 0);
    assert!(
        !far.identified_peers().contains(&attacker),
        "precondition: the far node must not be peered with the sender directly"
    );
}

/// A node that trusts `anchors` (adversarial nodes otherwise run the defaults).
fn spawn_trusting(dir: &tempfile::TempDir, name: &str, anchors: Vec<super::por::TrustAnchor>) -> Node {
    let cfg = NetworkConfig { listen_port: 0, enabled: true, trust_anchors: anchors, ..Default::default() };
    let mut node = Node::with_keypair_path(cfg, dir.path().join(format!("{name}.pem"))).expect("build node");
    node.start().expect("start node");
    node.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    node
}

// ---------------------------------------------------------------------
// ADV-10 — one certain forgery graylists the source (ADR-300 contract v2,
// CEO 〔T-140〕 E7): its score drops below −80 and the relay drops
// everything it sends afterwards, valid or not
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_10_a_forger_is_graylisted() {
    use super::heartbeat::{encode_heartbeat, HEARTBEATS_TOPIC};
    use super::por::tests::{claims, header, hb, JwksServer, jwks_json, sign};
    use super::por::{Fetched, KeyStore, TrustAnchor, DEFAULT_ISSUER};
    let dir = tempfile::tempdir().unwrap();
    let issuer = libp2p::identity::ed25519::Keypair::generate();
    let server = JwksServer::serve(jwks_json(&issuer, "k1", ""));
    let anchors = vec![TrustAnchor { iss: DEFAULT_ISSUER.into(), jwks_url: server.url.clone() }];
    // The relay already holds the issuer's keys (a primed on-disk cache), so
    // the forgery is certain from the first heartbeat on.
    let mut store = KeyStore::load(Some(dir.path().join("jwks-cache.json")), &anchors);
    let job = store.request(&anchors[0], 0).expect("fetch job");
    let body = jwks_json(&issuer, "k1", "").into_bytes();
    store.finish(&job, Ok(Fetched { body, max_age_secs: None }), now_ms() / 1000, 0);
    let relay = spawn_trusting(&dir, "relay", anchors);
    let key = libp2p::identity::Keypair::generate_ed25519();
    let attacker = key.public().to_peer_id().to_string();
    let forged = sign(&libp2p::identity::ed25519::Keypair::generate(), &header("k1"), &claims(&attacker, now_ms() / 1000 - 60));
    let sender = RawSender::spawn_gated(key, &addr(&relay), vec![(HEARTBEATS_TOPIC, encode_heartbeat(&hb(&forged, now_ms())))], false);
    await_raw_control(&relay, &sender, 0);
    sender.start_noise();
    let deadline = Instant::now() + Duration::from_secs(20);
    while relay.peer_score(&attacker).is_none_or(|s| s >= -80.0) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let score = relay.peer_score(&attacker);
    assert!(
        score.is_some_and(|s| s <= -100.0),
        "one forgery: −100, below the graylist threshold (score {score:?}, stats {:?})",
        relay.heartbeat_stats()
    );
    // Rounds sent from now on are all dropped, valid announcements included.
    let from = sender.round() + 1;
    std::thread::sleep(Duration::from_secs(4));
    let to = sender.round();
    drop(sender);
    assert!(to >= from + 5, "the sender kept sending ({from}..{to})");
    let through: Vec<u32> = (from..to).filter(|n| has(&relay, &id(&format!("raw-control-{n}")))).collect();
    assert!(through.is_empty(), "a graylisted peer's messages must be dropped, got rounds {through:?}");
    // The sender kept forging every round, and the rate limit would let a
    // second forgery in within the minute: only being graylisted by the
    // first one keeps the relay from ever reading another.
    assert_eq!(relay.heartbeat_stats().forged, 1, "one forgery is enough");
}

// ---------------------------------------------------------------------
// Scores are also recomputed on a timer, not only when a heartbeat arrives:
// a graylisted peer's heartbeats are dropped unread, so only the timer can
// lift its penalty once the forgery ages out. Seen here as a peer that
// sends no heartbeat at all still getting a score.
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn scores_are_refreshed_without_heartbeats() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = NetworkConfig { listen_port: 0, enabled: true, ..Default::default() };
    let mut relay = Node::with_keypair_path(cfg, dir.path().join("relay.pem"))
        .expect("build node")
        .with_score_refresh_interval(Duration::from_secs(1));
    relay.start().expect("start node");
    relay.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    let sender = RawSender::spawn(&addr(&relay), vec![]);
    await_raw_control(&relay, &sender, 0);
    let deadline = Instant::now() + Duration::from_secs(10);
    while relay.peer_score(&sender.peer_id).is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    assert_eq!(relay.peer_score(&sender.peer_id), Some(0.0), "scored by the timer (stats {:?})", relay.heartbeat_stats());
    assert_eq!(relay.heartbeat_stats().applied, 0, "precondition: no heartbeat from anyone");
}

// ---------------------------------------------------------------------
// ADV-11 — what this node cannot decide costs nothing (R17, CEO 〔T-140〕
// E7): a key it has not seen and an issuer whose keys it cannot fetch are
// ignored, never scored down, never graylisted
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_11_undecidable_attestations_are_never_penalised() {
    use super::heartbeat::{encode_heartbeat, HEARTBEATS_TOPIC};
    use super::por::tests::{claims, header, hb, JwksServer, jwks_json, sign};
    use super::por::{TrustAnchor, DEFAULT_ISSUER, MAX_LIFETIME_SECS};
    let dir = tempfile::tempdir().unwrap();
    let issuer = libp2p::identity::ed25519::Keypair::generate();
    let server = JwksServer::serve(jwks_json(&issuer, "k1", ""));
    let dead_url = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://127.0.0.1:{}/.well-known/jwks.json", l.local_addr().unwrap().port())
    };
    let second = "https://second-issuer.example";
    let relay = spawn_trusting(
        &dir,
        "relay",
        vec![
            TrustAnchor { iss: DEFAULT_ISSUER.into(), jwks_url: server.url.clone() },
            TrustAnchor { iss: second.into(), jwks_url: dead_url },
        ],
    );
    let iat = now_ms() / 1000 - 60;
    // The trusted issuer's own key under a kid it has not published.
    let k1 = libp2p::identity::Keypair::generate_ed25519();
    let p1 = k1.public().to_peer_id().to_string();
    let unknown_kid = sign(&issuer, &header("k-unpublished"), &claims(&p1, iat));
    // A trusted issuer whose keys cannot be fetched.
    let k2 = libp2p::identity::Keypair::generate_ed25519();
    let p2 = k2.public().to_peer_id().to_string();
    let payload = format!(r#"{{"iss":"{second}","sub":"s","peer_id":"{p2}","iat":{iat},"exp":{}}}"#, iat + MAX_LIFETIME_SECS);
    let no_keys = sign(&issuer, &header("k1"), &payload);
    let s1 = RawSender::spawn_as(k1, &addr(&relay), vec![(HEARTBEATS_TOPIC, encode_heartbeat(&hb(&unknown_kid, now_ms())))]);
    let s2 = RawSender::spawn_as(k2, &addr(&relay), vec![(HEARTBEATS_TOPIC, encode_heartbeat(&hb(&no_keys, now_ms())))]);
    // Two of each sender's heartbeats get past the rate limit in the first minute.
    let deadline = Instant::now() + Duration::from_secs(20);
    while relay.heartbeat_stats().unverifiable < 4 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(relay.heartbeat_stats().unverifiable >= 4, "precondition: both judged undecidable ({:?})", relay.heartbeat_stats());
    assert!(server.hits.load(std::sync::atomic::Ordering::Relaxed) >= 1, "precondition: the unknown kid was looked up");
    // Both still get through afterwards...
    await_raw_control(&relay, &s1, s1.round());
    await_raw_control(&relay, &s2, s2.round());
    // ...and neither is scored down.
    assert_eq!(relay.peer_score(&p1), Some(0.0));
    assert_eq!(relay.peer_score(&p2), Some(0.0));
    let stats = relay.heartbeat_stats();
    assert_eq!((stats.forged, stats.malformed), (0, 0));
    assert_eq!(relay.invalid_message_count(), 0, "ignored, not rejected");
    drop((s1, s2));
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
    noise_on: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RawSender {
    fn spawn(relay: &str, noise: Vec<(&'static str, Vec<u8>)>) -> Self {
        Self::spawn_as(libp2p::identity::Keypair::generate_ed25519(), relay, noise)
    }

    /// As [`RawSender::spawn`], with a given identity.
    fn spawn_as(key: libp2p::identity::Keypair, relay: &str, noise: Vec<(&'static str, Vec<u8>)>) -> Self {
        Self::spawn_gated(key, relay, noise, true)
    }

    /// As [`RawSender::spawn_as`]; with `noise_on` false only the control
    /// announcements go out until [`RawSender::start_noise`].
    fn spawn_gated(key: libp2p::identity::Keypair, relay: &str, noise: Vec<(&'static str, Vec<u8>)>, noise_on: bool) -> Self {
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
        let peer_id = key.public().to_peer_id().to_string();
        let round = Arc::new(AtomicU32::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let noise_on = Arc::new(AtomicBool::new(noise_on));
        let (round_t, stop_t, noise_t) = (Arc::clone(&round), Arc::clone(&stop), Arc::clone(&noise_on));
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
                            for (t, data) in noise.iter().filter(|_| noise_t.load(Ordering::Relaxed)) {
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
        Self { peer_id, round, noise_on, stop, thread: Some(thread) }
    }

    fn round(&self) -> u32 {
        self.round.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn start_noise(&self) {
        self.noise_on.store(true, std::sync::atomic::Ordering::Relaxed);
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

// ---------------------------------------------------------------------
// DHT (A2): a peer writes straight into the victim's Kademlia store
// ---------------------------------------------------------------------

/// What [`RawDht`] is told to send.
enum RawWrite {
    Put(libp2p::kad::Record),
    Provide(Vec<u8>),
    /// Keep a record in the raw peer's own store, to serve on request.
    Hold(libp2p::kad::Record),
    /// Put a peer and its addresses in the raw peer's routing table.
    Neighbour(libp2p::PeerId, Vec<libp2p::Multiaddr>),
}

/// A peer that is not a `Node`: plain libp2p Kademlia on Rotifer's protocol
/// name, with none of its rules, as a broken or hostile implementation would
/// be. It identifies as Rotifer so the Identify guard keeps the connection,
/// sends each write straight to the victim, and redials whenever it is not
/// connected.
struct RawDht {
    peer_id: libp2p::PeerId,
    key: libp2p::identity::Keypair,
    tx: tokio::sync::mpsc::UnboundedSender<RawWrite>,
    connected: std::sync::Arc<std::sync::atomic::AtomicBool>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl RawDht {
    fn spawn(victim: &Node) -> Self {
        use libp2p::futures::StreamExt;
        use libp2p::swarm::{NetworkBehaviour, SwarmEvent};
        use libp2p::{identify, kad, Multiaddr, StreamProtocol};
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        #[derive(NetworkBehaviour)]
        struct Raw {
            // Neighbours it is told about are blocked: its own bootstrap
            // would dial them, and a failed dial drops their addresses.
            blocked: libp2p::allow_block_list::Behaviour<libp2p::allow_block_list::BlockedPeers>,
            kademlia: kad::Behaviour<kad::store::MemoryStore>,
            identify: identify::Behaviour,
        }

        let key = libp2p::identity::Keypair::generate_ed25519();
        let peer_id = key.public().to_peer_id();
        let victim_addr: Multiaddr = addr(victim).parse().expect("victim multiaddr");
        let victim_id: libp2p::PeerId = victim.local_peer_id().0.parse().expect("victim PeerId");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<RawWrite>();
        let connected = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (connected_t, stop_t, key_t) = (Arc::clone(&connected), Arc::clone(&stop), key.clone());
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().expect("runtime");
            rt.block_on(async move {
                let mut swarm = libp2p::SwarmBuilder::with_existing_identity(key_t)
                    .with_tokio()
                    .with_tcp(
                        libp2p::tcp::Config::default(),
                        libp2p::noise::Config::new,
                        libp2p::yamux::Config::default,
                    )
                    .expect("tcp")
                    .with_behaviour(|key| {
                        let id = key.public().to_peer_id();
                        let mut config = kad::Config::new(StreamProtocol::new(super::gene_record::KAD_PROTOCOL));
                        // Large enough to send anything the node may receive.
                        config.set_max_packet_size(1 << 20);
                        let mut kademlia = kad::Behaviour::with_config(id, kad::store::MemoryStore::new(id), config);
                        kademlia.set_mode(Some(kad::Mode::Server));
                        Raw {
                            blocked: Default::default(),
                            kademlia,
                            identify: identify::Behaviour::new(identify::Config::new("/rotifer/p2p/1".into(), key.public())),
                        }
                    })
                    .expect("behaviour")
                    .with_swarm_config(|c| c.with_idle_connection_timeout(Duration::from_secs(60)))
                    .build();
                swarm.behaviour_mut().kademlia.add_address(&victim_id, victim_addr.clone());
                let mut tick = tokio::time::interval(Duration::from_millis(100));
                while !stop_t.load(Ordering::Relaxed) {
                    tokio::select! {
                        // Keep dialling while not connected, as a peer that
                        // wants back in would.
                        _ = tick.tick() => {
                            if !swarm.is_connected(&victim_id) {
                                let _ = swarm.dial(victim_addr.clone());
                            }
                        }
                        Some(write) = rx.recv() => match write {
                            RawWrite::Put(record) => {
                                swarm.behaviour_mut().kademlia.put_record_to(record, std::iter::once(victim_id), kad::Quorum::One);
                            }
                            RawWrite::Provide(k) => {
                                let _ = swarm.behaviour_mut().kademlia.start_providing(kad::RecordKey::new(&k));
                            }
                            RawWrite::Hold(record) => {
                                use kad::store::RecordStore as _;
                                swarm.behaviour_mut().kademlia.store_mut().put(record).expect("raw store");
                            }
                            RawWrite::Neighbour(peer, addrs) => {
                                swarm.behaviour_mut().blocked.block_peer(peer);
                                for a in addrs {
                                    swarm.behaviour_mut().kademlia.add_address(&peer, a);
                                }
                            }
                        },
                        event = swarm.select_next_some() => match event {
                            SwarmEvent::ConnectionEstablished { peer_id, .. } if peer_id == victim_id => {
                                connected_t.store(true, Ordering::Relaxed);
                            }
                            SwarmEvent::ConnectionClosed { peer_id, num_established: 0, .. } if peer_id == victim_id => {
                                connected_t.store(false, Ordering::Relaxed);
                            }
                            _ => {}
                        },
                    }
                }
            });
        });
        let raw = Self { peer_id, key, tx, connected, stop, thread: Some(thread) };
        assert!(eventually(10, || raw.is_connected()), "the raw DHT peer did not connect");
        raw
    }

    fn is_connected(&self) -> bool {
        self.connected.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn put(&self, record: libp2p::kad::Record) {
        self.tx.send(RawWrite::Put(record)).expect("raw DHT peer running");
    }

    fn hold(&self, record: libp2p::kad::Record) {
        self.tx.send(RawWrite::Hold(record)).expect("raw DHT peer running");
    }

    fn neighbour(&self, peer: libp2p::PeerId, addrs: Vec<libp2p::Multiaddr>) {
        self.tx.send(RawWrite::Neighbour(peer, addrs)).expect("raw DHT peer running");
    }

    fn provide(&self, key: Vec<u8>) {
        self.tx.send(RawWrite::Provide(key)).expect("raw DHT peer running");
    }

    /// A valid record for `gene`, signed by this peer, published now.
    fn signed(&self, gene: &str) -> libp2p::kad::Record {
        let ann = super::gene_record::encode_announcement_message(&announcement(gene, now_ms()));
        let value = super::gene_record::sign_record(&self.key, &ann).expect("sign");
        libp2p::kad::Record::new(super::gene_record::record_key(gene, &self.peer_id), value)
    }
}

impl Drop for RawDht {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
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

// ---------------------------------------------------------------------
// ADV-12 — a forged DHT record is dropped and held against its sender; a
// valid one from the same sender is stored
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_12_forged_dht_record_is_dropped_and_charged() {
    let dir = tempfile::tempdir().unwrap();
    let victim = spawn(&dir, "victim", vec![]);
    let raw = RawDht::spawn(&victim);

    let good = raw.signed(&id("adv12-good"));
    raw.put(good.clone());
    assert!(eventually(10, || victim.dht_stats().stored == 1), "control record not stored: {:?}", victim.dht_stats());
    let canonical = super::gene_record::validate_record(good.key.as_ref(), &good.value, now_ms()).unwrap().canonical;
    assert_eq!(victim.local_dht(good.key.as_ref()).unwrap().0, Some(canonical));

    let mut forged = raw.signed(&id("adv12-forged"));
    let last = forged.value.len() - 1;
    forged.value[last] ^= 1;
    raw.put(forged.clone());
    assert!(eventually(10, || victim.dht_stats().forgeries == 1), "forgery not charged: {:?}", victim.dht_stats());
    assert_eq!(victim.local_dht(forged.key.as_ref()).unwrap().0, None);
    assert_eq!(victim.dht_stats().stored, 1);
}

// ---------------------------------------------------------------------
// ADV-13 — one peer's DHT writes are rate-limited: a burst of 128, then 10
// a minute
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_13_dht_write_flood_is_rate_limited() {
    let dir = tempfile::tempdir().unwrap();
    let victim = spawn(&dir, "victim", vec![]);
    let raw = RawDht::spawn(&victim);
    for n in 0..150 {
        raw.put(raw.signed(&id(&format!("adv13-{n}"))));
    }
    assert!(
        eventually(20, || {
            let s = victim.dht_stats();
            s.stored + s.rate_limited == 150
        }),
        "not all writes arrived: {:?}",
        victim.dht_stats()
    );
    let stats = victim.dht_stats();
    assert!(stats.stored >= 128 && stats.stored <= 130, "{stats:?}");
    assert!(stats.rate_limited >= 20, "{stats:?}");
}

// ---------------------------------------------------------------------
// ADV-14 — each kind of DHT entry goes only under its own kind of key
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_14_dht_entries_go_only_under_their_own_keys() {
    let dir = tempfile::tempdir().unwrap();
    let victim = spawn(&dir, "victim", vec![]);
    let raw = RawDht::spawn(&victim);
    let gene = id("adv14");
    let provider_key = super::gene_record::provider_key(&gene).unwrap();
    let record = raw.signed(&gene);

    // A value record under a non-gene key or a provider key: refused at step 2.
    for key in [b"/other/key".to_vec(), provider_key.clone()] {
        raw.put(libp2p::kad::Record::new(key.clone(), record.value.clone()));
        assert!(eventually(10, || victim.local_dht(&key).is_ok_and(|(v, _)| v.is_none())));
    }
    assert!(eventually(10, || victim.dht_stats().rejected == 2), "{:?}", victim.dht_stats());
    assert_eq!(victim.dht_stats().forgeries, 0, "a misplaced record is not a forgery");

    // A provider record under a record key: refused. Under a provider key: stored.
    raw.provide(record.key.to_vec());
    assert!(eventually(10, || victim.dht_stats().providers_bad_key == 1), "{:?}", victim.dht_stats());
    raw.provide(provider_key.clone());
    assert!(eventually(10, || victim.dht_stats().providers_stored == 1), "{:?}", victim.dht_stats());
    assert_eq!(victim.local_dht(&provider_key).unwrap().1, vec![raw.peer_id]);
    assert!(victim.local_dht(record.key.as_ref()).unwrap().1.is_empty());
}

// ---------------------------------------------------------------------
// ADV-15 — one forged DHT record gets its sender blocked at the connection
// layer; the block ends with the 24-hour forgery window
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_15_a_dht_forger_is_blocked_until_the_window_closes() {
    let dir = tempfile::tempdir().unwrap();
    let victim = spawn(&dir, "victim", vec![]);
    let raw = RawDht::spawn(&victim);

    let mut forged = raw.signed(&id("adv15-forged"));
    let last = forged.value.len() - 1;
    forged.value[last] ^= 1;
    raw.put(forged);
    assert!(eventually(10, || victim.dht_stats().forgeries == 1), "{:?}", victim.dht_stats());

    // Disconnected, and every redial refused.
    assert!(eventually(10, || victim.connection_denials().blocked >= 3), "redials not refused: {:?}", victim.connection_denials());
    raw.put(raw.signed(&id("adv15-while-blocked")));
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(victim.dht_stats().stored, 0, "a blocked peer's writes must not arrive");

    // A minute short of the window: still blocked.
    victim.skip_clock(Duration::from_millis(super::por::FORGERY_WINDOW_MS) - Duration::from_secs(60)).unwrap();
    let before = victim.connection_denials().blocked;
    assert!(eventually(5, || victim.connection_denials().blocked > before), "unblocked too early");

    // The window closes: the peer is let back in and its writes are read again.
    victim.skip_clock(Duration::from_secs(60)).unwrap();
    assert!(eventually(10, || raw.is_connected()), "not reconnected after the window: {:?}", victim.connection_denials());
    let good = raw.signed(&id("adv15-after"));
    raw.put(good.clone());
    assert!(eventually(10, || victim.dht_stats().stored >= 1), "{:?}", victim.dht_stats());
    assert!(victim.local_dht(good.key.as_ref()).unwrap().0.is_some());
}

// ---------------------------------------------------------------------
// ADV-16 (C7) — the node's Kad packet limit takes the largest GET_VALUE
// response a peer may send: a record of MAX_RECORD_BYTES plus k = 20 closer
// peers, each with 8 addresses of up to 128 bytes. A valid v1 record is far
// smaller, so this peer serves raw bytes, as a hostile one could.
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_16_largest_get_response_fits_the_packet_limit() {
    use super::gene_record::{record_key, MAX_RECORD_BYTES};
    let dir = tempfile::tempdir().unwrap();
    let victim = spawn(&dir, "victim", vec![]);
    let raw = RawDht::spawn(&victim);

    let key = record_key(&id("adv16"), &raw.peer_id);
    let value: Vec<u8> = (0..MAX_RECORD_BYTES).map(|i| i as u8).collect();
    raw.hold(libp2p::kad::Record::new(key.clone(), value.clone()));
    let mut neighbours = 0;
    for _ in 0..20 {
        let addrs: Vec<libp2p::Multiaddr> = (0..8)
            .map(|i| format!("/dns4/{}.example/tcp/{}", "n".repeat(110), 4000 + i).parse().unwrap())
            .collect();
        neighbours += addrs.iter().map(|a| a.to_vec().len()).sum::<usize>();
        assert!(addrs.iter().all(|a| a.to_vec().len() <= 128));
        raw.neighbour(libp2p::PeerId::random(), addrs);
    }
    assert!(MAX_RECORD_BYTES + neighbours > 16 * 1024, "the response must exceed libp2p's default limit");

    let mut got = None;
    assert!(
        eventually(15, || {
            got = victim.get_record(&key).ok().flatten();
            got.is_some()
        }),
        "the node must read the largest response"
    );
    assert_eq!(got, Some(value));
}
