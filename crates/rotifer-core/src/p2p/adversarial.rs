//! Adversarial suite: attacks a real node over loopback libp2p and asserts the
//! Cloud-independent defences hold (RFC §8). Each scenario has an attacker node
//! publish hostile traffic to a victim, plus a control message from the same
//! attacker that MUST still get through — so a scenario cannot pass merely
//! because nothing was delivered at all.
//!
//! Run with `cargo test -p rotifer-core --features p2p-integration --lib
//! adversarial -- --test-threads=1`.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use super::messages::{encode_announcement, ANNOUNCEMENTS_TOPIC};
use super::node::Node;
use super::security::RATE_LIMIT_PER_PEER_PER_SEC;
use super::{GeneAnnouncement, NetworkConfig, PeerId};

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn announcement(gene_id: &str, publisher: &PeerId, timestamp: u64) -> Vec<u8> {
    encode_announcement(&GeneAnnouncement {
        gene_id: gene_id.into(),
        name: gene_id.into(),
        domain: "test".into(),
        version: "1.0.0".into(),
        fidelity: "Native".into(),
        publisher: publisher.clone(),
        reputation_score: 0.0,
        timestamp,
    })
    .expect("encode")
}

/// A started node with its own throwaway identity, optionally dialing `peer`.
fn spawn(dir: &tempfile::TempDir, name: &str, bootstrap: Vec<String>) -> Node {
    let cfg = NetworkConfig {
        listen_port: 0,
        enabled: true,
        bootstrap_peers: bootstrap,
        ..Default::default()
    };
    let mut node = Node::with_keypair_path(cfg, dir.path().join(format!("{name}.pem")))
        .expect("build node");
    node.start().expect("start node");
    node.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    node
}

/// Victim + attacker connected on the announcements topic, with the mesh
/// proven formed: a control announcement from the attacker has arrived.
fn victim_and_attacker(dir: &tempfile::TempDir) -> (Node, Node) {
    let victim = spawn(dir, "victim", vec![]);
    let addr = victim.listen_addrs().into_iter().next().expect("victim addr");
    let attacker = spawn(dir, "attacker", vec![addr]);
    let control = announcement("control", &attacker.local_peer_id(), now_secs());
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let _ = attacker.publish(ANNOUNCEMENTS_TOPIC, &control);
        if victim
            .received_announcements()
            .iter()
            .any(|(a, _)| a.gene_id == "control")
        {
            return (victim, attacker);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("mesh never formed: control announcement not received within 20s");
}

/// Publish `payload` and give it time to arrive, then report whether the
/// victim surfaced an announcement for `gene_id`.
fn delivered(victim: &Node, attacker: &Node, gene_id: &str, payload: &[u8]) -> bool {
    attacker.publish(ANNOUNCEMENTS_TOPIC, payload).expect("publish");
    // A follow-up control proves the attacker's traffic is still flowing, so a
    // "not delivered" verdict means rejected, not lost.
    let probe = format!("probe-{gene_id}");
    let probe_payload = announcement(&probe, &attacker.local_peer_id(), now_secs());
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        let anns = victim.received_announcements();
        if anns.iter().any(|(a, _)| a.gene_id == probe) {
            return anns.iter().any(|(a, _)| a.gene_id == gene_id);
        }
        let _ = attacker.publish(ANNOUNCEMENTS_TOPIC, &probe_payload);
        std::thread::sleep(Duration::from_millis(300));
    }
    panic!("probe after '{gene_id}' never arrived — cannot tell rejection from loss");
}

// ---------------------------------------------------------------------
// ADV-1 — impersonation: `publisher` field names another node
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_1_forged_publisher_field_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    // The attacker claims the victim's own identity as publisher; GossipSub
    // still authenticates the real source as the attacker.
    let forged = announcement("forged", &victim.local_peer_id(), now_secs());
    assert!(
        !delivered(&victim, &attacker, "forged", &forged),
        "an announcement whose publisher field differs from its authenticated source must be dropped"
    );
}

// ---------------------------------------------------------------------
// ADV-2 — replay of a stale announcement (outside the §6.4 window)
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_2_stale_announcement_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    let stale = announcement("stale", &attacker.local_peer_id(), now_secs() - 3600);
    assert!(
        !delivered(&victim, &attacker, "stale", &stale),
        "an announcement an hour old must be dropped by the anti-replay window"
    );
}

// ---------------------------------------------------------------------
// ADV-3 — far-future timestamp (pre-dated to outlive the window)
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_3_future_dated_announcement_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    let future = announcement("future", &attacker.local_peer_id(), now_secs() + 3600);
    assert!(
        !delivered(&victim, &attacker, "future", &future),
        "an announcement dated an hour ahead must be dropped"
    );
}

// ---------------------------------------------------------------------
// ADV-4 — malformed payload must not crash or surface
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_4_malformed_payload_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    assert!(
        !delivered(&victim, &attacker, "garbage", b"\x00\xffnot-an-announcement"),
        "garbage must not surface as an announcement"
    );
    // And the victim keeps serving afterwards (the probe inside `delivered`
    // already proved post-garbage delivery).
}

// ---------------------------------------------------------------------
// ADV-5 — flood from one identity is capped by the per-peer limit
// ---------------------------------------------------------------------
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "adversarial integration — enable the p2p-integration feature or run with --ignored")]
fn adv_5_single_identity_flood_is_rate_limited() {
    let dir = tempfile::tempdir().unwrap();
    let (victim, attacker) = victim_and_attacker(&dir);
    // Let the window that carried the mesh-forming controls expire.
    std::thread::sleep(Duration::from_millis(1500));
    let before = victim.received_messages().len();
    let burst = 10 * RATE_LIMIT_PER_PEER_PER_SEC as usize;
    let me = attacker.local_peer_id();
    for i in 0..burst {
        let payload = announcement(&format!("flood-{i}"), &me, now_secs());
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
