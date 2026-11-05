//! A6 connection policy against real nodes over loopback (A6 design v5 §5).
//! Each test prints the numbers it judges on lines starting `A6 `.
//!
//! Run with `cargo test -p rotifer-core --features p2p-integration --lib
//! attack_a6 -- --test-threads=1 --nocapture`.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use libp2p::Multiaddr;

// A1-2's setup helpers (CEO, T-156: reuse them, `run_eclipse` untouched).
use super::attack_a1_2::{addr, announcement, config, eventually, heard, id, now_ms, peer_of};
use super::messages::{encode_announcement, ANNOUNCEMENTS_TOPIC};
use super::node::{Node, OutboundReport};
use super::outbound::{FirstConnection, TopUpWay, P6_THRESHOLD, P6_WEIGHT};
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

/// [`spawn_with`] with the 127.0.0.1 P6 whitelist on (design v3 §3.5).
fn spawn_listed(dir: &tempfile::TempDir, name: &str, bootstrap: Vec<String>) -> Node {
    spawn_with(dir, name, bootstrap, |n| n.with_p6_loopback_whitelist())
}

fn report(node: &Node) -> OutboundReport {
    node.outbound_report().expect("outbound report")
}

// ---------------------------------------------------------------------
// ① Dial-in-first Eclipse: are there top-up peers, and are they not biased
// towards the attacker (design v5 §5.1)?
//
// A1-2's "3 of 4 bootstrap nodes + dial in first" population: 36 attacker
// nodes and 3 bootstrap nodes, 12 honest nodes and 1 bootstrap node. The
// victim takes at most 24 inbound connections and holds top-up and the
// keeper until 24 attackers have dialled in; then it is sampled every 10 s
// from 30 s to 90 s, and its mesh is re-formed 10 times.
//
// Top-up peers include adopted ones (§1.7). Every node runs a test-only
// 2 s `prune_backoff`, and the victim a 1 s `unsubscribe_backoff`, so that
// one re-formation does not hold the next back; production keeps libp2p's
// defaults (①-稳 tests those).
//
// `A6 SETUP INVALID` failures mean the setup, not the policy, measured
// nothing (§5.1, F5); they are red in CI and are not rerun.
// ---------------------------------------------------------------------

const A6_HONEST: usize = 12;
const A6_ATTACKERS: usize = 36;
const A6_ATTACKER_BOOTSTRAPS: usize = 3;
const A6_VICTIM_INBOUND: u32 = 24;
/// The attacker's share of the whole population (36 + 3 of 52): the most
/// it may hold of the victim's top-up peers (criterion c).
const A6_ATTACKER_SHARE: f64 = 39.0 / 52.0;
const A6_SAMPLE_AT: [u64; 7] = [30, 40, 50, 60, 70, 80, 90];
const A6_REFORMS: usize = 10;
/// Criterion e: share of re-formed meshes with an honest peer.
const A6_E_MIN: f64 = 0.5;
const A6_ROUNDS: usize = 3;
/// Rounds in a row without 24 inbound attackers (S4) before the setup is
/// declared invalid.
const A6_INVALID_MAX: usize = 3;
/// Re-formations short of `mesh_n_low` that still have an honest peer: more
/// than this many in a round make the round's setup invalid (F5).
const A6_INVALID_WITH_HONEST_MAX: usize = 1;
/// GossipSub's `mesh_n_low`: a re-formed mesh this large is a valid draw.
const A6_MESH_N_LOW: usize = 5;
/// GossipSub's unsubscribe backoff on the victim (S1): with libp2p's 10 s, a
/// re-formed mesh would exclude the peers the previous one just pruned.
const A6_UNSUBSCRIBE_BACKOFF: Duration = Duration::from_secs(1);
/// GossipSub's prune backoff on every node (design v5 §5.1): with libp2p's
/// 60 s, a peer the victim just pruned would refuse its next GRAFT.
const A6_PRUNE_BACKOFF: Duration = Duration::from_secs(2);
/// Wait after leaving the topic before joining again: the backoff plus one
/// heartbeat of slack (`backoff_slack`), plus margin.
const A6_REJOIN_AFTER: Duration = Duration::from_millis(2500);
/// Wait after joining before reading the mesh: two heartbeats plus margin.
const A6_READ_MESH_AFTER: Duration = Duration::from_millis(2500);

#[derive(Clone, Copy)]
struct Policy {
    label: &'static str,
    /// Top-up runs once released.
    topup: bool,
    mesh_outbound_min: usize,
    /// Control for c+d: attackers first among top-up candidates, connected
    /// (adoptable) ones included.
    attackers_first: bool,
}

#[derive(Debug, Default)]
struct Sample {
    at: u64,
    /// Top-up peers (adopted or dialled), by side and by way.
    topup: usize,
    topup_attackers: usize,
    topup_honest: usize,
    topup_adopted: usize,
    topup_dialled: usize,
    mesh: usize,
    mesh_self_dialed: usize,
    mesh_honest: usize,
    /// First connection dialled by Kademlia (or anything other than top-up,
    /// bootstrap and restart) and not adopted, by side (S5).
    kad_honest: usize,
    kad_attackers: usize,
    bootstrap: usize,
    inbound_attackers: usize,
    inbound_honest: usize,
    connections_in: u32,
    connections_out: u32,
    /// The last top-up round's four readings (F3).
    routing_table: usize,
    eligible: usize,
    dials: usize,
    failures: usize,
    /// Random walks short top-up rounds have sent so far (C4 fix).
    shortfall_walks: usize,
    /// Per k-bucket: eligible honest / attackers, top-up peers honest /
    /// attackers (F2, Codex 3).
    buckets: String,
}

#[derive(Debug, Default)]
struct Reform {
    mesh: usize,
    mesh_self_dialed: usize,
    mesh_honest: usize,
}

impl Reform {
    /// Enough peers for an independent draw (`mesh_n_low`).
    fn valid(&self) -> bool {
        self.mesh >= A6_MESH_N_LOW
    }
}

struct Readings {
    samples: Vec<Sample>,
    reforms: Vec<Reform>,
    finds_honest_gene: bool,
}

