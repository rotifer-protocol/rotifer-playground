//! The node's DHT store (A2 design §4–§5, ADR-340 修订一 §2.2).
//!
//! Kademlia runs with `StoreInserts::FilterBoth`, so nothing a peer sends is
//! stored until [`GeneStore::admit_record`] or [`GeneStore::admit_provider`]
//! takes it. Value records live only under record keys
//! (`/rotifer/gene/G/P`), provider records only under provider keys (34 bytes
//! beginning `12 20`); a v1 node stores no other key, its own included.
//!
//! The budgets bound how much one publisher can take: a registered publisher
//! is counted by pseudonym, everyone else by PeerId. This is **resource
//! scoping** (资源圈定), not Sybil resistance: free PeerIds still churn the
//! anonymous share. This node's own records are exempt and never evicted.

use std::borrow::Cow;
use std::collections::HashMap;
use std::collections::hash_map::RandomState;
use std::hash::BuildHasher;
use std::time::{Duration, Instant};

use libp2p::PeerId;
use libp2p::kad::store::{self, RecordStore};
use libp2p::kad::{ProviderRecord, Record, RecordKey};

use super::gene_record::{self, RecordRejection, ValidRecord};

/// Inbound DHT writes (PUT_VALUE and ADD_PROVIDER) a peer may burst.
pub const WRITE_BURST: f64 = 128.0;
/// Writes a peer regains per minute.
pub const WRITES_PER_MIN: f64 = 10.0;
/// Peers whose write budget is tracked; the least recently seen is forgotten.
pub const MAX_TRACKED_WRITERS: usize = super::security::MAX_TRACKED_PEERS;

/// Value records stored from other publishers.
pub const MAX_RECORDS: usize = 1024;
/// Of those, the share kept for anonymous publishers (the rest is the
/// registered share); either class may use free room beyond its share.
pub const ANONYMOUS_RECORDS: usize = 512;
/// Value records per publisher: per pseudonym, or per anonymous PeerId.
pub const RECORDS_PER_PUBLISHER: usize = 64;

/// Provider entries per key, and each class's share of them.
pub const PROVIDERS_PER_KEY: usize = 20;
pub const PROVIDER_SHARE: usize = 10;
/// Provider keys held, all of them (not only this node's).
pub const MAX_PROVIDER_KEYS: usize = 1024;
/// Provider entries held in total.
pub const MAX_PROVIDER_ENTRIES: usize = 8192;
/// Addresses kept per provider entry, and their total encoded length.
pub const PROVIDER_ADDRS: usize = 8;
pub const PROVIDER_ADDR_BYTES: usize = 512;

/// How often expired entries are swept besides before every admission.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(300);

/// Who a stored entry is counted against.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Holder {
    /// A publisher with a valid registration on this node, by pseudonym.
    Registered { iss: String, sub: String },
    /// Anyone else, by PeerId.
    Anonymous(PeerId),
}

impl Holder {
    fn is_registered(&self) -> bool {
        matches!(self, Self::Registered { .. })
    }
}

/// What became of an inbound value record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Stored,
    Replaced,
    /// The stored copy wins under §2.7: dropped.
    NotNewer,
    /// Failed §2.8 at a step; charged to the sender if it is a forgery.
    Rejected(RecordRejection),
    /// No room and nothing the eviction rule may take.
    OverBudget,
}

/// What became of an inbound provider record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderAdmission {
    Stored,
    /// Not a provider key (§2.2).
    BadKey,
    OverBudget,
}

/// Per-peer token bucket on inbound DHT writes (A2 design §4 step 1).
#[derive(Debug, Default)]
pub struct WriteLimiter {
    buckets: HashMap<PeerId, (f64, Instant)>,
}

