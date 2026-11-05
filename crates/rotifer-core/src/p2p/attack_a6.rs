//! A6 part 1 against real nodes over loopback (A6 design v3 §5.3 ②, §5.5
//! ④): the bootstrap keeper and P6. Top-up and its Eclipse criteria (①, ③)
//! are A6 part 2. Each test prints what it judges on lines starting `A6 `.
//!
//! Run with `cargo test -p rotifer-core --features p2p-integration --lib
//! attack_a6 -- --test-threads=1 --nocapture`.

use std::time::{Duration, Instant};

// A1-2's setup helpers (CEO, T-156: reuse them, `run_eclipse` untouched).
use super::attack_a1_2::{addr, announcement, config, eventually, heard, id, now_ms, peer_of};
use super::messages::{encode_announcement, ANNOUNCEMENTS_TOPIC};
use super::node::{Node, OutboundReport};
use super::outbound::{P6_THRESHOLD, P6_WEIGHT};
use super::NetworkConfig;

/// A started node with its own throwaway identity, dialing `bootstrap`,
/// built through `build` (test switches) before it starts.
fn spawn_with(
    dir: &tempfile::TempDir,
    name: &str,
    bootstrap: Vec<String>,
    build: impl FnOnce(Node) -> Node,
) -> Node {
    let node = Node::with_keypair_path(config(bootstrap), dir.path().join(format!("{name}.pem"))).expect("build node");
    let mut node = build(node);
    node.start().expect("start node");
    node.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    node
}

fn report(node: &Node) -> OutboundReport {
    node.outbound_report().expect("outbound report")
}

// ---------------------------------------------------------------------
// ② Bootstrap keeper (design v3 §2, §5.3)
// ---------------------------------------------------------------------

/// A node that never dials anyone by policy, so a reconnection can only
/// come from the victim's keeper.
fn spawn_quiet_bootstrap(dir: &tempfile::TempDir, name: &str, port: u16) -> Node {
    let mut cfg = config(vec![]);
    cfg.listen_port = port;
    let path = dir.path().join(format!("{name}.key"));
    let mut node = Node::with_keypair_path(cfg, path).expect("build node");
    node.start().expect("start node");
    node
}