#[derive(Debug, Clone, Copy)]
struct Verdict {
    a: bool,
    b: bool,
    cd: bool,
    e: bool,
    e_rate: f64,
    /// Re-formations short of `mesh_n_low` that had an honest peer (F5).
    invalid_with_honest: usize,
}

impl Verdict {
    fn green(&self) -> bool {
        self.a && self.b && self.cd && self.e
    }
}

/// The criteria (S3: c and d are one criterion; F5 for e).
fn judge(r: &Readings) -> Verdict {
    let a = r.samples.iter().all(|s| s.topup >= 8);
    // §10 row 2: b on the steady samples and on the valid re-formations
    // (the heartbeat adds self-dialled peers only to a mesh of at least
    // `mesh_n_low`).
    let b = r.samples.iter().all(|s| s.mesh_self_dialed >= 3)
        && r.reforms.iter().filter(|m| m.valid()).all(|m| m.mesh_self_dialed >= 3);
    let cd = r.samples.iter().all(|s| {
        let share = s.topup_attackers as f64 / s.topup.max(1) as f64;
        share <= A6_ATTACKER_SHARE && s.topup_honest >= 2
    });
    // F5: a short mesh with no honest peer is a failure of e (it is the case
    // e exists to catch); a short mesh with one is left out.
    let with_honest = r.reforms.iter().filter(|m| m.valid() && m.mesh_honest > 0).count();
    let counted = r.reforms.iter().filter(|m| m.valid() || m.mesh_honest == 0).count();
    let e_rate = with_honest as f64 / counted.max(1) as f64;
    let invalid_with_honest = r.reforms.iter().filter(|m| !m.valid() && m.mesh_honest > 0).count();
    Verdict { a, b, cd, e: e_rate >= A6_E_MIN, e_rate, invalid_with_honest }
}

/// The k-bucket `peer` falls in as seen from `me`.
fn bucket_of(me: &libp2p::PeerId, peer: &str) -> Option<u32> {
    let peer: libp2p::PeerId = peer.parse().ok()?;
    libp2p::kad::KBucketKey::from(*me).distance(&libp2p::kad::KBucketKey::from(peer)).ilog2()
}

/// Split the victim's peers by side and by how they first connected.
fn sample(victim: &Node, at: u64, attackers: &HashSet<String>, honest: &HashSet<String>) -> Sample {
    let r = report(victim);
    let mesh = victim.mesh_peers(ANNOUNCEMENTS_TOPIC).expect("mesh");
    let (connections_in, connections_out) = victim.connection_counts().expect("connection counts");
    let round = &r.last_round;
    let mut s = Sample {
        at,
        mesh: mesh.len(),
        connections_in,
        connections_out,
        routing_table: round.routing_table,
        eligible: round.eligible,
        dials: round.dials,
        failures: round.failures,
        shortfall_walks: round.shortfall_walks_total,
        ..Default::default()
    };
    for (peer, way) in &r.topup {
        s.topup += 1;
        s.topup_attackers += usize::from(attackers.contains(peer));
        s.topup_honest += usize::from(honest.contains(peer));
        match way {
            TopUpWay::Adopted => s.topup_adopted += 1,
            TopUpWay::Dialled => s.topup_dialled += 1,
        }
    }
    for (peer, how) in &r.first {
        let (is_attacker, is_honest) = (attackers.contains(peer), honest.contains(peer));
        match how {
            FirstConnection::OtherDial if !r.topup.contains_key(peer) => {
                s.kad_attackers += usize::from(is_attacker);
                s.kad_honest += usize::from(is_honest);
            }
            FirstConnection::Bootstrap => s.bootstrap += 1,
            FirstConnection::Inbound => {
                s.inbound_attackers += usize::from(is_attacker);
                s.inbound_honest += usize::from(is_honest);
            }
            _ => {}
        }
    }
    for p in &mesh {
        s.mesh_self_dialed += usize::from(r.first.get(p).is_some_and(|f| f.is_outbound()));
        s.mesh_honest += usize::from(honest.contains(p));
    }
    let me = peer_of(victim);
    let mut per_bucket: std::collections::BTreeMap<u32, [usize; 4]> = std::collections::BTreeMap::new();
    for (b, peers) in &r.eligible_by_bucket {
        let e = per_bucket.entry(*b).or_default();
        e[0] += peers.iter().filter(|p| honest.contains(*p)).count();
        e[1] += peers.iter().filter(|p| attackers.contains(*p)).count();
    }
    for peer in r.topup.keys() {
        if let Some(b) = bucket_of(&me, peer) {
            let e = per_bucket.entry(b).or_default();
            e[2] += usize::from(honest.contains(peer));
            e[3] += usize::from(attackers.contains(peer));
        }
    }
    s.buckets = per_bucket
        .iter()
        .map(|(b, [eh, ea, th, ta])| format!("b{b}:eligible={eh}h/{ea}a,topup={th}h/{ta}a"))
        .collect::<Vec<_>>()
        .join(" ");
    s
}

/// Leave the topic, wait out the backoff, join again, read the mesh (S1:
/// each re-formation draws afresh from the same connections).
fn reform(victim: &Node, honest: &HashSet<String>) -> Reform {
    victim.unsubscribe(ANNOUNCEMENTS_TOPIC).expect("unsubscribe");
    std::thread::sleep(A6_REJOIN_AFTER);
    victim.subscribe(ANNOUNCEMENTS_TOPIC).expect("subscribe");
    std::thread::sleep(A6_READ_MESH_AFTER);
    let r = report(victim);
    let mesh = victim.mesh_peers(ANNOUNCEMENTS_TOPIC).expect("mesh");
    Reform {
        mesh: mesh.len(),
        mesh_self_dialed: mesh.iter().filter(|p| r.first.get(*p).is_some_and(|f| f.is_outbound())).count(),
        mesh_honest: mesh.iter().filter(|p| honest.contains(*p)).count(),
    }
}

/// A ① node: the 127.0.0.1 P6 whitelist and the short prune backoff.
fn spawn_a6(dir: &tempfile::TempDir, name: &str, bootstrap: Vec<String>) -> Node {
    spawn_with(dir, name, bootstrap, |n| n.with_p6_loopback_whitelist().with_prune_backoff(A6_PRUNE_BACKOFF))
}

