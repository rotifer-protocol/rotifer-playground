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