fn bootstraps_connected(node: &Node) -> usize {
    report(node).bootstraps_connected
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 keeper — enable the p2p-integration feature or run with --ignored")]
fn a6_bootstrap_keeper_redials_after_a_disconnect() {
    let dir = tempfile::tempdir().unwrap();
    let boot = spawn_quiet_bootstrap(&dir, "boot", 0);
    // The address carries no /p2p/ (as in today's configs and tests).
    let victim = spawn_with(&dir, "victim", vec![addr(&boot)], |n| n);
    assert!(eventually(10, || bootstraps_connected(&victim) == 1), "connected to the bootstrap node first");
    victim.disconnect(peer_of(&boot)).expect("disconnect");
    assert!(eventually(5, || !victim.connected_peers().contains(&boot.local_peer_id().0)), "disconnected");
    let dropped = Instant::now();
    let back = eventually(30, || bootstraps_connected(&victim) == 1);
    println!("A6 ② disconnect reconnected={back} after={:.1}s", dropped.elapsed().as_secs_f64());
    assert!(back, "the keeper must reconnect within 30 s");
}

/// Regression: the keeper redials from a fresh source port. Redialling from
/// the listen port right after this node closed the connection reuses the
/// same TCP 4-tuple, still in TIME_WAIT, and fails with "address in use" for
/// about 30 s; the keeper then backs off 1, 2, 4, 8 s. With a fresh port it
/// is back within a second, so 5 s separates the two.
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 keeper — enable the p2p-integration feature or run with --ignored")]
fn a6_bootstrap_keeper_redials_from_a_fresh_port() {
    let dir = tempfile::tempdir().unwrap();
    let boot = spawn_quiet_bootstrap(&dir, "boot", 0);
    let victim = spawn_with(&dir, "victim", vec![addr(&boot)], |n| n);
    assert!(eventually(10, || bootstraps_connected(&victim) == 1), "connected to the bootstrap node first");
    // Past the keeper's startup grace, so only the backoff can delay it.
    std::thread::sleep(Duration::from_secs(6));
    victim.disconnect(peer_of(&boot)).expect("disconnect");
    assert!(eventually(5, || bootstraps_connected(&victim) == 0 || report(&victim).keeper_dials > 0), "disconnected");
    let dropped = Instant::now();
    let back = eventually(5, || bootstraps_connected(&victim) == 1);
    println!(
        "A6 ② fresh_port reconnected={back} after={:.1}s keeper_dials={}",
        dropped.elapsed().as_secs_f64(),
        report(&victim).keeper_dials
    );
    assert!(back, "the keeper must reconnect within 5 s (TIME_WAIT: was it dialling from the listen port?)");
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 keeper — enable the p2p-integration feature or run with --ignored")]
fn a6_bootstrap_keeper_rides_out_45_seconds_offline() {
    const PORT: u16 = 39883;
    let dir = tempfile::tempdir().unwrap();
    let mut boot = spawn_quiet_bootstrap(&dir, "boot", PORT);
    let victim = spawn_with(&dir, "victim", vec![addr(&boot)], |n| n);
    assert!(eventually(10, || bootstraps_connected(&victim) == 1), "connected to the bootstrap node first");
    // Past the keeper's startup grace, so its count starts from here.
    std::thread::sleep(Duration::from_secs(6));
    let before = report(&victim).keeper_dials;
    boot.stop().expect("stop");
    drop(boot);
    std::thread::sleep(Duration::from_secs(45));
    let during = report(&victim).keeper_dials - before;
    println!("A6 ② offline_45s keeper_dials={during}");
    // Same key and port, but its own peer store: nodes keep peers.json next
    // to their key, so a restart from `dir` would dial the victim back from
    // the shared file and pass without the keeper.
    let dir2 = tempfile::tempdir().unwrap();
    std::fs::copy(dir.path().join("boot.key"), dir2.path().join("boot.key")).expect("copy key");
    let mut boot = spawn_quiet_bootstrap(&dir2, "boot", PORT);
    let up = Instant::now();
    let back = eventually(30, || bootstraps_connected(&victim) == 1);
    println!("A6 ② offline_45s reconnected={back} after_restart={:.1}s", up.elapsed().as_secs_f64());
    let _ = boot.stop();
    assert!((1..=8).contains(&during), "45 s offline: dials at 0, 1, 3, 7, 15, 31 s (≤ 8 with jitter), got {during}");
    assert!(back, "reconnect within 30 s of the bootstrap node coming back");
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 keeper — enable the p2p-integration feature or run with --ignored")]
fn a6_bootstrap_keeper_reaches_the_live_one_listed_last() {
    let dir = tempfile::tempdir().unwrap();
    let boot = spawn_quiet_bootstrap(&dir, "boot", 0);
    // Two dead addresses first: nothing listens there, so a dial fails at once.
    let dead = |port: u16| format!("/ip4/127.0.0.1/tcp/{port}");
    let victim = spawn_with(&dir, "victim", vec![dead(9), dead(19), addr(&boot)], |n| n);
    assert!(eventually(10, || bootstraps_connected(&victim) == 1), "connected to the live bootstrap node first");
    std::thread::sleep(Duration::from_secs(6));
    victim.disconnect(peer_of(&boot)).expect("disconnect");
    assert!(eventually(5, || bootstraps_connected(&victim) == 0), "disconnected");
    let dropped = Instant::now();
    let back = eventually(30, || bootstraps_connected(&victim) == 1);
    println!(
        "A6 ② live_one_last reconnected={back} after={:.1}s keeper_dials={}",
        dropped.elapsed().as_secs_f64(),
        report(&victim).keeper_dials
    );
    assert!(back, "the keeper must work through the dead ones and reconnect within 30 s");
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 keeper — enable the p2p-integration feature or run with --ignored")]
fn a6_bootstrap_keeper_reconnects_only_one() {
    let dir = tempfile::tempdir().unwrap();
    let boots: Vec<Node> = (0..3).map(|i| spawn_quiet_bootstrap(&dir, &format!("boot-{i}"), 0)).collect();
    let victim = spawn_with(&dir, "victim", boots.iter().map(addr).collect(), |n| n);
    assert!(eventually(10, || bootstraps_connected(&victim) == 3), "startup dials all three");
    std::thread::sleep(Duration::from_secs(6));
    let before = report(&victim).keeper_dials;
    for b in &boots {
        victim.disconnect(peer_of(b)).expect("disconnect");
    }
    // The keeper dials only once none is connected, i.e. after all three
    // closed; it reconnects too fast to see the count at zero.
    let one = eventually(30, || report(&victim).keeper_dials > before && bootstraps_connected(&victim) == 1);
    let dials = report(&victim).keeper_dials;
    std::thread::sleep(Duration::from_secs(10));
    let (later, later_dials) = (bootstraps_connected(&victim), report(&victim).keeper_dials);
    println!("A6 ② only_one reconnected={one} connected_10s_later={later} keeper_dials={dials}->{later_dials}");
    assert!(one, "one bootstrap node back within 30 s");
    assert_eq!((later, later_dials), (1, dials), "one is enough: no further bootstrap dials");
}

// ---------------------------------------------------------------------
// ④ P6 (design v3 §3, §5.5). No whitelist here.
// ---------------------------------------------------------------------

/// Peers on one IP from 11 to 16: one holds a valid proof of registration,
/// one is anonymous. The registered one scores P6 + 20, the anonymous one
/// P6; the anonymous one is still heard at 11 and no longer at 14. The
/// same-IP counters move as they should.
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 P6 — enable the p2p-integration feature or run with --ignored")]
fn a6_shared_ip_scores_registered_and_anonymous_alike() {
    use super::por::tests::{header, jwks_json, sign, JwksServer};
    use super::por::{AttestationStatus, TrustAnchor, DEFAULT_ISSUER, MAX_LIFETIME_SECS, REGISTERED_BONUS};
    let dir = tempfile::tempdir().unwrap();
    let issuer = libp2p::identity::ed25519::Keypair::generate();
    let server = JwksServer::serve(jwks_json(&issuer, "k1", ""));
    let anchors = vec![TrustAnchor { iss: DEFAULT_ISSUER.into(), jwks_url: server.url.clone() }];
    let cfg = |bootstrap: Vec<String>| NetworkConfig { trust_anchors: anchors.clone(), ..config(bootstrap) };
    let token = |peer: &str| {
        let iat = now_ms() / 1000 - 60;
        let claims = format!(
            r#"{{"iss":"{DEFAULT_ISSUER}","sub":"acct-a6","peer_id":"{peer}","iat":{iat},"exp":{}}}"#,
            iat + MAX_LIFETIME_SECS
        );
        sign(&issuer, &header("k1"), &claims)
    };
    let mut victim = Node::with_keypair_path(cfg(vec![]), dir.path().join("victim.pem"))
        .expect("build node")
        .with_score_refresh_interval(Duration::from_secs(1));
    victim.start().expect("start node");
    victim.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    let join = |name: &str, registered: bool| -> Node {
        let mut node = Node::with_keypair_path(cfg(vec![addr(&victim)]), dir.path().join(format!("{name}.pem")))
            .expect("build node")
            .with_heartbeat_interval(Duration::from_secs(2));
        let me = node.local_peer_id().0;
        if registered {
            node.set_attestation(Some(token(&me))).expect("attestation");
        }
        node.start().expect("start node");
        node.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
        let decided = eventually(30, || {
            if registered {
                victim.peer_attestation(&me).is_some_and(|a| a.status == AttestationStatus::Valid)
            } else {
                victim.peer_score(&me).is_some()
            }
        });
        assert!(decided, "{name}: the victim must have decided this node");
        node
    };
    let registered = join("registered", true);
    let anonymous = join("anonymous", false);
    let (reg_id, anon_id) = (registered.local_peer_id().0, anonymous.local_peer_id().0);
    let mut fillers: Vec<Node> = Vec::new();
    let mut readings: Vec<(usize, Option<f64>, Option<f64>, bool)> = Vec::new();
    for n in 11..=16usize {
        while fillers.len() + 2 < n {
            let i = fillers.len();
            fillers.push(join(&format!("filler-{i}"), false));
        }
        let p6 = P6_WEIGHT * (n as f64 - P6_THRESHOLD).powi(2);
        let settled = eventually(15, || {
            victim.peer_score(&anon_id) == Some(p6) && victim.peer_score(&reg_id) == Some(p6 + REGISTERED_BONUS)
        });
        std::thread::sleep(Duration::from_secs(3));
        let mesh = victim.mesh_peers(ANNOUNCEMENTS_TOPIC).expect("mesh").len();
        let gene = id(&format!("a6-shared-ip-{n}"));
        let heard_it = eventually(8, || {
            let _ = anonymous.publish(ANNOUNCEMENTS_TOPIC, &encode_announcement(&announcement(&gene, "a6-shared-ip")));
            std::thread::sleep(Duration::from_millis(300));
            heard(&victim, &gene)
        });
        let (reg, anon) = (victim.peer_score(&reg_id), victim.peer_score(&anon_id));
        println!(
            "A6 ④ same_ip_peers={n} registered_score={reg:?} anonymous_score={anon:?} settled={settled} mesh_after_3s={mesh} \
             anonymous_heard={heard_it}"
        );
        readings.push((n, reg, anon, heard_it));
    }
    let stats = victim.colocation_stats();
    println!("A6 ④ colocation_stats={stats:?}");
    for (n, reg, anon, heard_it) in &readings {
        let p6 = P6_WEIGHT * (*n as f64 - P6_THRESHOLD).powi(2);
        assert_eq!(*reg, Some(p6 + REGISTERED_BONUS), "registered node at {n} peers on one IP");
        assert_eq!(*anon, Some(p6), "anonymous node at {n} peers on one IP");
        match n {
            11 => assert!(*heard_it, "at 11 the anonymous node is still heard"),
            14 => assert!(!*heard_it, "at 14 the anonymous node is no longer heard"),
            _ => {}
        }
    }
    assert_eq!(stats.ips_over_threshold, 1, "one IP over the threshold");
    assert!(stats.max_peers_on_one_ip >= 16, "16 peers seen on it: {stats:?}");
    assert_eq!(stats.ips_over_threshold_with_registered_peer, 1, "and a registered peer among them");
    drop((registered, anonymous, fillers));
}

/// K10: GossipSub drops a peer's IP from the P6 count when *any* of its
/// connections closes (`on_connection_closed` → `remove_ip`), even if the
/// peer is still connected. Eleven peers on one IP, one of them with two
/// connections; closing one of those must leave all eleven at −5.
#[test]
#[cfg_attr(not(feature = "k10-repro"), ignore = "K10 reproduced (T-156); fix tracked separately, see ADR-304 revision draft")]
fn a6_p6_still_counts_a_peer_after_one_of_two_connections_closes() {
    const NODES: usize = 11;
    let dir = tempfile::tempdir().unwrap();
    let mut victim = Node::with_keypair_path(config(vec![]), dir.path().join("victim.pem"))
        .expect("build node")
        .with_score_refresh_interval(Duration::from_secs(1));
    victim.start().expect("start node");
    victim.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    let victim_dial = format!("{}/p2p/{}", addr(&victim), victim.local_peer_id().0);
    let nodes: Vec<Node> =
        (0..NODES).map(|i| spawn_with(&dir, &format!("same-ip-{i}"), vec![addr(&victim)], |n| n)).collect();
    let ids: Vec<String> = nodes.iter().map(|n| n.local_peer_id().0).collect();
    let expected = P6_WEIGHT * (NODES as f64 - P6_THRESHOLD).powi(2);
    let scores = |v: &Node| ids.iter().map(|p| v.peer_score(p)).collect::<Vec<_>>();
    let settled = eventually(30, || scores(&victim).iter().all(|s| *s == Some(expected)));
    println!("A6 K10 before peers={NODES} scores={:?}", scores(&victim));
    assert!(settled, "all {NODES} peers on one IP must score {expected} first");

    // Node 0 opens a second connection to the victim.
    nodes[0].dial_always(victim_dial.parse().expect("multiaddr")).expect("dial");
    let connections = |v: &Node| report(v).connections.get(&ids[0]).copied();
    let two = eventually(10, || connections(&victim) == Some(2));
    println!("A6 K10 node0_connections_at_victim={:?}", connections(&victim));
    assert!(two, "node 0 must hold 2 connections to the victim before one closes, or this proves nothing");

    // The victim closes one of them; node 0 stays connected on the other.
    assert!(victim.close_one_connection(peer_of(&nodes[0])).expect("close"), "a connection to close");
    let one = eventually(10, || connections(&victim) == Some(1));
    println!("A6 K10 node0_connections_after_close={:?}", connections(&victim));
    assert!(one, "node 0 must still be connected on its other connection");
    // Scores are recomputed every second.
    std::thread::sleep(Duration::from_secs(3));
    let after = scores(&victim);
    println!("A6 K10 after peers={NODES} scores={after:?}");
    assert!(
        after.iter().all(|s| *s == Some(expected)),
        "with all {NODES} peers still connected from one IP, each must still score {expected}: {after:?}"
    );
}