/// One round with fresh PeerIds. `None` when the attackers did not fill the
/// victim's 24 inbound slots before the release (S4): such a round measured
/// nothing and is not counted.
fn run_round(p: &Policy, label: &str) -> Option<Readings> {
    let dir = tempfile::tempdir().unwrap();
    let honest_boot = spawn_a6(&dir, "honest-boot", vec![]);
    let honest: Vec<Node> =
        (0..A6_HONEST).map(|i| spawn_a6(&dir, &format!("honest-{i}"), vec![addr(&honest_boot)])).collect();
    let mut boots = vec![spawn_a6(&dir, "attacker-boot-0", vec![])];
    for j in 1..A6_ATTACKER_BOOTSTRAPS {
        let b = spawn_a6(&dir, &format!("attacker-boot-{j}"), vec![addr(&boots[0])]);
        boots.push(b);
    }
    let attacker_addrs: Vec<String> = boots.iter().map(addr).collect();
    assert!(
        eventually(60, || honest_boot.dht_peers().len() >= A6_HONEST * 3 / 4),
        "the honest side must be connected first ({} of {A6_HONEST})",
        honest_boot.dht_peers().len()
    );
    let gene = id(&format!("a6-{label}"));
    let publisher = honest[0].local_peer_id().0;
    let ann = honest[0].announce(&announcement(&gene, "a6-target")).expect("announce");
    assert!(ann.record_acked >= 1, "the honest gene is stored on the honest side: {ann:?}");

    let mut victim_boot = attacker_addrs.clone();
    victim_boot.push(addr(&honest_boot));
    let mesh_outbound_min = p.mesh_outbound_min;
    let victim = spawn_with(&dir, "victim", victim_boot, |n| {
        n.with_max_established_incoming(A6_VICTIM_INBOUND)
            .with_p6_loopback_whitelist()
            .with_outbound_paused(true, true)
            .with_unsubscribe_backoff(A6_UNSUBSCRIBE_BACKOFF)
            .with_prune_backoff(A6_PRUNE_BACKOFF)
            .with_mesh_outbound_min(mesh_outbound_min)
    });
    let attackers: Vec<Node> = (0..A6_ATTACKERS)
        .map(|i| {
            spawn_a6(&dir, &format!("attacker-{i}"), vec![addr(&victim), attacker_addrs[i % A6_ATTACKER_BOOTSTRAPS].clone()])
        })
        .collect();
    let attacker_ids: HashSet<String> = boots.iter().chain(attackers.iter()).map(|n| n.local_peer_id().0).collect();
    let honest_ids: HashSet<String> =
        std::iter::once(&honest_boot).chain(honest.iter()).map(|n| n.local_peer_id().0).collect();

    // S4: release only once the attackers hold all 24 inbound slots.
    let inbound_attackers = || {
        report(&victim).first.iter().filter(|(p, f)| **f == FirstConnection::Inbound && attacker_ids.contains(*p)).count()
    };
    let filled = eventually(20, || inbound_attackers() == A6_VICTIM_INBOUND as usize);
    let at_release = inbound_attackers();
    println!(
        "A6 ① policy={} round={label} inbound_attackers_at_release={at_release} valid={}",
        p.label, filled
    );
    if !filled {
        return None;
    }
    if p.attackers_first {
        // Every attacker, connected or not: connected ones the victim dialled
        // are adopted, unconnected ones dialled; ones that dialled in are
        // skipped by the candidate rules as always.
        let preferred: Vec<(libp2p::PeerId, Vec<Multiaddr>)> =
            attackers.iter().map(|n| (peer_of(n), vec![addr(n).parse().expect("multiaddr")])).collect();
        victim.prefer_candidates(preferred).expect("prefer");
    }
    let released = Instant::now();
    victim.set_outbound_paused(!p.topup, false).expect("release");

    let mut samples = Vec::new();
    for at in A6_SAMPLE_AT {
        std::thread::sleep(Duration::from_secs(at).saturating_sub(released.elapsed()));
        let s = sample(&victim, at, &attacker_ids, &honest_ids);
        println!(
            "A6 ① policy={} round={label} t={}s topup={} (adopted={} dialled={}) topup_attackers={} topup_honest={} \
             mesh={} mesh_self_dialed={} mesh_honest={} kad_dialled_attackers={} kad_dialled_honest={} bootstrap={} \
             inbound_attackers={} inbound_honest={} connections in={} out={} \
             routing_table={} eligible={} round_dials={} round_failures={} shortfall_walks={}",
            p.label,
            s.at,
            s.topup,
            s.topup_adopted,
            s.topup_dialled,
            s.topup_attackers,
            s.topup_honest,
            s.mesh,
            s.mesh_self_dialed,
            s.mesh_honest,
            s.kad_attackers,
            s.kad_honest,
            s.bootstrap,
            s.inbound_attackers,
            s.inbound_honest,
            s.connections_in,
            s.connections_out,
            s.routing_table,
            s.eligible,
            s.dials,
            s.failures,
            s.shortfall_walks
        );
        println!("A6 ① policy={} round={label} t={}s buckets {}", p.label, s.at, s.buckets);
        samples.push(s);
    }
    let mut reforms = Vec::new();
    for i in 0..A6_REFORMS {
        let m = reform(&victim, &honest_ids);
        println!(
            "A6 ① policy={} round={label} reform={i} mesh={} mesh_self_dialed={} mesh_honest={} valid={}",
            p.label,
            m.mesh,
            m.mesh_self_dialed,
            m.mesh_honest,
            m.valid()
        );
        reforms.push(m);
    }
    let finds_honest_gene = victim
        .search(super::discover::SearchQuery::GeneId(gene.clone()))
        .map(|o| o.hits.iter().any(|h| h.publisher == publisher))
        .unwrap_or(false);
    drop((attackers, boots, honest, honest_boot));
    Some(Readings { samples, reforms, finds_honest_gene })
}

