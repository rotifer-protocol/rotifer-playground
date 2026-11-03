//! Looking a gene up across the network (A2 design v2 §6).
//!
//! A search for a v2 gene ID gathers candidate publishers, fetches each one's
//! record under the key it would have to sign for, and keeps what passes the
//! frozen record checks. The event loop drives the Kademlia queries;
//! [`Discovery`] holds the rules about which candidates get a place and what
//! counts as found, so they can be tested without a network.
//!
//! - **Seeds first** (§6.1 rule 1): publishers heard on gossip, still fresh,
//!   are candidates before any DHT responder is asked. They do not use a
//!   responder's share, so colluding responders cannot crowd them out.
//! - **Per-responder share** (§6.1 rule 2): one provider response is one
//!   responder; at most [`CANDIDATES_PER_RESPONDER`] new candidates from it.
//! - **Places** (§6.1 rule 3): at most [`MAX_CANDIDATES`] candidates hold a
//!   place. One whose lookup ends with no valid record gives its place back.
//! - **Checked results** (§6.1 rule 4, R21): every value goes through
//!   [`gene_record::validate_record`] under the key we chose. An invalid one
//!   is dropped and the lookup goes on; nothing is charged on a GET.
//! - **Freshness** (§6.3): one rule for every source, judged when the search
//!   runs: shown only if `timestamp_ms ≥ now − 48 h`.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use libp2p::PeerId;

use super::GeneAnnouncement;
use super::gene_record::{self, RecordRejection, ValidRecord};

/// New candidates taken from one provider response (§6.1 rule 2).
pub const CANDIDATES_PER_RESPONDER: usize = 5;

/// Candidates holding a place at once (§6.1 rule 3).
pub const MAX_CANDIDATES: usize = 20;

/// How long a search may take, from the call (§6.2; RFC §5.3's P2P budget).
pub const SEARCH_DEADLINE: Duration = Duration::from_secs(3);

/// What a search looks for.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SearchQuery {
    /// One v2 gene ID: the DHT and announcements heard on gossip.
    GeneId(String),
    /// Words matched against the name and domain of announcements heard on
    /// gossip. The DHT is never searched by keyword (§10.1).
    Keyword(String),
}

/// Where a search result came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HitSource {
    Dht,
    Gossip,
    Both,
}

impl HitSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dht => "dht",
            Self::Gossip => "gossip",
            Self::Both => "both",
        }
    }
}

/// One publisher's claim about one gene.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub announcement: GeneAnnouncement,
    pub publisher: String,
    pub source: HitSource,
    /// The publisher's registered account as this node knows it (A1), for
    /// counting distinct accounts; `None` for an unregistered publisher.
    pub account: Option<String>,
}

/// What a search returns.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    /// The deadline was hit with lookups still running.
    pub timed_out: bool,
    /// Results may be incomplete: the deadline was hit with work
    /// outstanding, or a cap turned a candidate away (§6.1 rule 5).
    pub partial: bool,
}

/// Whether an announcement is fresh enough to show at `now_ms` (§6.3).
pub fn is_fresh(announcement: &GeneAnnouncement, now_ms: u64) -> bool {
    announcement.timestamp_ms >= now_ms.saturating_sub(gene_record::MAX_AGE_MS)
}

/// Whether a keyword query matches an announcement's name or domain,
/// ignoring case.
pub fn matches_keyword(announcement: &GeneAnnouncement, query: &str) -> bool {
    let q = query.trim().to_lowercase();
    !q.is_empty() && (announcement.name.to_lowercase().contains(&q) || announcement.domain.to_lowercase().contains(&q))
}

/// The candidate rules of one gene-ID search.
pub(crate) struct Discovery {
    pub gene_id: String,
    pub now_ms: u64,
    local: PeerId,
    /// Candidates holding a place: looking up, or found.
    holding: HashSet<PeerId>,
    /// Lookups still running.
    looking: HashSet<PeerId>,
    /// The winning valid record per publisher.
    found: HashMap<PeerId, ValidRecord>,
    /// A candidate was turned away by a cap.
    pub capped: bool,
    /// Values that failed the record checks.
    pub invalid: u64,
}

impl Discovery {
    pub fn new(gene_id: String, now_ms: u64, local: PeerId) -> Self {
        Self {
            gene_id,
            now_ms,
            local,
            holding: HashSet::new(),
            looking: HashSet::new(),
            found: HashMap::new(),
            capped: false,
            invalid: 0,
        }
    }

    /// Offer the publishers heard on gossip. Returns the ones whose record
    /// lookup should start.
    pub fn seed(&mut self, publishers: impl IntoIterator<Item = PeerId>) -> Vec<PeerId> {
        publishers.into_iter().filter(|p| self.admit(*p)).collect()
    }

    /// Offer the providers one responder listed. Returns the ones whose
    /// record lookup should start.
    pub fn responder(&mut self, providers: impl IntoIterator<Item = PeerId>) -> Vec<PeerId> {
        let mut taken = Vec::new();
        for p in providers {
            if p == self.local || self.holding.contains(&p) || taken.contains(&p) {
                continue;
            }
            if taken.len() == CANDIDATES_PER_RESPONDER {
                self.capped = true;
                continue;
            }
            if self.admit(p) {
                taken.push(p);
            }
        }
        taken
    }