impl WriteLimiter {
    /// Take one write from `peer`'s bucket at `now`; false when it is empty.
    pub fn allow(&mut self, peer: &PeerId, now: Instant) -> bool {
        if !self.buckets.contains_key(peer)
            && self.buckets.len() >= MAX_TRACKED_WRITERS
            && let Some(stalest) = self.buckets.iter().min_by_key(|(_, (_, t))| *t).map(|(p, _)| *p)
        {
            self.buckets.remove(&stalest);
        }
        let (tokens, last) = self.buckets.entry(*peer).or_insert((WRITE_BURST, now));
        let gained = now.saturating_duration_since(*last).as_secs_f64() / 60.0 * WRITES_PER_MIN;
        *tokens = (*tokens + gained).min(WRITE_BURST);
        *last = now;
        if *tokens < 1.0 {
            return false;
        }
        *tokens -= 1.0;
        true
    }
}

/// A value record held by [`GeneStore`].
#[derive(Debug, Clone)]
pub struct StoredRecord {
    record: Record,
    valid: ValidRecord,
    /// `None` for this node's own records.
    holder: Option<Holder>,
}

#[derive(Debug, Clone)]
struct StoredProvider {
    record: ProviderRecord,
    /// `None` for this node's own entries.
    holder: Option<Holder>,
}

/// The node's Kademlia store. See the module docs.
#[derive(Debug)]
pub struct GeneStore {
    local: PeerId,
    records: HashMap<RecordKey, StoredRecord>,
    providers: HashMap<RecordKey, Vec<StoredProvider>>,
    random: RandomState,
    draws: u64,
}

/// Whether `key` is a provider key: a sha2-256 multihash, 34 bytes beginning
/// `12 20`. Every such key is one (each digest spells exactly one `G`).
pub fn is_provider_key(key: &[u8]) -> bool {
    key.len() == 34 && key[..2] == gene_record::SHA2_256_MULTIHASH
}

impl GeneStore {
    pub fn new(local: PeerId) -> Self {
        Self { local, records: HashMap::new(), providers: HashMap::new(), random: RandomState::new(), draws: 0 }
    }

    /// Admit a value record a peer sent (A2 design §4 steps 2–11): the §2.8
    /// checks, the §2.7 replacement rule, then the budgets. `holder_of` says
    /// who a publisher counts as.
    pub fn admit_record(
        &mut self,
        record: Record,
        now_ms: u64,
        now: Instant,
        holder_of: impl Fn(&PeerId) -> Holder,
    ) -> Admission {
        self.sweep(now);
        let valid = match gene_record::validate_record(record.key.as_ref(), &record.value, now_ms) {
            Ok(v) => v,
            Err(why) => return Admission::Rejected(why),
        };
        let replacing = match self.records.get(&record.key) {
            Some(stored) if !valid.supersedes(&stored.valid) => return Admission::NotNewer,
            Some(_) => true,
            None => false,
        };
        let holder = holder_of(&valid.publisher);
        if !replacing && !self.make_room_for_record(&holder) {
            return Admission::OverBudget;
        }
        self.insert_record(record.key, valid, Some(holder), now_ms, now);
        if replacing { Admission::Replaced } else { Admission::Stored }
    }