/// Three valid rounds of `p`, each judged and printed.
fn run_rounds(p: &Policy, run: usize) -> Vec<Verdict> {
    let mut verdicts = Vec::new();
    let (mut invalid_in_a_row, mut tried) = (0, 0);
    while verdicts.len() < A6_ROUNDS {
        tried += 1;
        let label = format!("{run}.{tried}");
        match run_round(p, &label) {
            Some(r) => {
                invalid_in_a_row = 0;
                let v = judge(&r);
                println!(
                    "A6 ① policy={} round={label} verdict a={} b={} c+d={} e={} e_rate={:.2} green={} \
                     invalid_reforms_with_honest={} finds_honest_gene={}",
                    p.label,
                    ok(v.a),
                    ok(v.b),
                    ok(v.cd),
                    ok(v.e),
                    v.e_rate,
                    ok(v.green()),
                    v.invalid_with_honest,
                    r.finds_honest_gene
                );
                if v.invalid_with_honest > A6_INVALID_WITH_HONEST_MAX {
                    setup_invalid(format!(
                        "policy={} round={label}: {} of {A6_REFORMS} re-formations short of mesh_n_low with an honest peer \
                         (more than {A6_INVALID_WITH_HONEST_MAX}); fix the setup from the readings and rerun",
                        p.label, v.invalid_with_honest
                    ));
                }
                verdicts.push(v);
            }
            None => {
                invalid_in_a_row += 1;
                if invalid_in_a_row >= A6_INVALID_MAX {
                    setup_invalid(format!(
                        "policy={}: {invalid_in_a_row} rounds in a row without {A6_VICTIM_INBOUND} inbound attackers at release",
                        p.label
                    ));
                }
            }
        }
    }
    verdicts
}

fn ok(pass: bool) -> &'static str {
    if pass { "pass" } else { "RED" }
}

/// S2: a red round reruns the whole test once with new PeerIds; red in both
/// runs fails, and both runs' readings are in the output.
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_self_chosen_outbound_route1() {
    let policy = Policy { label: "route1", topup: true, mesh_outbound_min: 3, attackers_first: false };
    let first = run_rounds(&policy, 1);
    if first.iter().all(Verdict::green) {
        return;
    }
    println!("A6 ① policy=route1 run 1 had a red round: rerunning once with new PeerIds (S2)");
    let second = run_rounds(&policy, 2);
    assert!(
        second.iter().all(Verdict::green),
        "red in two runs in a row: run 1 {first:?}, run 2 {second:?}"
    );
}

/// Control for a: top-up never released (the code before A6).
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_self_chosen_outbound_control_a_no_topup() {
    let policy = Policy { label: "control-a", topup: false, mesh_outbound_min: 3, attackers_first: false };
    let verdicts = run_rounds(&policy, 1);
    assert!(verdicts.iter().any(|v| !v.a), "without top-up, a must go red: {verdicts:?}");
}

/// Control for b: libp2p's `mesh_outbound_min` of 2. If it cannot go red,
/// §10 row 3 applies (b printed only; the small setup above stays).
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_self_chosen_outbound_control_b_mesh_outbound_min_2() {
    let policy = Policy { label: "control-b", topup: true, mesh_outbound_min: 2, attackers_first: false };
    let verdicts = run_rounds(&policy, 1);
    assert!(verdicts.iter().any(|v| !v.b), "with mesh_outbound_min 2, b must go red: {verdicts:?}");
}

/// Control for c+d: attackers first among top-up's candidates, connected
/// adoptable ones included (as if the candidate rules were missing).
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_self_chosen_outbound_control_cd_attackers_first() {
    let policy = Policy { label: "control-cd", topup: true, mesh_outbound_min: 3, attackers_first: true };
    let verdicts = run_rounds(&policy, 1);
    assert!(verdicts.iter().any(|v| !v.cd), "with attackers first among candidates, c+d must go red: {verdicts:?}");
}

/// Control for e: no top-up and `mesh_outbound_min` 2 (the code before A6),
/// the same independent re-formations. Printed, not asserted: the design's
/// simulation puts a single round's red rate at about 37 %.
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_self_chosen_outbound_control_e_before_a6() {
    let policy = Policy { label: "control-e", topup: false, mesh_outbound_min: 2, attackers_first: false };
    let verdicts = run_rounds(&policy, 1);
    let red = verdicts.iter().filter(|v| !v.e).count();
    println!("A6 ① policy=control-e rounds_with_e_red={red} of {}", verdicts.len());
}

// ---------------------------------------------------------------------
// ① b, the small setup (design v5 §10 row 3, Codex 7; red team v5 N1).
//
// The victim has exactly 6 peers, all in its mesh (`mesh_n` 6): 4 that
// dialled it, 2 it dialled. It then dials W. With `mesh_outbound_min` 3 its
// heartbeat must graft W, the only outbound candidate, within 3 s; with 2 it
// must not (the control).
//
// N1: W must not graft the victim on its own. W's mesh is filled first by 6
// helpers that dial W; an empty mesh would make W GRAFT the victim whatever
// the victim's setting. The helpers take no inbound connections, so the
// victim's Kademlia, which learns them from W, cannot dial them and add
// other outbound candidates.
// ---------------------------------------------------------------------

const B_SMALL_HELPERS: usize = 6;
const B_SMALL_WITHIN: Duration = Duration::from_secs(3);
/// GossipSub's first heartbeat runs `heartbeat_initial_delay` (5 s) plus one
/// interval (1 s) after start. The victim's mesh fills from its peers' GRAFTs
/// well before that, so W is only dialled once the heartbeat is running.
const B_SMALL_HEARTBEAT_RUNNING: Duration = Duration::from_secs(7);

/// The victim's mesh on the announcements topic, and the peers in it whose
/// first connection the victim dialled (gossipsub's outbound).
fn mesh_outbound(node: &Node) -> (Vec<String>, Vec<String>) {
    let mesh = node.mesh_peers(ANNOUNCEMENTS_TOPIC).expect("mesh peers");
    let first = report(node).first;
    let outbound = mesh
        .iter()
        .filter(|p| first.get(*p).is_some_and(|f| *f != FirstConnection::Inbound))
        .cloned()
        .collect();
    (mesh, outbound)
}