    fn admit(&mut self, peer: PeerId) -> bool {
        if peer == self.local || self.holding.contains(&peer) {
            return false;
        }
        if self.holding.len() >= MAX_CANDIDATES {
            self.capped = true;
            return false;
        }
        self.holding.insert(peer);
        self.looking.insert(peer);
        true
    }

    /// The key a candidate's record must be under.
    pub fn key_of(&self, candidate: &PeerId) -> Vec<u8> {
        gene_record::record_key(&self.gene_id, candidate)
    }

    /// A value came back for `candidate`'s key. Kept if it passes the
    /// record checks and beats what is held (§2.7 rule 2).
    pub fn record(&mut self, candidate: PeerId, value: &[u8]) -> Result<(), RecordRejection> {
        let valid = gene_record::validate_record(&self.key_of(&candidate), value, self.now_ms).inspect_err(|_| {
            self.invalid += 1;
        })?;
        match self.found.get(&candidate) {
            Some(held) if !valid.supersedes(held) => {}
            _ => {
                self.found.insert(candidate, valid);
            }
        }
        Ok(())
    }

    /// `candidate`'s lookup ended. Without a valid record it gives its place
    /// back.
    pub fn lookup_done(&mut self, candidate: &PeerId) {
        self.looking.remove(candidate);
        if !self.found.contains_key(candidate) {
            self.holding.remove(candidate);
        }
    }

    /// The valid records found, by publisher.
    pub fn found(&self) -> impl Iterator<Item = (&PeerId, &ValidRecord)> {
        self.found.iter()
    }
}