    /// Admit a provider record a peer sent (A2 design §4, §5.2). Kademlia has
    /// already checked that the provider is the peer that sent it.
    pub fn admit_provider(&mut self, mut record: ProviderRecord, now: Instant, holder: Holder) -> ProviderAdmission {
        self.sweep(now);
        if !is_provider_key(record.key.as_ref()) {
            return ProviderAdmission::BadKey;
        }
        record.addresses = bounded_addresses(record.addresses);
        // The same provider, or the same pseudonym, replaces its own entry.
        let same = self.providers.get(&record.key).and_then(|entries| {
            entries.iter().position(|e| {
                e.record.provider == record.provider || (holder.is_registered() && e.holder.as_ref() == Some(&holder))
            })
        });
        if let Some(i) = same {
            if let Some(entries) = self.providers.get_mut(&record.key) {
                entries[i] = StoredProvider { record, holder: Some(holder) };
            }
            return ProviderAdmission::Stored;
        }
        let held = self.providers.get(&record.key).map_or(0, Vec::len);
        if held == 0 && self.providers.len() >= MAX_PROVIDER_KEYS {
            return ProviderAdmission::OverBudget;
        }
        let total: usize = self.providers.values().map(Vec::len).sum();
        if total >= MAX_PROVIDER_ENTRIES && held < PROVIDERS_PER_KEY {
            return ProviderAdmission::OverBudget;
        }
        let draw = self.draw();
        let entries = self.providers.entry(record.key.clone()).or_default();
        if entries.len() >= PROVIDERS_PER_KEY {
            let registered = entries.iter().filter(|e| e.holder.as_ref().is_some_and(Holder::is_registered)).count();
            let anonymous = entries.iter().filter(|e| e.holder.as_ref().is_some_and(|h| !h.is_registered())).count();
            let other_over = if holder.is_registered() { anonymous > PROVIDER_SHARE } else { registered > PROVIDER_SHARE };
            let evict_registered = holder.is_registered() != other_over;
            let pool: Vec<usize> = entries
                .iter()
                .enumerate()
                .filter(|(_, e)| e.holder.as_ref().is_some_and(|h| h.is_registered() == evict_registered))
                .map(|(i, _)| i)
                .collect();
            if pool.is_empty() {
                return ProviderAdmission::OverBudget;
            }
            entries.swap_remove(pool[(draw % pool.len() as u64) as usize]);
        }
        entries.push(StoredProvider { record, holder: Some(holder) });
        ProviderAdmission::Stored
    }

    /// Drop expired records and provider entries.
    pub fn sweep(&mut self, now: Instant) {
        self.records.retain(|_, s| !s.record.is_expired(now));
        for entries in self.providers.values_mut() {
            entries.retain(|e| !e.record.is_expired(now));
        }
        self.providers.retain(|_, entries| !entries.is_empty());
    }

    /// Value records stored, by holder class: `(registered, anonymous)`.
    pub fn record_counts(&self) -> (usize, usize) {
        let held = self.records.values().filter_map(|s| s.holder.as_ref());
        held.fold((0, 0), |(r, a), h| if h.is_registered() { (r + 1, a) } else { (r, a + 1) })
    }

    fn insert_record(&mut self, key: RecordKey, valid: ValidRecord, holder: Option<Holder>, now_ms: u64, now: Instant) {
        let lifetime = valid.expires_at_ms(now_ms).saturating_sub(now_ms);
        let mut record = Record::new(key.clone(), valid.canonical.clone());
        record.publisher = Some(valid.publisher);
        record.expires = Some(now + Duration::from_millis(lifetime));
        self.records.insert(key, StoredRecord { record, valid, holder });
    }

    /// Make room for one more record from `holder`, evicting by the §5.2 rule
    /// if a budget is full. False if nothing may be evicted.
    fn make_room_for_record(&mut self, holder: &Holder) -> bool {
        let own: Vec<RecordKey> =
            self.records.iter().filter(|(_, s)| s.holder.as_ref() == Some(holder)).map(|(k, _)| k.clone()).collect();
        if own.len() >= RECORDS_PER_PUBLISHER {
            let victim = own[(self.draw() % own.len() as u64) as usize].clone();
            self.records.remove(&victim);
            return true;
        }
        let (registered, anonymous) = self.record_counts();
        if registered + anonymous < MAX_RECORDS {
            return true;
        }
        let other_over = if holder.is_registered() {
            anonymous > ANONYMOUS_RECORDS
        } else {
            registered > MAX_RECORDS - ANONYMOUS_RECORDS
        };
        let evict_registered = holder.is_registered() != other_over;
        let pool: Vec<RecordKey> = self
            .records
            .iter()
            .filter(|(_, s)| s.holder.as_ref().is_some_and(|h| h.is_registered() == evict_registered))
            .map(|(k, _)| k.clone())
            .collect();
        if pool.is_empty() {
            return false;
        }
        let victim = pool[(self.draw() % pool.len() as u64) as usize].clone();
        self.records.remove(&victim);
        true
    }