fn setup_invalid(msg: String) -> ! {
    panic!("A6 SETUP INVALID: {msg}")
}

/// Run the small setup; returns (outbound peers in the victim's mesh at
/// most, whether W was ever in it) over the 3 s after the victim and W
/// connected.
fn run_b_small(label: &str, mesh_outbound_min: usize) -> (usize, bool) {
    let dir = tempfile::tempdir().expect("temp dir");
    let w = spawn_listed(&dir, "w", vec![]);
    let w_peer = w.local_peer_id().0;
    let helpers: Vec<Node> = (0..B_SMALL_HELPERS)
        .map(|i| {
            spawn_with(&dir, &format!("helper{i}"), vec![addr(&w)], |n| {
                n.with_p6_loopback_whitelist().with_max_established_incoming(0)
            })
        })
        .collect();
    if !eventually(30, || w.mesh_peers(ANNOUNCEMENTS_TOPIC).map(|m| m.len()).unwrap_or(0) >= 5) {
        setup_invalid(format!("{label}: W's mesh never reached mesh_n_low 5 (N1 needs it full elsewhere)"));
    }

    let victim_started = Instant::now();
    let victim = spawn_with(&dir, "victim", vec![], |n| {
        // Exactly the 4 designed inbound peers fit: the helpers, which learn
        // the victim from W, cannot dial in and swell its mesh.
        n.with_p6_loopback_whitelist()
            .with_mesh_outbound_min(mesh_outbound_min)
            .with_outbound_paused(true, true)
            .with_max_established_incoming(4)
    });
    let outs: Vec<Node> = (0..2).map(|i| spawn_listed(&dir, &format!("out{i}"), vec![])).collect();
    for o in &outs {
        victim.dial_always(addr(o).parse().expect("addr")).expect("dial");
    }
    let ins: Vec<Node> = (0..4).map(|i| spawn_listed(&dir, &format!("in{i}"), vec![addr(&victim)])).collect();
    if let Some(rest) = B_SMALL_HEARTBEAT_RUNNING.checked_sub(victim_started.elapsed()) {
        std::thread::sleep(rest);
    }
    let ready = eventually(30, || {
        let (mesh, outbound) = mesh_outbound(&victim);
        victim.connected_peers().len() == 6 && mesh.len() == 6 && outbound.len() == 2
    });
    let (mesh, outbound) = mesh_outbound(&victim);
    if !ready {
        setup_invalid(format!(
            "{label}: before W, want 6 connected / mesh 6 / 2 outbound in mesh; got {} / {} / {}",
            victim.connected_peers().len(),
            mesh.len(),
            outbound.len()
        ));
    }
    let w_mesh = w.mesh_peers(ANNOUNCEMENTS_TOPIC).expect("W mesh").len();

    victim.dial_always(addr(&w).parse().expect("addr")).expect("dial W");
    if !eventually(10, || victim.connected_peers().contains(&w_peer)) {
        setup_invalid(format!("{label}: the victim never connected to W"));
    }
    let start = Instant::now();
    let (mut most, mut w_in) = (outbound.len(), false);
    while start.elapsed() < B_SMALL_WITHIN {
        let (mesh, outbound) = mesh_outbound(&victim);
        most = most.max(outbound.len());
        w_in |= mesh.contains(&w_peer);
        std::thread::sleep(Duration::from_millis(100));
    }
    let (mesh, outbound) = mesh_outbound(&victim);
    let connected = victim.connected_peers().len();
    let w_grafts_victim = w.mesh_peers(ANNOUNCEMENTS_TOPIC).expect("W mesh").contains(&victim.local_peer_id().0);
    println!(
        "A6 ①b-small {label} mesh_outbound_min={mesh_outbound_min} w_mesh_before={w_mesh} \
         outbound_in_mesh_most={most} w_in_mesh={w_in} end: connected={connected} mesh={} outbound={} \
         victim_in_w_mesh={w_grafts_victim}",
        mesh.len(),
        outbound.len()
    );
    drop((helpers, outs, ins));
    (most, w_in)
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_mesh_outbound_min_grafts_a_new_outbound_peer() {
    let (most, w_in) = run_b_small("route1", 3);
    assert!(
        most >= 3 && w_in,
        "with mesh_outbound_min 3 the heartbeat must graft W within 3 s: outbound in mesh {most}, W in mesh {w_in}"
    );
}

/// Control: libp2p's `mesh_outbound_min` of 2 is already met, so W stays out.
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_mesh_outbound_min_control_2_leaves_w_out() {
    let (most, w_in) = run_b_small("control-b", 2);
    assert!(
        most < 3 && !w_in,
        "control must be red: with mesh_outbound_min 2, outbound in mesh {most}, W in mesh {w_in}"
    );
}

// ---------------------------------------------------------------------
// ② Bootstrap keeper (design v3 §2, §5.3)
// ---------------------------------------------------------------------

/// A node that never dials anyone by policy, so a reconnection can only
/// come from the victim's keeper.
fn spawn_quiet_bootstrap(dir: &tempfile::TempDir, name: &str, port: u16) -> Node {
    let mut cfg = config(vec![]);
    cfg.listen_port = port;
    let node = Node::with_keypair_path(cfg, dir.path().join(format!("{name}.key")))
        .expect("build node")
        .with_outbound_paused(true, true);
    let mut node = node;
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

/// Regression (T-156 acceptance round 2): a bootstrap node with no free
/// inbound slot completes the handshake and then denies the connection. The
/// keeper must treat that as a failure and back off 1 → 16 s (±20 %), not
/// redial at once: before the fix it dialled about 2,500 times in 10 s.
/// Shortest waits are 0.8, 1.6, 3.2, 6.4 s, so any 10 s window holds at most
/// 4 dials (0.8 + 1.6 + 3.2 = 5.6 s, adding 6.4 s passes 10 s). It must keep
/// trying: by 16 s, at least 3 dials (waits of at most 1.2, 2.4, 4.8 s).
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 keeper — enable the p2p-integration feature or run with --ignored")]
fn a6_bootstrap_keeper_backs_off_from_a_full_bootstrap() {
    let (d1, d2, d3) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let mut cfg = config(vec![]);
    cfg.listen_port = 0;
    let mut boot = Node::with_keypair_path(cfg, d1.path().join("boot.key")).expect("build").with_max_established_incoming(1);
    boot.start().expect("start");
    let filler = spawn_with(&d2, "filler", vec![addr(&boot)], |n| n);
    assert!(eventually(10, || bootstraps_connected(&filler) == 1), "the filler takes the only inbound slot");
    let victim = spawn_with(&d3, "victim", vec![addr(&boot)], |n| n);
    std::thread::sleep(Duration::from_secs(6));
    let at6 = report(&victim).keeper_dials;
    std::thread::sleep(Duration::from_secs(10));
    let at16 = report(&victim).keeper_dials;
    let denied = boot.connection_denials().inbound_limit;
    println!("A6 ② full_bootstrap keeper_dials at_6s={at6} at_16s={at16} in_10s={} boot_denied_inbound={denied}", at16 - at6);
    let _ = boot.stop();
    assert!(at16 - at6 <= 4, "backoff: at most 4 dials in any 10 s window, got {}", at16 - at6);
    assert!(at16 >= 3, "the keeper must keep trying: at least 3 dials by 16 s, got {at16}");
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
// ③ Nodes that cannot take inbound still get in, and ordinary nodes still
// reach 8 self-dialled peers (K1, design v3 §5.4).
// ---------------------------------------------------------------------

const A6_ORDINARY: usize = 24;
const A6_ORDINARY_FALLBACK: usize = 30;
const A6_OUTBOUND_ONLY: usize = 30;

/// Whether every ordinary node reached 8 self-dialled peers, and whether a
/// shortfall came from running out of pairs (a node dialled first by more
/// than n − 1 − 8 others).
fn run_outbound_only(ordinary_n: usize) -> (bool, bool) {
    let dir = tempfile::tempdir().unwrap();
    let started = Instant::now();
    let first = spawn_listed(&dir, "ordinary-0", vec![]);
    let mut ordinary = vec![first];
    for i in 1..ordinary_n {
        let n = spawn_listed(&dir, &format!("ordinary-{i}"), vec![addr(&ordinary[0])]);
        ordinary.push(n);
    }
    let ordinary_addrs: Vec<String> = ordinary.iter().map(addr).collect();
    let dial_only: Vec<Node> = (0..A6_OUTBOUND_ONLY)
        .map(|i| {
            spawn_with(&dir, &format!("outbound-only-{i}"), vec![ordinary_addrs[i % ordinary_n].clone()], |n| {
                n.with_max_established_incoming(0).with_p6_loopback_whitelist()
            })
        })
        .collect();
    let joined_at = Instant::now();
    let all_connected = eventually(30, || dial_only.iter().all(|n| !n.connected_peers().is_empty()));
    let gene = id(&format!("a6-outbound-only-{ordinary_n}"));
    let heard_all = eventually(30u64.saturating_sub(joined_at.elapsed().as_secs()).max(5), || {
        let _ = ordinary[1].publish(ANNOUNCEMENTS_TOPIC, &encode_announcement(&announcement(&gene, "a6-outbound-only")));
        std::thread::sleep(Duration::from_millis(500));
        dial_only.iter().all(|n| heard(n, &gene))
    });
    let heard_count = dial_only.iter().filter(|n| heard(n, &gene)).count();
    println!(
        "A6 ③ ordinary={ordinary_n} outbound_only={A6_OUTBOUND_ONLY} all_connected={all_connected} heard={heard_count}/{A6_OUTBOUND_ONLY} \
         heard_all={heard_all} after={:.1}s",
        joined_at.elapsed().as_secs_f64()
    );
    std::thread::sleep(Duration::from_secs(60).saturating_sub(started.elapsed()));
    let ordinary_ids: HashSet<String> = ordinary.iter().map(|n| n.local_peer_id().0).collect();
    let mut short = 0;
    let mut exhausted = false;
    for (i, n) in ordinary.iter().enumerate() {
        let r = report(n);
        let self_dialled = r.first.values().filter(|f| f.is_outbound()).count();
        let dialled_in_by_ordinary = r
            .first
            .iter()
            .filter(|(p, f)| **f == FirstConnection::Inbound && ordinary_ids.contains(*p))
            .count();
        let by_kind = |k: FirstConnection| r.first.values().filter(|f| **f == k).count();
        println!(
            "A6 ③ ordinary={ordinary_n} node={i} self_dialled={self_dialled} topup={} bootstrap={} kad_dialled={} \
             dialled_in_by_ordinary={dialled_in_by_ordinary} inbound_total={}",
            r.topup_peers,
            by_kind(FirstConnection::Bootstrap),
            by_kind(FirstConnection::OtherDial),
            by_kind(FirstConnection::Inbound)
        );
        if self_dialled < 8 {
            short += 1;
            exhausted |= dialled_in_by_ordinary > ordinary_n - 1 - 8;
        }
    }
    println!("A6 ③ ordinary={ordinary_n} short_of_8={short} pairs_exhausted={exhausted}");
    assert!(all_connected, "every outbound-only node must connect to someone within 30 s");
    assert_eq!(heard_count, A6_OUTBOUND_ONLY, "every outbound-only node must hear an announcement");
    (short == 0, exhausted)
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_outbound_only_nodes_join() {
    let (ok, exhausted) = run_outbound_only(A6_ORDINARY);
    if ok {
        return;
    }
    // The fallback fixed in advance (design v3 §5.4): only when the pairs
    // ran out, never for any other shortfall.
    assert!(exhausted, "an ordinary node is short of 8 self-dialled peers with pairs to spare");
    println!("A6 ③ pairs ran out with {A6_ORDINARY} ordinary nodes: rerunning with {A6_ORDINARY_FALLBACK}");
    let (ok, _) = run_outbound_only(A6_ORDINARY_FALLBACK);
    assert!(ok, "every ordinary node needs 8 self-dialled peers");
}

// ---------------------------------------------------------------------
// ④ P6 (design v3 §3, §5.5). No whitelist here.
// ---------------------------------------------------------------------

/// Peers on one IP from 11 to 16: one holds a valid proof of registration,
/// one is anonymous. The registered one scores P6 + 20, the anonymous one
/// P6; the anonymous one is still heard at 11 and no longer at 14. The
/// same-IP counters move as they should.
///
/// The victim scores only P5 and P6, so the score it reports is exactly P6
/// (+ 20): with the behaviour and slow-peer penalties on, a slow CI runner
/// read −5.12 for −5 (〔T-156〕). Those two only push a score further down.
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
        .with_score_refresh_interval(Duration::from_secs(1))
        .with_p5_p6_only_scores();
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

// ---------------------------------------------------------------------
// ①-拨: disconnect a batch, so top-up has to dial (design v5 §5.9.1, F3;
// red team v5 N3).
//
// 1 bootstrap node and 16 honest nodes, the victim last: its Kademlia
// queries dial most of them, so they are adoptable and top-up adopts 8.
// The honest nodes are quiet from the start (top-up and random walk held;
// they still answer): otherwise their own top-up finds the victim and
// dials it first, which makes them inbound-first and not adoptable (first
// try: 10 of 16 inbound-first, 6 adoptable, SETUP INVALID). And the victim
// joins only once the honest nodes are all connected to one another:
// Kademlia's automatic bootstrap (500 ms after a new entry, in a table of
// fewer than 20) has no switch: a query still running when the victim
// joins learns it from the answers and dials it first. So the victim waits
// for a fully connected honest side and then DIAL_HONEST_SETTLE more.
// Then the victim drops every peer it could adopt (top-up peers fall to 0)
// and one of them is stopped. The dropped nodes go quiet (no top-up, no
// keeper, no random walk, Kademlia's periodic bootstrap off from the start)
// and the victim's own random walk is held, so the only outbound dials the
// victim makes are top-up's. Top-up must get back to 8 by dialling.
//
// The stopped node is put first among top-up's candidates, so the first
// round always dials it: otherwise 8 live candidates could fill the budget
// and "a dial failed" would be left to chance. Preferred candidates still
// pass top-up's eligibility, so a broken cooldown would redial it.
// ---------------------------------------------------------------------

const DIAL_HONEST: usize = 16;
/// N3: 8 must be dialled back and 1 is stopped.
const DIAL_ADOPTABLE_MIN: usize = 9;
const DIAL_SETTLE: Duration = Duration::from_secs(60);
/// Quiet time between a fully connected honest side and the victim joining.
const DIAL_HONEST_SETTLE: Duration = Duration::from_secs(15);
const DIAL_BACK_WITHIN: u64 = 40;
const DIAL_WATCH_UNTIL: u64 = 60;
const DIAL_SAMPLE_EVERY: u64 = 5;

#[derive(Debug, Default, Clone)]
struct DialSample {
    at: u64,
    topup: usize,
    adopted: usize,
    dialled: usize,
    routing_table: usize,
    eligible: usize,
    /// Top-up dials sent and failed since the drop.
    dials: usize,
    failures: usize,
    stopped_cooling: bool,
    stopped_is_topup: bool,
    /// Dropped nodes connected again by anything other than top-up.
    reconnected_otherwise: usize,
}

/// A ①-拨 node: whitelist, Kademlia's periodic bootstrap off.
fn spawn_dial(dir: &tempfile::TempDir, name: &str, bootstrap: Vec<String>) -> Node {
    spawn_with(dir, name, bootstrap, |n| n.with_p6_loopback_whitelist().with_kad_periodic_bootstrap_off())
}

fn run_dial_path(label: &str, adopt_only: bool) -> Vec<DialSample> {
    let dir = tempfile::tempdir().expect("temp dir");
    let boot = spawn_dial(&dir, "boot", vec![]);
    let mut honest: Vec<Node> = (0..DIAL_HONEST)
        .map(|i| {
            let n = spawn_with(&dir, &format!("honest-{i}"), vec![addr(&boot)], |n| {
                n.with_p6_loopback_whitelist().with_kad_periodic_bootstrap_off().with_outbound_paused(true, false)
            });
            n.set_walk_paused(true).expect("quiet");
            n
        })
        .collect();
    let full = |n: &Node| n.connected_peers().len() >= DIAL_HONEST;
    let meshed = eventually(60, || full(&boot) && honest.iter().all(full));
    let fewest = honest.iter().map(|n| n.connected_peers().len()).min().unwrap_or(0);
    println!("A6 ①-拨 {label} honest side: fewest connections {fewest} of {DIAL_HONEST}, boot {}", boot.connected_peers().len());
    if !meshed {
        setup_invalid(format!("①-拨 {label}: the honest side is not fully connected within 60 s (fewest {fewest} of {DIAL_HONEST})"));
    }
    // Let the honest side's own Kademlia bootstrap queries finish: one still
    // running when the victim joins learns it from the answers and dials it
    // first (with no wait: 9 of 16 did; with this one, none).
    std::thread::sleep(DIAL_HONEST_SETTLE);
    let victim = spawn_with(&dir, "victim", vec![addr(&boot)], |n| {
        let n = n.with_p6_loopback_whitelist().with_kad_periodic_bootstrap_off().with_outbound_paused(true, false);
        if adopt_only { n.with_adopt_only() } else { n }
    });
    victim.set_outbound_paused(false, false).expect("release top-up");

    // Precondition: 8 top-up peers, and at least 9 peers it could adopt (N3).
    let adoptable = |r: &OutboundReport| {
        r.first.values().filter(|f| matches!(f, FirstConnection::OtherDial | FirstConnection::Restart | FirstConnection::TopUp)).count()
    };
    let settled = eventually(DIAL_SETTLE.as_secs(), || {
        let r = report(&victim);
        r.topup_peers >= 8 && adoptable(&r) >= DIAL_ADOPTABLE_MIN
    });
    let vid = victim.local_peer_id().0;
    let dialled_victim = honest.iter().filter(|n| report(n).first.get(&vid).is_some_and(|f| *f != FirstConnection::Inbound)).count();
    let r = report(&victim);
    println!(
        "A6 ①-拨 {label} before: topup={} adoptable={} first_inbound={} connected={} honest_that_dialled_the_victim={dialled_victim}",
        r.topup_peers,
        adoptable(&r),
        r.first.values().filter(|f| **f == FirstConnection::Inbound).count(),
        victim.connected_peers().len()
    );
    if !settled {
        setup_invalid(format!(
            "①-拨 {label}: within {}s want topup >= 8 and adoptable >= {DIAL_ADOPTABLE_MIN}; got {} and {}",
            DIAL_SETTLE.as_secs(),
            r.topup_peers,
            adoptable(&r)
        ));
    }

    // The drop: quiet first, then stop one, hold the victim's walk, drop all.
    let dropped: HashSet<String> = r
        .first
        .iter()
        .filter(|(_, f)| matches!(f, FirstConnection::OtherDial | FirstConnection::Restart | FirstConnection::TopUp))
        .map(|(p, _)| p.clone())
        .collect();
    for n in honest.iter().filter(|n| dropped.contains(&n.local_peer_id().0)) {
        n.set_outbound_paused(true, true).expect("quiet");
        n.set_walk_paused(true).expect("quiet");
    }
    let stopped_at = honest.iter().position(|n| dropped.contains(&n.local_peer_id().0)).expect("a dropped honest node");
    let mut stopped_node = honest.remove(stopped_at);
    let stopped = stopped_node.local_peer_id().0;
    let stopped_addr: Multiaddr = addr(&stopped_node).parse().expect("addr");
    victim.prefer_candidates(vec![(stopped.parse().expect("PeerId"), vec![stopped_addr])]).expect("prefer");
    victim.set_walk_paused(true).expect("hold the walk");
    let _ = stopped_node.stop();
    for p in &dropped {
        victim.disconnect(p.parse().expect("PeerId")).expect("disconnect");
    }
    let t0 = Instant::now();
    let base = report(&victim).last_round;
    let (dials0, failures0) = (base.dials_total, base.failures_total);

    let mut samples = Vec::new();
    let mut at = DIAL_SAMPLE_EVERY;
    while at <= DIAL_WATCH_UNTIL {
        std::thread::sleep(Duration::from_secs(at).saturating_sub(t0.elapsed()));
        let r = report(&victim);
        let s = DialSample {
            at,
            topup: r.topup_peers,
            adopted: r.topup.values().filter(|w| **w == TopUpWay::Adopted).count(),
            dialled: r.topup.values().filter(|w| **w == TopUpWay::Dialled).count(),
            routing_table: r.last_round.routing_table,
            eligible: r.last_round.eligible,
            dials: r.last_round.dials_total - dials0,
            failures: r.last_round.failures_total - failures0,
            stopped_cooling: r.cooling.contains(&stopped),
            stopped_is_topup: r.topup.contains_key(&stopped),
            reconnected_otherwise: dropped
                .iter()
                .filter(|p| r.first.get(*p).is_some_and(|f| *f != FirstConnection::TopUp))
                .count(),
        };
        println!(
            "A6 ①-拨 {label} t0+{}s topup={} (adopted={} dialled={}) routing_table={} eligible={} dials={} failures={} \
             stopped_cooling={} stopped_is_topup={} dropped_reconnected_otherwise={}",
            s.at,
            s.topup,
            s.adopted,
            s.dialled,
            s.routing_table,
            s.eligible,
            s.dials,
            s.failures,
            s.stopped_cooling,
            s.stopped_is_topup,
            s.reconnected_otherwise
        );
        samples.push(s);
        at += DIAL_SAMPLE_EVERY;
    }
    drop((honest, boot));
    samples
}

/// The first assertion of §5.9.1: by t0+40 s top-up is back to 8, all dialled.
fn dialled_back(samples: &[DialSample]) -> bool {
    samples.iter().any(|s| s.at <= DIAL_BACK_WITHIN && s.topup >= 8 && s.adopted == 0 && s.dialled >= 8)
}

#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_topup_dials_back_after_a_drop() {
    let samples = run_dial_path("route1", false);
    assert!(dialled_back(&samples), "top-up must be back to 8 dialled peers by t0+{DIAL_BACK_WITHIN}s: {samples:?}");
    let by = |t: u64| samples.iter().filter(move |s| s.at <= t);
    assert!(
        by(DIAL_BACK_WITHIN).any(|s| s.dials >= 8 && s.failures >= 1),
        "by t0+{DIAL_BACK_WITHIN}s at least 8 dials and 1 failure: {samples:?}"
    );
    assert!(samples.iter().all(|s| !s.stopped_is_topup), "the stopped node can never be a top-up peer");
    // The failed one cools down: seen cooling, and the next round (10 s on)
    // adds no failure.
    let first_fail = samples.iter().find(|s| s.failures >= 1).expect("a failure");
    assert!(first_fail.stopped_cooling, "the stopped node must be cooling once its dial failed: {first_fail:?}");
    let next_round = samples.iter().find(|s| s.at >= first_fail.at + 10).expect("a sample a round later");
    assert_eq!(
        next_round.failures, first_fail.failures,
        "the next round must not dial the cooling node again: {samples:?}"
    );
    // a, as always: from t0+40 s to t0+60 s top-up stays at 8.
    assert!(
        samples.iter().filter(|s| s.at >= DIAL_BACK_WITHIN).all(|s| s.topup >= 8),
        "a: top-up peers >= 8 from t0+{DIAL_BACK_WITHIN}s to t0+{DIAL_WATCH_UNTIL}s: {samples:?}"
    );
}

/// Control: adopt only, never dial. Top-up cannot come back, so the first
/// assertion must be red; if it is not, something else dials in this setup.
#[test]
#[cfg_attr(not(feature = "p2p-integration"), ignore = "A6 acceptance — enable the p2p-integration feature or run with --ignored")]
fn a6_topup_dials_back_control_adopt_only() {
    let samples = run_dial_path("control-adopt-only", true);
    assert!(!dialled_back(&samples), "control must be red: adopt-only came back to 8 dialled peers: {samples:?}");
    assert!(samples.iter().all(|s| s.dialled == 0), "adopt-only must dial nobody: {samples:?}");
}