/// Merge DHT records and gossip-heard announcements on `(gene, publisher)`
/// (§6.3): the newer timestamp wins; on a tie the DHT copy, which carries a
/// checked signature over those exact bytes. Stale entries are left out.
pub fn merge(
    dht: impl IntoIterator<Item = (GeneAnnouncement, String)>,
    gossip: impl IntoIterator<Item = (GeneAnnouncement, String)>,
    now_ms: u64,
) -> Vec<(GeneAnnouncement, String, HitSource)> {
    let mut out: Vec<(GeneAnnouncement, String, HitSource)> = Vec::new();
    for (ann, publisher) in dht {
        if is_fresh(&ann, now_ms) {
            out.push((ann, publisher, HitSource::Dht));
        }
    }
    for (ann, publisher) in gossip {
        if !is_fresh(&ann, now_ms) {
            continue;
        }
        match out.iter_mut().find(|(a, p, _)| a.gene_id == ann.gene_id && *p == publisher) {
            Some(entry) => {
                if ann.timestamp_ms > entry.0.timestamp_ms {
                    entry.0 = ann;
                }
                entry.2 = HitSource::Both;
            }
            None => out.push((ann, publisher, HitSource::Gossip)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use libp2p::identity::Keypair;

    fn ann(gene_id: &str, name: &str, ts: u64) -> GeneAnnouncement {
        GeneAnnouncement {
            gene_id: gene_id.into(),
            name: name.into(),
            domain: "text".into(),
            fidelity: "Wrapped".into(),
            ir_spec: String::new(),
            version: "1.0.0".into(),
            timestamp_ms: ts,
        }
    }

    const NOW: u64 = 1_800_000_000_000;
    const G: &str = "v2:abababababababababababababababababababababababababababababababab";

    fn gene_id() -> String {
        format!("v2:{}", "ab".repeat(32))
    }

    fn signed(key: &Keypair, ts: u64) -> Vec<u8> {
        let a = ann(&gene_id(), "g", ts);
        gene_record::sign_record(key, &gene_record::encode_announcement_message(&a)).unwrap()
    }

    #[test]
    fn a_responder_gives_at_most_five_new_candidates() {
        let mut d = Discovery::new(gene_id(), NOW, PeerId::random());
        let listed: Vec<PeerId> = (0..20).map(|_| PeerId::random()).collect();
        let taken = d.responder(listed.clone());
        assert_eq!(taken, listed[..5].to_vec());
        assert!(d.capped, "turning candidates away makes the result partial");
        // Another responder listing the same peers adds five more, not the
        // five already held.
        let taken = d.responder(listed.clone());
        assert_eq!(taken, listed[5..10].to_vec());
    }

    #[test]
    fn seeds_come_first_and_responders_share_what_is_left() {
        let local = PeerId::random();
        let mut d = Discovery::new(gene_id(), NOW, local);
        let seed = PeerId::random();
        assert_eq!(d.seed([seed, local]), vec![seed], "our own PeerId is never a candidate");
        // Four colluding responders, five each: 19 places remain, so the
        // last one is turned away; the seed keeps its place.
        let mut taken = 0;
        for _ in 0..4 {
            taken += d.responder((0..5).map(|_| PeerId::random())).len();
        }
        assert_eq!(taken, MAX_CANDIDATES - 1);
        assert!(d.capped);
        assert!(d.holding.contains(&seed));
    }

    #[test]
    fn a_lookup_without_a_valid_record_gives_its_place_back() {
        let mut d = Discovery::new(gene_id(), NOW, PeerId::random());
        let first: Vec<PeerId> = (0..MAX_CANDIDATES).map(|_| PeerId::random()).collect();
        for chunk in first.chunks(CANDIDATES_PER_RESPONDER) {
            assert_eq!(d.responder(chunk.to_vec()).len(), chunk.len());
        }
        let late = PeerId::random();
        assert!(d.responder([late]).is_empty(), "no place left");
        d.lookup_done(&first[0]);
        assert_eq!(d.responder([late]), vec![late], "the freed place is taken");
    }

    #[test]
    fn a_found_candidate_keeps_its_place() {
        let key = Keypair::generate_ed25519();
        let publisher = key.public().to_peer_id();
        let mut d = Discovery::new(gene_id(), NOW, PeerId::random());
        assert_eq!(d.seed([publisher]), vec![publisher]);
        d.record(publisher, &signed(&key, NOW)).unwrap();
        d.lookup_done(&publisher);
        assert!(d.holding.contains(&publisher));
        assert_eq!(d.found().count(), 1);
    }

    #[test]
    fn an_invalid_value_is_dropped_and_counted_and_the_valid_one_kept() {
        let key = Keypair::generate_ed25519();
        let publisher = key.public().to_peer_id();
        let mut d = Discovery::new(gene_id(), NOW, PeerId::random());
        d.seed([publisher]);
        let mut forged = signed(&key, NOW);
        let last = forged.len() - 1;
        forged[last] ^= 1;
        assert_eq!(d.record(publisher, &forged), Err(RecordRejection::BadSignature));
        assert_eq!(d.invalid, 1);
        assert_eq!(d.found().count(), 0);
        d.record(publisher, &signed(&key, NOW)).unwrap();
        assert_eq!(d.found().count(), 1);
    }

    #[test]
    fn a_record_under_another_publishers_key_is_refused() {
        // A's valid record offered as B's: the key we look up is B's.
        let a = Keypair::generate_ed25519();
        let b = Keypair::generate_ed25519().public().to_peer_id();
        let mut d = Discovery::new(gene_id(), NOW, PeerId::random());
        d.seed([b]);
        assert_eq!(d.record(b, &signed(&a, NOW)), Err(RecordRejection::BadPublisher));
    }

    #[test]
    fn the_newer_record_wins_per_publisher() {
        let key = Keypair::generate_ed25519();
        let publisher = key.public().to_peer_id();
        let mut d = Discovery::new(gene_id(), NOW, PeerId::random());
        d.seed([publisher]);
        d.record(publisher, &signed(&key, NOW - 10)).unwrap();
        d.record(publisher, &signed(&key, NOW - 20)).unwrap();
        let (_, held) = d.found().next().unwrap();
        assert_eq!(held.announcement.timestamp_ms, NOW - 10);
    }

    #[test]
    fn freshness_is_judged_at_query_time() {
        let a = ann(G, "g", NOW - gene_record::MAX_AGE_MS);
        assert!(is_fresh(&a, NOW));
        assert!(!is_fresh(&a, NOW + 1));
    }

    #[test]
    fn keyword_matches_name_or_domain_ignoring_case() {
        let a = ann(G, "Summarizer", NOW);
        assert!(matches_keyword(&a, "summ"));
        assert!(matches_keyword(&a, "TEXT"));
        assert!(!matches_keyword(&a, "image"));
        assert!(!matches_keyword(&a, "  "));
    }

    #[test]
    fn merge_marks_sources_and_keeps_the_newer_copy() {
        let dht = vec![(ann(G, "dht", NOW - 5), "P".to_string()), (ann(G, "only-dht", NOW), "Q".to_string())];
        let gossip = vec![(ann(G, "gossip", NOW - 1), "P".to_string()), (ann(G, "only-gossip", NOW), "R".to_string())];
        let merged = merge(dht, gossip, NOW);
        let get = |p: &str| merged.iter().find(|(_, q, _)| q == p).unwrap();
        assert_eq!((get("P").0.name.as_str(), get("P").2), ("gossip", HitSource::Both));
        assert_eq!(get("Q").2, HitSource::Dht);
        assert_eq!(get("R").2, HitSource::Gossip);
    }

    #[test]
    fn merge_keeps_the_dht_copy_on_equal_timestamps() {
        let dht = vec![(ann(G, "dht", NOW), "P".to_string())];
        let gossip = vec![(ann(G, "gossip", NOW), "P".to_string())];
        let merged = merge(dht, gossip, NOW);
        assert_eq!((merged[0].0.name.as_str(), merged[0].2), ("dht", HitSource::Both));
    }

    #[test]
    fn merge_drops_stale_entries_from_either_source() {
        let old = NOW - gene_record::MAX_AGE_MS - 1;
        let merged = merge(vec![(ann(G, "a", old), "P".to_string())], vec![(ann(G, "b", old), "Q".to_string())], NOW);
        assert!(merged.is_empty());
    }
}