    /// A uniformly random number, seeded per process by the OS.
    fn draw(&mut self) -> u64 {
        self.draws += 1;
        self.random.hash_one(self.draws)
    }
}

/// At most [`PROVIDER_ADDRS`] addresses, [`PROVIDER_ADDR_BYTES`] in all.
fn bounded_addresses(addresses: Vec<libp2p::Multiaddr>) -> Vec<libp2p::Multiaddr> {
    let mut bytes = 0;
    addresses
        .into_iter()
        .take(PROVIDER_ADDRS)
        .take_while(|a| {
            bytes += a.as_ref().len();
            bytes <= PROVIDER_ADDR_BYTES
        })
        .collect()
}

fn borrow_record(s: &StoredRecord) -> Cow<'_, Record> {
    Cow::Borrowed(&s.record)
}

/// The path Kademlia itself uses: this node's own puts and provides, and
/// reads. Only well-formed v1 entries go in.
impl RecordStore for GeneStore {
    type RecordsIter<'a> = std::iter::Map<
        std::collections::hash_map::Values<'a, RecordKey, StoredRecord>,
        fn(&'a StoredRecord) -> Cow<'a, Record>,
    >;
    type ProvidedIter<'a> = std::vec::IntoIter<Cow<'a, ProviderRecord>>;

    fn get(&self, k: &RecordKey) -> Option<Cow<'_, Record>> {
        self.records.get(k).map(|s| Cow::Borrowed(&s.record))
    }

    /// This node's own record. `libp2p-kad`'s store error has no variant for
    /// "not a v1 record", so a refusal reads `ValueTooLarge`.
    fn put(&mut self, r: Record) -> store::Result<()> {
        let now_ms = super::node::wall_clock_ms();
        let valid = gene_record::validate_record(r.key.as_ref(), &r.value, now_ms).map_err(|_| store::Error::ValueTooLarge)?;
        if let Some(stored) = self.records.get(&r.key)
            && !valid.supersedes(&stored.valid)
        {
            return Ok(());
        }
        self.insert_record(r.key, valid, None, now_ms, Instant::now());
        Ok(())
    }

    fn remove(&mut self, k: &RecordKey) {
        self.records.remove(k);
    }

    fn records(&self) -> Self::RecordsIter<'_> {
        self.records.values().map(borrow_record as fn(&StoredRecord) -> Cow<'_, Record>)
    }

    /// This node's own provider entry.
    fn add_provider(&mut self, record: ProviderRecord) -> store::Result<()> {
        if !is_provider_key(record.key.as_ref()) {
            return Err(store::Error::ValueTooLarge);
        }
        let entries = self.providers.entry(record.key.clone()).or_default();
        entries.retain(|e| e.record.provider != record.provider);
        entries.push(StoredProvider { record, holder: None });
        Ok(())
    }

    fn providers(&self, key: &RecordKey) -> Vec<ProviderRecord> {
        self.providers.get(key).map(|es| es.iter().map(|e| e.record.clone()).collect()).unwrap_or_default()
    }

    fn provided(&self) -> Self::ProvidedIter<'_> {
        let local = self.local;
        self.providers
            .values()
            .flatten()
            .filter(|e| e.record.provider == local)
            .map(|e| Cow::Borrowed(&e.record))
            .collect::<Vec<_>>()
            .into_iter()
    }

    fn remove_provider(&mut self, k: &RecordKey, p: &PeerId) {
        if let Some(entries) = self.providers.get_mut(k) {
            entries.retain(|e| &e.record.provider != p);
            if entries.is_empty() {
                self.providers.remove(k);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::p2p::GeneAnnouncement;
    use libp2p::identity::Keypair;

    const NOW_MS: u64 = 1_800_000_000_000;

    fn gene(n: u32) -> String {
        format!("v2:{:064x}", n)
    }

    /// A valid record for gene `n`, signed by `keypair`, published at `ts`.
    fn signed(keypair: &Keypair, n: u32, ts: u64) -> Record {
        let ann = GeneAnnouncement {
            gene_id: gene(n),
            name: format!("gene-{n}"),
            domain: "test".into(),
            fidelity: "Wrapped".into(),
            ir_spec: String::new(),
            version: "1.0.0".into(),
            timestamp_ms: ts,
        };
        let value = gene_record::sign_record(keypair, &gene_record::encode_announcement_message(&ann)).unwrap();
        Record::new(gene_record::record_key(&gene(n), &keypair.public().to_peer_id()), value)
    }

    fn anonymous(p: &PeerId) -> Holder {
        Holder::Anonymous(*p)
    }

    fn provider(n: u32, peer: PeerId) -> ProviderRecord {
        ProviderRecord::new(gene_record::provider_key(&gene(n)).unwrap(), peer, Vec::new())
    }

    #[test]
    fn a_valid_record_is_stored_as_its_canonical_bytes() {
        let key = Keypair::generate_ed25519();
        let rec = signed(&key, 1, NOW_MS - 1000);
        let mut store = GeneStore::new(PeerId::random());
        assert_eq!(store.admit_record(rec.clone(), NOW_MS, Instant::now(), anonymous), Admission::Stored);
        let stored = store.get(&rec.key).unwrap();
        let valid = gene_record::validate_record(rec.key.as_ref(), &rec.value, NOW_MS).unwrap();
        assert_eq!(stored.value, valid.canonical);
        assert_eq!(stored.publisher, Some(key.public().to_peer_id()));
    }

    #[test]
    fn value_records_go_only_under_record_keys() {
        let key = Keypair::generate_ed25519();
        let rec = signed(&key, 1, NOW_MS - 1000);
        let mut store = GeneStore::new(PeerId::random());
        for other in [b"other/key".to_vec(), gene_record::provider_key(&gene(1)).unwrap()] {
            let moved = Record::new(other, rec.value.clone());
            assert_eq!(
                store.admit_record(moved, NOW_MS, Instant::now(), anonymous),
                Admission::Rejected(RecordRejection::BadKey)
            );
        }
        assert_eq!(store.records().count(), 0);
    }

    #[test]
    fn provider_records_go_only_under_provider_keys() {
        let mut store = GeneStore::new(PeerId::random());
        let peer = PeerId::random();
        let record_key = gene_record::record_key(&gene(1), &peer);
        for key in [record_key, b"other/key".to_vec(), vec![0x12, 0x20], [&[0x12, 0x21][..], &[0; 32]].concat()] {
            let rec = ProviderRecord::new(key, peer, Vec::new());
            assert_eq!(store.admit_provider(rec, Instant::now(), anonymous(&peer)), ProviderAdmission::BadKey);
        }
        assert_eq!(store.admit_provider(provider(1, peer), Instant::now(), anonymous(&peer)), ProviderAdmission::Stored);
        assert_eq!(store.providers(&provider(1, peer).key).len(), 1);
    }

    #[test]
    fn a_forgery_is_rejected_and_reported_as_one() {
        let key = Keypair::generate_ed25519();
        let mut rec = signed(&key, 1, NOW_MS - 1000);
        let last = rec.value.len() - 1;
        rec.value[last] ^= 1;
        let mut store = GeneStore::new(PeerId::random());
        match store.admit_record(rec, NOW_MS, Instant::now(), anonymous) {
            Admission::Rejected(why) => assert!(why.is_forgery(), "{why:?}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_older_copy_does_not_replace_a_newer_one() {
        let key = Keypair::generate_ed25519();
        let mut store = GeneStore::new(PeerId::random());
        let now = Instant::now();
        assert_eq!(store.admit_record(signed(&key, 1, NOW_MS - 1000), NOW_MS, now, anonymous), Admission::Stored);
        assert_eq!(store.admit_record(signed(&key, 1, NOW_MS - 2000), NOW_MS, now, anonymous), Admission::NotNewer);
        assert_eq!(store.admit_record(signed(&key, 1, NOW_MS - 500), NOW_MS, now, anonymous), Admission::Replaced);
    }

    #[test]
    fn one_publisher_holds_at_most_its_quota() {
        let key = Keypair::generate_ed25519();
        let mut store = GeneStore::new(PeerId::random());
        let now = Instant::now();
        for n in 0..74 {
            assert_eq!(store.admit_record(signed(&key, n, NOW_MS - 1000), NOW_MS, now, anonymous), Admission::Stored);
        }
        assert_eq!(store.record_counts(), (0, 64));
    }

    #[test]
    fn a_registered_account_is_counted_once_across_its_peer_ids() {
        let account = Holder::Registered { iss: "https://rotifer.dev".into(), sub: "acct".into() };
        let mut store = GeneStore::new(PeerId::random());
        let now = Instant::now();
        for n in 0..69 {
            let key = Keypair::generate_ed25519();
            assert_eq!(store.admit_record(signed(&key, n, NOW_MS - 1000), NOW_MS, now, |_| account.clone()), Admission::Stored);
        }
        assert_eq!(store.record_counts(), (64, 0));
    }

    #[test]
    fn a_full_store_evicts_from_the_class_over_its_share() {
        let mut store = GeneStore::new(PeerId::random());
        let now = Instant::now();
        // Fill the whole store with anonymous publishers, 16 records each.
        let mut n = 0;
        while store.record_counts().1 < 1024 {
            let key = Keypair::generate_ed25519();
            for _ in 0..16 {
                store.admit_record(signed(&key, n, NOW_MS - 1000), NOW_MS, now, anonymous);
                n += 1;
            }
        }
        // A registered newcomer takes an anonymous slot: anonymous is over
        // its 512 share.
        let account = Holder::Registered { iss: "i".into(), sub: "s".into() };
        let key = Keypair::generate_ed25519();
        assert_eq!(store.admit_record(signed(&key, n, NOW_MS - 1000), NOW_MS, now, |_| account.clone()), Admission::Stored);
        assert_eq!(store.record_counts(), (1, 1023));
        // Another anonymous newcomer only displaces another anonymous record.
        let key = Keypair::generate_ed25519();
        assert_eq!(store.admit_record(signed(&key, n + 1, NOW_MS - 1000), NOW_MS, now, anonymous), Admission::Stored);
        assert_eq!(store.record_counts(), (1, 1023));
    }

    #[test]
    fn provider_slots_keep_each_class_its_share() {
        let mut store = GeneStore::new(PeerId::random());
        let now = Instant::now();
        let peers: Vec<PeerId> = (0..20).map(|_| PeerId::random()).collect();
        for p in &peers {
            assert_eq!(store.admit_provider(provider(1, *p), now, anonymous(p)), ProviderAdmission::Stored);
        }
        // Registered newcomers displace anonymous entries until each class
        // holds its share; then they only displace each other.
        for i in 0..20 {
            let p = PeerId::random();
            let holder = Holder::Registered { iss: "i".into(), sub: format!("acct-{i}") };
            assert_eq!(store.admit_provider(provider(1, p), now, holder), ProviderAdmission::Stored);
        }
        let key = provider(1, PeerId::random()).key;
        let anonymous_left = store.providers(&key).iter().filter(|r| peers.contains(&r.provider)).count();
        assert_eq!((store.providers(&key).len(), anonymous_left), (20, 10));
    }

    #[test]
    fn the_budgets_are_the_ruled_values() {
        // Design v2 §5.3, as ruled in v2 §13 #1. Written out, so a changed
        // constant fails here rather than moving its own expectation.
        assert_eq!(MAX_RECORDS, 1024);
        assert_eq!(ANONYMOUS_RECORDS, 512);
        assert_eq!(RECORDS_PER_PUBLISHER, 64);
        assert_eq!(PROVIDERS_PER_KEY, 20);
        assert_eq!(PROVIDER_SHARE, 10);
        assert_eq!(MAX_PROVIDER_KEYS, 1024);
        assert_eq!(MAX_PROVIDER_ENTRIES, 8192);
        assert_eq!(PROVIDER_ADDRS, 8);
        assert_eq!(PROVIDER_ADDR_BYTES, 512);
    }

    #[test]
    fn one_pseudonym_holds_one_provider_slot_per_key() {
        let mut store = GeneStore::new(PeerId::random());
        let account = Holder::Registered { iss: "i".into(), sub: "acct".into() };
        for _ in 0..5 {
            store.admit_provider(provider(1, PeerId::random()), Instant::now(), account.clone());
        }
        assert_eq!(store.providers(&provider(1, PeerId::random()).key).len(), 1);
    }

    #[test]
    fn provider_addresses_are_bounded() {
        let mut store = GeneStore::new(PeerId::random());
        let peer = PeerId::random();
        let addrs = (1..=20u16).map(|p| format!("/ip4/10.0.0.1/tcp/{p}").parse().unwrap()).collect();
        let rec = ProviderRecord::new(gene_record::provider_key(&gene(1)).unwrap(), peer, addrs);
        store.admit_provider(rec.clone(), Instant::now(), anonymous(&peer));
        assert_eq!(store.providers(&rec.key)[0].addresses.len(), 8);
    }

    #[test]
    fn expired_entries_are_swept_without_a_query() {
        let key = Keypair::generate_ed25519();
        let mut store = GeneStore::new(PeerId::random());
        let now = Instant::now();
        store.admit_record(signed(&key, 1, NOW_MS - 1000), NOW_MS, now, anonymous);
        let mut rec = provider(1, PeerId::random());
        rec.expires = Some(now + Duration::from_secs(60));
        store.admit_provider(rec.clone(), now, anonymous(&rec.provider));
        store.sweep(now + Duration::from_secs(61));
        assert!(store.providers(&rec.key).is_empty());
        assert_eq!(store.records().count(), 1);
        store.sweep(now + Duration::from_millis(gene_record::STORE_TTL_MS + 1));
        assert_eq!(store.records().count(), 0);
    }

    #[test]
    fn own_records_must_be_v1_records_too() {
        let key = Keypair::generate_ed25519();
        let mut store = GeneStore::new(key.public().to_peer_id());
        assert!(store.put(Record::new(b"other/key".to_vec(), b"x".to_vec())).is_err());
        let ts = crate::p2p::node::wall_clock_ms() - 1000;
        let rec = signed(&key, 1, ts);
        assert!(store.put(rec.clone()).is_ok());
        assert!(store.add_provider(ProviderRecord::new(b"other/key".to_vec(), key.public().to_peer_id(), Vec::new())).is_err());
        assert!(store.add_provider(provider(1, key.public().to_peer_id())).is_ok());
        assert_eq!(store.provided().count(), 1);
    }

    #[test]
    fn the_write_limit_allows_a_burst_then_ten_a_minute() {
        let mut limiter = WriteLimiter::default();
        let peer = PeerId::random();
        let t0 = Instant::now();
        assert_eq!((0..200).filter(|_| limiter.allow(&peer, t0)).count(), WRITE_BURST as usize);
        assert!(!limiter.allow(&peer, t0 + Duration::from_secs(5)));
        let later = t0 + Duration::from_secs(60);
        assert_eq!((0..20).filter(|_| limiter.allow(&peer, later)).count(), WRITES_PER_MIN as usize);
        assert!(limiter.allow(&PeerId::random(), later), "each peer has its own bucket");
    }
}
