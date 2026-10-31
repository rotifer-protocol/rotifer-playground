//! §38 behaviour tests for MemoryStore.

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use super::events::MemoryAction;
use super::*;

const AGENT: &str = "agent-1";
const T0: i64 = 1_761_800_000_000;

fn gene(id: &str, domain: &str) -> CallerGene {
    CallerGene {
        gene_id: id.into(),
        domain: domain.into(),
    }
}

fn a() -> CallerGene {
    gene("v2:gene-a", "text.summarize")
}
fn a_twin() -> CallerGene {
    gene("v2:gene-a2", "text.summarize")
}
fn other() -> CallerGene {
    gene("v2:gene-b", "search.web")
}

/// A store whose clock moves one second per call, so every write is "newer".
fn store() -> (MemoryStore, Arc<RecordingSink>) {
    let sink = Arc::new(RecordingSink::default());
    let tick = AtomicI64::new(T0);
    let s = MemoryStore::in_memory(sink.clone())
        .unwrap()
        .with_clock(move || tick.fetch_add(1000, Ordering::SeqCst));
    (s, sink)
}

/// A complete §30.2 RetentionPolicy.
fn retention(days: Option<u32>) -> RetentionPolicy {
    RetentionPolicy {
        max_retention_days: days,
        auto_delete_on_termination: false,
        anonymization_supported: false,
    }
}

fn policy(read: AccessScope, write: AccessScope) -> MemoryAccessPolicy {
    MemoryAccessPolicy {
        read_scope: read,
        write_scope: write,
        share_policy: SharePolicy::Private,
    }
}

fn actions(sink: &RecordingSink) -> Vec<MemoryAction> {
    sink.audits
        .lock()
        .unwrap()
        .iter()
        .map(|e| e.action)
        .collect()
}

fn keys(s: &MemoryStore) -> Vec<String> {
    s.get_memory(AGENT)
        .unwrap()
        .entries
        .into_iter()
        .map(|e| e.key)
        .collect()
}

// ── read / write ─────────────────────────────────────────────────────────

#[test]
fn a_written_entry_reads_back_and_records_its_reader() {
    let (s, _) = store();
    let w = s
        .write(
            AGENT,
            &a(),
            "lang",
            b"zh-CN",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
    assert_eq!(w.entry_id, entry_id(AGENT, "lang"));
    assert_eq!(w.created_by, "v2:gene-a");
    assert_eq!(w.access_policy, MemoryAccessPolicy::default());
    // A write records its writer.
    assert_eq!(w.last_accessed_by.as_deref(), Some("v2:gene-a"));

    let r = s.read(AGENT, &a_twin(), "lang", None).unwrap().unwrap();
    assert_eq!(r.value, b"zh-CN");
    assert_eq!(r.last_accessed_by.as_deref(), Some("v2:gene-a2"));
    // ...and it is stored, not just returned.
    let again = s.get_memory(AGENT).unwrap().entries.remove(0);
    assert_eq!(again.last_accessed_by.as_deref(), Some("v2:gene-a2"));
}

#[test]
fn a_missing_key_or_another_category_reads_as_none() {
    let (s, _) = store();
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Pattern, None, None)
        .unwrap();
    assert_eq!(s.read(AGENT, &a(), "nope", None).unwrap(), None);
    assert_eq!(
        s.read(AGENT, &a(), "k", Some(MemoryCategory::Cache))
            .unwrap(),
        None
    );
    assert!(
        s.read(AGENT, &a(), "k", Some(MemoryCategory::Pattern))
            .unwrap()
            .is_some()
    );
    // Another agent's memory is not this one's.
    assert_eq!(s.read("agent-2", &a(), "k", None).unwrap(), None);
}

#[test]
fn an_update_keeps_the_entry_id_creator_and_created_at() {
    let (s, sink) = store();
    let first = s
        .write(AGENT, &a(), "k", b"1", MemoryCategory::Context, None, None)
        .unwrap();
    let second = s
        .write(
            AGENT,
            &a_twin(),
            "k",
            b"22",
            MemoryCategory::Context,
            None,
            None,
        )
        .unwrap();
    assert_eq!(second.entry_id, first.entry_id);
    assert_eq!(second.created_by, "v2:gene-a");
    assert_eq!(second.created_at, first.created_at);
    assert!(second.updated_at > first.updated_at);
    assert_eq!(
        s.read(AGENT, &a(), "k", None).unwrap().unwrap().value,
        b"22"
    );
    assert_eq!(
        actions(&sink),
        vec![
            MemoryAction::MemoryCreated,
            MemoryAction::Write,
            MemoryAction::Update
        ]
    );
    assert_eq!(sink.audits.lock().unwrap()[2].size_delta, 1);
}

#[test]
fn an_update_without_a_policy_keeps_the_entry_policy() {
    let (s, _) = store();
    s.write(
        AGENT,
        &a(),
        "k",
        b"1",
        MemoryCategory::Context,
        Some(policy(AccessScope::AllGenes, AccessScope::SameDomain)),
        None,
    )
    .unwrap();
    let updated = s
        .write(
            AGENT,
            &a_twin(),
            "k",
            b"2",
            MemoryCategory::Context,
            None,
            None,
        )
        .unwrap();
    assert_eq!(updated.access_policy.read_scope, AccessScope::AllGenes);
}

#[test]
fn only_the_creator_may_change_an_entry_policy() {
    let (s, sink) = store();
    s.write(AGENT, &a(), "k", b"1", MemoryCategory::Context, None, None)
        .unwrap();
    let widen = Some(policy(AccessScope::AllGenes, AccessScope::AllGenes));
    let err = s
        .write(
            AGENT,
            &a_twin(),
            "k",
            b"2",
            MemoryCategory::Context,
            widen,
            None,
        )
        .unwrap_err();
    assert_eq!(err.code(), "MEMORY_ACCESS_DENIED");
    assert_eq!(s.read(AGENT, &a(), "k", None).unwrap().unwrap().value, b"1");
    assert_eq!(sink.telemetry.lock().unwrap().len(), 1);

    let mine = s
        .write(AGENT, &a(), "k", b"3", MemoryCategory::Context, widen, None)
        .unwrap();
    assert_eq!(mine.access_policy.read_scope, AccessScope::AllGenes);
}

// ── permissions (§38.2 L0) ───────────────────────────────────────────────

#[test]
fn same_domain_is_the_default_and_keeps_other_domains_out() {
    let (s, sink) = store();
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Pattern, None, None)
        .unwrap();
    assert!(s.read(AGENT, &a_twin(), "k", None).unwrap().is_some());

    let err = s.read(AGENT, &other(), "k", None).unwrap_err();
    assert_eq!(err.code(), "MEMORY_ACCESS_DENIED");
    assert!(err.message().contains("search.web"));

    let telemetry = sink.telemetry.lock().unwrap();
    assert_eq!(telemetry.len(), 1);
    assert_eq!(telemetry[0].event_type, "MEMORY_ACCESS_DENIED");
    assert_eq!(telemetry[0].gene_id.as_deref(), Some("v2:gene-b"));
    assert_eq!(telemetry[0].metadata["operation"], "read");
    let audit = sink.audits.lock().unwrap();
    let denial = audit.last().unwrap();
    assert_eq!(denial.action, MemoryAction::AccessDenied);
    assert_eq!(denial.error, Some("MEMORY_ACCESS_DENIED"));
}

#[test]
fn creator_gene_only_admits_the_creator_alone() {
    let (s, _) = store();
    let p = Some(policy(
        AccessScope::CreatorGeneOnly,
        AccessScope::CreatorGeneOnly,
    ));
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Preference, p, None)
        .unwrap();
    assert!(s.read(AGENT, &a(), "k", None).unwrap().is_some());
    assert_eq!(
        s.read(AGENT, &a_twin(), "k", None).unwrap_err().code(),
        "MEMORY_ACCESS_DENIED"
    );
    assert_eq!(
        s.write(
            AGENT,
            &a_twin(),
            "k",
            b"x",
            MemoryCategory::Preference,
            None,
            None
        )
        .unwrap_err()
        .code(),
        "MEMORY_ACCESS_DENIED"
    );
    assert_eq!(
        s.delete(AGENT, &a_twin(), "k").unwrap_err().code(),
        "MEMORY_ACCESS_DENIED"
    );
    s.delete(AGENT, &a(), "k").unwrap();
}

#[test]
fn all_genes_admits_any_gene_of_the_agent() {
    let (s, _) = store();
    let p = Some(policy(AccessScope::AllGenes, AccessScope::AllGenes));
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Context, p, None)
        .unwrap();
    assert!(s.read(AGENT, &other(), "k", None).unwrap().is_some());
    s.write(
        AGENT,
        &other(),
        "k",
        b"w",
        MemoryCategory::Context,
        None,
        None,
    )
    .unwrap();
    s.delete(AGENT, &other(), "k").unwrap();
}

#[test]
fn deployer_configured_is_denied_until_data_policy_defines_it() {
    // DEPLOYER_CONFIGURED resolves from the agent's
    // DataPolicy, which has no memory scope yet, so an entry with it could
    // never be read or written by anyone. Creating one is refused, in
    // either scope, and nothing is stored.
    let (s, sink) = store();
    for p in [
        policy(
            AccessScope::DeployerConfigured,
            AccessScope::DeployerConfigured,
        ),
        policy(AccessScope::DeployerConfigured, AccessScope::SameDomain),
        policy(AccessScope::SameDomain, AccessScope::DeployerConfigured),
    ] {
        let err = s
            .write(
                AGENT,
                &a(),
                "k",
                b"v",
                MemoryCategory::Context,
                Some(p),
                None,
            )
            .unwrap_err();
        assert_eq!(err.code(), "MEMORY_ACCESS_DENIED");
        assert!(err.message().contains("DataPolicy"), "{}", err.message());
    }
    assert!(
        s.get_memory(AGENT).is_err(),
        "a refused write created memory"
    );
    assert_eq!(sink.telemetry.lock().unwrap().len(), 3);
}

#[test]
fn a_read_scope_wider_than_the_write_scope_is_honoured_separately() {
    let (s, _) = store();
    let p = Some(policy(AccessScope::AllGenes, AccessScope::CreatorGeneOnly));
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Context, p, None)
        .unwrap();
    assert!(s.read(AGENT, &other(), "k", None).unwrap().is_some());
    assert_eq!(
        s.delete(AGENT, &other(), "k").unwrap_err().code(),
        "MEMORY_ACCESS_DENIED"
    );
}

// ── delete ───────────────────────────────────────────────────────────────

#[test]
fn deleting_a_missing_key_is_not_found_and_a_delete_is_audited() {
    let (s, sink) = store();
    assert_eq!(
        s.delete(AGENT, &a(), "nope").unwrap_err().code(),
        "MEMORY_NOT_FOUND"
    );
    s.write(AGENT, &a(), "k", b"vvv", MemoryCategory::Cache, None, None)
        .unwrap();
    s.delete(AGENT, &a(), "k").unwrap();
    assert_eq!(s.read(AGENT, &a(), "k", None).unwrap(), None);
    let audit = sink.audits.lock().unwrap();
    let del = audit.last().unwrap();
    assert_eq!(del.action, MemoryAction::Delete);
    assert_eq!(del.size_delta, -4);
    assert_eq!(del.total_size, 0);
}

// ── quota and eviction (§38.1 MUST) ──────────────────────────────────────

/// Each entry is key (2 bytes) + value (8 bytes) = 10 bytes.
fn put(s: &MemoryStore, key: &str, c: MemoryCategory) {
    assert_eq!(key.len(), 2);
    s.write(AGENT, &a(), key, b"12345678", c, None, None)
        .unwrap();
}

fn filled(quota: u64) -> (MemoryStore, Arc<RecordingSink>) {
    let (s, sink) = store();
    s.create_memory(AGENT, quota).unwrap();
    // Written oldest to newest.
    put(&s, "c1", MemoryCategory::Cache);
    put(&s, "p1", MemoryCategory::Pattern);
    put(&s, "x1", MemoryCategory::Context);
    put(&s, "f1", MemoryCategory::Preference);
    put(&s, "c2", MemoryCategory::Cache);
    put(&s, "p2", MemoryCategory::Pattern);
    put(&s, "x2", MemoryCategory::Context);
    (s, sink)
}

fn evicted(sink: &RecordingSink) -> Vec<String> {
    sink.audits
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.action == MemoryAction::Evict)
        .map(|e| e.entry_id.clone().unwrap())
        .collect()
}

fn ids(keys: &[&str]) -> Vec<String> {
    keys.iter().map(|k| entry_id(AGENT, k)).collect()
}

#[test]
fn over_quota_evicts_the_oldest_cache_first() {
    let (s, sink) = filled(70);
    put(&s, "n1", MemoryCategory::Context);
    assert_eq!(evicted(&sink), ids(&["c1"]));
    assert!(!keys(&s).contains(&"c1".to_string()));
    assert_eq!(s.get_memory(AGENT).unwrap().total_size, 70);
}

#[test]
fn then_every_cache_then_patterns_oldest_first_then_contexts_oldest_first() {
    let (s, sink) = filled(70);
    // 50 more bytes than fit. Category by category, oldest first within one:
    // both CACHE, both PATTERN, then the oldest CONTEXT. x1 is older than p2,
    // and still goes after it: the order is by category before age.
    s.write(
        AGENT,
        &a(),
        "nn",
        &[0u8; 48],
        MemoryCategory::Preference,
        None,
        None,
    )
    .unwrap();
    assert_eq!(evicted(&sink), ids(&["c1", "c2", "p1", "p2", "x1"]));
    let mut left = keys(&s);
    left.sort();
    assert_eq!(left, vec!["f1", "nn", "x2"]);
}

#[test]
fn preference_is_never_evicted_and_an_impossible_write_changes_nothing() {
    let (s, sink) = filled(70);
    let before = s.get_memory(AGENT).unwrap();
    // Fits only if PREFERENCE f1 went too: refused, and nothing evicted.
    let err = s
        .write(
            AGENT,
            &a(),
            "nn",
            &[0u8; 68],
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap_err();
    assert_eq!(err.code(), "MEMORY_QUOTA_EXCEEDED");
    assert_eq!(s.get_memory(AGENT).unwrap(), before);
    assert!(evicted(&sink).is_empty());
    let last = sink.audits.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.action, MemoryAction::QuotaRejected);
    assert_eq!(last.error, Some("MEMORY_QUOTA_EXCEEDED"));
}

#[test]
fn a_value_larger_than_the_whole_quota_is_rejected() {
    let (s, _) = store();
    s.create_memory(AGENT, 16).unwrap();
    let err = s
        .write(
            AGENT,
            &a(),
            "k",
            &[0u8; 16],
            MemoryCategory::Cache,
            None,
            None,
        )
        .unwrap_err();
    assert_eq!(err.code(), "MEMORY_QUOTA_EXCEEDED");
    assert!(s.get_memory(AGENT).unwrap().entries.is_empty());
}

#[test]
fn updating_an_entry_counts_only_its_growth_and_never_evicts_itself() {
    let (s, sink) = filled(70);
    // c1 grows by 10 bytes: the oldest other CACHE (c2) makes room, not c1.
    s.write(
        AGENT,
        &a(),
        "c1",
        &[0u8; 18],
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap();
    assert_eq!(evicted(&sink), ids(&["c2"]));
    assert!(keys(&s).contains(&"c1".to_string()));
}

#[test]
fn a_lower_quota_takes_effect_at_the_next_write() {
    let (s, sink) = filled(1000);
    s.set_quota(AGENT, 50).unwrap();
    assert!(evicted(&sink).is_empty());
    put(&s, "n1", MemoryCategory::Context);
    // 80 bytes need to fit in 50: both CACHE and the oldest PATTERN go.
    assert_eq!(evicted(&sink), ids(&["c1", "c2", "p1"]));
    assert_eq!(s.get_memory(AGENT).unwrap().total_size, 50);
}

#[test]
fn eviction_is_audited_one_line_per_entry_before_the_write() {
    let (s, sink) = filled(70);
    put(&s, "n1", MemoryCategory::Context);
    let tail: Vec<MemoryAction> = actions(&sink).into_iter().rev().take(2).collect();
    assert_eq!(tail, vec![MemoryAction::Write, MemoryAction::Evict]);
}

// ── query ────────────────────────────────────────────────────────────────

#[test]
fn query_filters_by_category_prefix_time_and_limit() {
    let now = Arc::new(AtomicI64::new(T0));
    let clock = now.clone();
    let s = MemoryStore::in_memory(Arc::new(NullSink))
        .unwrap()
        .with_clock(move || clock.load(Ordering::SeqCst));
    for (i, (key, c)) in [
        ("q.1", MemoryCategory::Cache),
        ("q.2", MemoryCategory::Cache),
        ("r.1", MemoryCategory::Pattern),
    ]
    .into_iter()
    .enumerate()
    {
        now.store(T0 + 1000 * (i as i64 + 1), Ordering::SeqCst);
        s.write(AGENT, &a(), key, b"v", c, None, None).unwrap();
    }

    let keys_of = |f: MemoryFilter| -> Vec<String> {
        s.query(AGENT, &a(), &f)
            .unwrap()
            .into_iter()
            .map(|e| e.key)
            .collect()
    };
    // Newest updatedAt first, not by key.
    assert_eq!(keys_of(MemoryFilter::default()), vec!["r.1", "q.2", "q.1"]);
    assert_eq!(
        keys_of(MemoryFilter {
            category: Some(MemoryCategory::Cache),
            ..Default::default()
        }),
        vec!["q.2", "q.1"]
    );
    assert_eq!(
        keys_of(MemoryFilter {
            key_prefix: Some("r.".into()),
            ..Default::default()
        }),
        vec!["r.1"]
    );
    // since is inclusive, until exclusive, both against updatedAt.
    assert_eq!(
        keys_of(MemoryFilter {
            since: Some(T0 + 2000),
            ..Default::default()
        }),
        vec!["r.1", "q.2"]
    );
    assert_eq!(
        keys_of(MemoryFilter {
            until: Some(T0 + 2000),
            ..Default::default()
        }),
        vec!["q.1"]
    );
    assert_eq!(
        keys_of(MemoryFilter {
            since: Some(T0 + 2000),
            until: Some(T0 + 3000),
            ..Default::default()
        }),
        vec!["q.2"]
    );
    assert_eq!(
        keys_of(MemoryFilter {
            limit: Some(1),
            ..Default::default()
        }),
        vec!["r.1"]
    );
    // keyPrefix is a plain prefix, not a pattern.
    assert!(
        keys_of(MemoryFilter {
            key_prefix: Some("q%".into()),
            ..Default::default()
        })
        .is_empty()
    );
}

#[test]
fn query_limit_defaults_to_100_caps_at_1000_and_refuses_zero() {
    let (s, _) = store();
    for i in 0..1005 {
        s.write(
            AGENT,
            &a(),
            &format!("k{i:04}"),
            b"",
            MemoryCategory::Cache,
            None,
            None,
        )
        .unwrap();
    }
    assert_eq!(
        s.query(AGENT, &a(), &MemoryFilter::default())
            .unwrap()
            .len(),
        100
    );
    assert_eq!(
        s.query(
            AGENT,
            &a(),
            &MemoryFilter {
                limit: Some(5000),
                ..Default::default()
            }
        )
        .unwrap()
        .len(),
        1000
    );
    assert_eq!(
        s.query(
            AGENT,
            &a(),
            &MemoryFilter {
                limit: Some(0),
                ..Default::default()
            }
        )
        .unwrap_err()
        .code(),
        "MEMORY_INVALID_INPUT"
    );
}

#[test]
fn entries_written_in_the_same_millisecond_are_ordered_by_entry_id() {
    let s = MemoryStore::in_memory(Arc::new(NullSink))
        .unwrap()
        .with_clock(|| T0);
    let mut ids: Vec<(String, String)> = ["a", "b", "c", "d"]
        .iter()
        .map(|k| {
            s.write(AGENT, &a(), k, b"v", MemoryCategory::Cache, None, None)
                .unwrap();
            (entry_id(AGENT, k), k.to_string())
        })
        .collect();
    ids.sort();
    let by_query: Vec<String> = s
        .query(AGENT, &a(), &MemoryFilter::default())
        .unwrap()
        .into_iter()
        .map(|e| e.key)
        .collect();
    assert_eq!(
        by_query,
        ids.iter().map(|(_, k)| k.clone()).collect::<Vec<_>>()
    );

    // Eviction takes the same order: the lowest entryId goes first.
    let sink = Arc::new(RecordingSink::default());
    let s = MemoryStore::in_memory(sink.clone())
        .unwrap()
        .with_clock(|| T0);
    s.create_memory(AGENT, 8).unwrap();
    for k in ["a", "b", "c", "d"] {
        s.write(AGENT, &a(), k, b"v", MemoryCategory::Cache, None, None)
            .unwrap();
    }
    s.write(
        AGENT,
        &a(),
        "e",
        b"v",
        MemoryCategory::Preference,
        None,
        None,
    )
    .unwrap();
    assert_eq!(evicted(&sink), vec![ids[0].0.clone()]);
}

#[test]
fn shared_policies_are_denied_because_data_policy_has_no_anonymization() {
    let (s, sink) = store();
    for share in [SharePolicy::AnonymizedShare, SharePolicy::KnowledgeGene] {
        let p = MemoryAccessPolicy {
            share_policy: share,
            ..MemoryAccessPolicy::default()
        };
        let err = s
            .write(
                AGENT,
                &a(),
                "k",
                b"v",
                MemoryCategory::Context,
                Some(p),
                None,
            )
            .unwrap_err();
        assert_eq!(err.code(), "MEMORY_ACCESS_DENIED");
        assert!(
            err.message().contains(share.as_str()) && err.message().contains("DataPolicy"),
            "{}",
            err.message()
        );
    }
    assert!(
        s.get_memory(AGENT).is_err(),
        "a refused write created a memory"
    );
    assert_eq!(sink.telemetry.lock().unwrap().len(), 2);
    // PRIVATE is fine.
    s.write(
        AGENT,
        &a(),
        "k",
        b"v",
        MemoryCategory::Context,
        Some(MemoryAccessPolicy::default()),
        None,
    )
    .unwrap();
}

#[test]
fn query_leaves_out_what_the_caller_may_not_read_without_reporting_denials() {
    let (s, sink) = store();
    s.write(
        AGENT,
        &a(),
        "mine",
        b"1",
        MemoryCategory::Context,
        None,
        None,
    )
    .unwrap();
    s.write(
        AGENT,
        &a(),
        "open",
        b"2",
        MemoryCategory::Context,
        Some(policy(AccessScope::AllGenes, AccessScope::AllGenes)),
        None,
    )
    .unwrap();
    let seen = s.query(AGENT, &other(), &MemoryFilter::default()).unwrap();
    assert_eq!(
        seen.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
        vec!["open"]
    );
    // A query is a scan and records no reader.
    assert_eq!(seen[0].last_accessed_by.as_deref(), Some("v2:gene-a"));
    assert!(sink.telemetry.lock().unwrap().is_empty());
}

#[test]
fn last_accessed_by_follows_reads_and_writes_but_not_queries() {
    // The same in every binding: a successful write (new or
    // overwrite) and a read set lastAccessedBy to the calling gene; a query
    // leaves it alone — it scans up to 1000 rows, and recording each would
    // turn a read path into a write path.
    let (s, _) = store();
    let open = Some(policy(AccessScope::AllGenes, AccessScope::AllGenes));
    let w = s
        .write(AGENT, &a(), "k", b"1", MemoryCategory::Context, open, None)
        .unwrap();
    assert_eq!(w.last_accessed_by.as_deref(), Some(w.created_by.as_str()));
    let stored = |s: &MemoryStore| s.get_memory(AGENT).unwrap().entries[0].clone();
    assert_eq!(stored(&s).last_accessed_by.as_deref(), Some("v2:gene-a"));

    let w = s
        .write(
            AGENT,
            &other(),
            "k",
            b"2",
            MemoryCategory::Context,
            None,
            None,
        )
        .unwrap();
    assert_eq!(w.last_accessed_by.as_deref(), Some("v2:gene-b"));
    assert_eq!(w.created_by, "v2:gene-a");
    assert_eq!(stored(&s).last_accessed_by.as_deref(), Some("v2:gene-b"));

    let before = stored(&s);
    let seen = s.query(AGENT, &a_twin(), &MemoryFilter::default()).unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(
        seen[0].last_accessed_by.as_deref(),
        Some("v2:gene-b"),
        "the query response"
    );
    assert_eq!(stored(&s), before, "the query changed the stored entry");

    let r = s.read(AGENT, &a_twin(), "k", None).unwrap().unwrap();
    assert_eq!(r.last_accessed_by.as_deref(), Some("v2:gene-a2"));
    assert_eq!(stored(&s).last_accessed_by.as_deref(), Some("v2:gene-a2"));
}

// ── input validation ─────────────────────────────────────────────────────

#[test]
fn bad_keys_retention_and_quotas_are_invalid_input() {
    let (s, _) = store();
    for key in ["", "a\0b"] {
        assert_eq!(
            s.write(AGENT, &a(), key, b"v", MemoryCategory::Cache, None, None)
                .unwrap_err()
                .code(),
            "MEMORY_INVALID_INPUT"
        );
    }
    let long = "k".repeat(MAX_KEY_BYTES_FOR_TEST + 1);
    assert_eq!(
        s.read(AGENT, &a(), &long, None).unwrap_err().code(),
        "MEMORY_INVALID_INPUT"
    );
    // A retentionPolicy that is not the §30.2 shape cannot be built; every
    // binding parses it into this type first (the host call maps the parse
    // error to MEMORY_INVALID_INPUT, see memory_calls tests).
    assert!(serde_json::from_value::<RetentionPolicy>(serde_json::json!(30)).is_err());
    assert_eq!(
        s.create_memory(AGENT, 0).unwrap_err().code(),
        "MEMORY_INVALID_INPUT"
    );
    assert_eq!(
        s.create_memory("", 10).unwrap_err().code(),
        "MEMORY_INVALID_INPUT"
    );
    assert_eq!(
        s.write("", &a(), "k", b"v", MemoryCategory::Cache, None, None)
            .unwrap_err()
            .code(),
        "MEMORY_INVALID_INPUT"
    );
}

const MAX_KEY_BYTES_FOR_TEST: usize = 1024;

#[test]
fn a_retention_policy_object_is_kept() {
    let (s, _) = store();
    let r = RetentionPolicy {
        max_retention_days: Some(30),
        auto_delete_on_termination: true,
        anonymization_supported: false,
    };
    s.write(
        AGENT,
        &a(),
        "k",
        b"v",
        MemoryCategory::Context,
        None,
        Some(Some(r)),
    )
    .unwrap();
    assert_eq!(
        s.read(AGENT, &a(), "k", None)
            .unwrap()
            .unwrap()
            .retention_policy,
        Some(r)
    );
}

// ── memory lifecycle ─────────────────────────────────────────────────────

#[test]
fn create_memory_sets_the_quota_once() {
    let (s, sink) = store();
    let m = s.create_memory(AGENT, 2048).unwrap();
    assert_eq!((m.quota, m.total_size, m.entries.len()), (2048, 0, 0));
    assert_eq!(
        s.create_memory(AGENT, 4096).unwrap_err().code(),
        "MEMORY_INVALID_INPUT"
    );
    assert_eq!(actions(&sink), vec![MemoryAction::MemoryCreated]);
    assert_eq!(
        s.get_memory("nobody").unwrap_err().code(),
        "MEMORY_NOT_FOUND"
    );
    assert_eq!(
        s.set_quota("nobody", 10).unwrap_err().code(),
        "MEMORY_NOT_FOUND"
    );
    assert_eq!(
        s.set_quota(AGENT, 0).unwrap_err().code(),
        "MEMORY_INVALID_INPUT"
    );
}

#[test]
fn an_agent_without_memory_gets_the_default_quota_on_first_write() {
    let (s, sink) = store();
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Cache, None, None)
        .unwrap();
    assert_eq!(s.get_memory(AGENT).unwrap().quota, DEFAULT_QUOTA_BYTES);
    assert_eq!(actions(&sink)[0], MemoryAction::MemoryCreated);
}

#[test]
fn export_keeps_policies_and_creators_and_may_drop_cache() {
    let (s, _) = store();
    let p = Some(policy(
        AccessScope::CreatorGeneOnly,
        AccessScope::CreatorGeneOnly,
    ));
    s.write(
        AGENT,
        &a(),
        "pref",
        b"1",
        MemoryCategory::Preference,
        p,
        None,
    )
    .unwrap();
    s.write(
        AGENT,
        &a(),
        "cache",
        b"2",
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap();

    let bundle = s.export(AGENT, false).unwrap();
    assert_eq!(bundle.entries.len(), 1);
    assert_eq!(bundle.entries[0].created_by, "v2:gene-a");
    assert_eq!(
        bundle.entries[0].access_policy.read_scope,
        AccessScope::CreatorGeneOnly
    );
    assert_eq!(bundle.total_size, 5);
    assert_eq!(s.export(AGENT, true).unwrap().entries.len(), 2);

    // The bundle is the wire shape.
    let json = serde_json::to_value(&bundle).unwrap();
    assert_eq!(json["agentId"], AGENT);
    assert_eq!(json["entries"][0]["category"], "PREFERENCE");
}

// ── memory belongs to the agent, not to a gene ───────────────────────────

#[test]
fn replacing_the_genome_keeps_every_entry() {
    use crate::storage::{AgentStore, SqliteStore};
    use crate::types::agent::Agent;

    let dir = std::env::temp_dir().join(format!("rotifer-mem-m5-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("rotifer.db");

    // The agent table and the memory tables share one database file.
    let agents = SqliteStore::new(&db).unwrap();
    let mut agent = Agent::new("memo".into());
    agent.genome = vec![[1u8; 32]];
    agents.save_agent(&agent).unwrap();

    let memory = MemoryStore::open(&db, Arc::new(NullSink)).unwrap();
    memory
        .write(
            &agent.id,
            &a(),
            "lang",
            b"zh",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
    memory
        .write(
            &agent.id,
            &a(),
            "tone",
            b"short",
            MemoryCategory::Pattern,
            None,
            None,
        )
        .unwrap();
    let before = memory.get_memory(&agent.id).unwrap();

    // Gene A is replaced by A2, same domain.
    agent.genome = vec![[2u8; 32]];
    agents.save_agent(&agent).unwrap();
    assert_eq!(
        agents.get_agent(&agent.id).unwrap().unwrap().genome,
        vec![[2u8; 32]]
    );

    let after = memory.get_memory(&agent.id).unwrap();
    assert_eq!(after, before, "a genome change rewrote memory");
    let read = memory
        .read(&agent.id, &a_twin(), "lang", None)
        .unwrap()
        .unwrap();
    assert_eq!(read.value, b"zh");
    assert_eq!(
        read.created_by, "v2:gene-a",
        "createdBy keeps the gene that is gone"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn memory_persists_across_sessions() {
    let dir = std::env::temp_dir().join(format!("rotifer-mem-sessions-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("rotifer.db");
    {
        let s = MemoryStore::open(&db, Arc::new(NullSink)).unwrap();
        s.create_memory(AGENT, 4096).unwrap();
        s.write(
            AGENT,
            &a(),
            "lang",
            b"zh",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
    }
    let s = MemoryStore::open(&db, Arc::new(NullSink)).unwrap();
    let m = s.get_memory(AGENT).unwrap();
    assert_eq!(m.quota, 4096);
    assert_eq!(
        s.read(AGENT, &a(), "lang", None).unwrap().unwrap().value,
        b"zh"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn every_state_change_lands_in_audit_jsonl() {
    let dir = std::env::temp_dir().join(format!("rotifer-mem-audit-{}", uuid::Uuid::new_v4()));
    let rotifer_dir = dir.join(".rotifer");
    let s = MemoryStore::in_memory(Arc::new(JsonlSink::from_env(&rotifer_dir, |_| None))).unwrap();
    s.create_memory(AGENT, 25).unwrap(); // created
    s.write(
        AGENT,
        &a(),
        "c1",
        b"12345678",
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap(); // write
    s.write(
        AGENT,
        &a(),
        "c1",
        b"123456789",
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap(); // update
    s.write(
        AGENT,
        &a(),
        "c2",
        b"12345678",
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap(); // write
    s.write(
        AGENT,
        &a(),
        "f1",
        b"12345678",
        MemoryCategory::Preference,
        None,
        None,
    )
    .unwrap(); // evict c1 + write
    let _ = s.write(
        AGENT,
        &a(),
        "f2",
        &[0u8; 30],
        MemoryCategory::Preference,
        None,
        None,
    ); // quota rejected
    let _ = s.read(AGENT, &other(), "f1", None); // access denied
    s.delete(AGENT, &a(), "f1").unwrap(); // delete

    let lines: Vec<serde_json::Value> = std::fs::read_to_string(rotifer_dir.join("audit.jsonl"))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let got: Vec<&str> = lines
        .iter()
        .map(|l| l["action"].as_str().unwrap())
        .collect();
    assert_eq!(
        got,
        vec![
            "memory_created",
            "write",
            "update",
            "write",
            "evict",
            "write",
            "quota_rejected",
            "access_denied",
            "delete"
        ]
    );
    assert!(
        lines
            .iter()
            .all(|l| l["kind"] == "agent_memory" && l["agentId"] == AGENT)
    );
    let telemetry = std::fs::read_to_string(rotifer_dir.join("telemetry.jsonl")).unwrap();
    assert_eq!(telemetry.lines().count(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

// ── overwrites, limits and filters ───────────────────────────────────────

#[test]
fn keys_are_1_to_1024_bytes() {
    let (s, _) = store();
    let max = "k".repeat(1024);
    s.write(AGENT, &a(), &max, b"v", MemoryCategory::Cache, None, None)
        .unwrap();
    assert!(s.read(AGENT, &a(), &max, None).unwrap().is_some());
    // Bytes, not characters: 342 three-byte characters are 1026 bytes.
    let wide = "\u{4e2d}".repeat(342);
    assert_eq!(wide.len(), 1026);
    for bad in ["k".repeat(1025), wide, String::new(), "a\0".into()] {
        assert_eq!(
            s.write(AGENT, &a(), &bad, b"v", MemoryCategory::Cache, None, None)
                .unwrap_err()
                .code(),
            "MEMORY_INVALID_INPUT"
        );
    }
}

/// A store whose clock the test sets.
fn manual_clock() -> (MemoryStore, Arc<RecordingSink>, Arc<AtomicI64>) {
    let sink = Arc::new(RecordingSink::default());
    let now = Arc::new(AtomicI64::new(T0));
    let clock = now.clone();
    let s = MemoryStore::in_memory(sink.clone())
        .unwrap()
        .with_clock(move || clock.load(Ordering::SeqCst));
    (s, sink, now)
}

#[test]
fn oldest_means_least_recently_updated_for_pattern_and_context_too() {
    for category in [MemoryCategory::Pattern, MemoryCategory::Context] {
        let (s, sink, now) = manual_clock();
        s.create_memory(AGENT, 25).unwrap();
        now.store(T0 + 1, Ordering::SeqCst);
        s.write(AGENT, &a(), "o1", b"12345678", category, None, None)
            .unwrap();
        now.store(T0 + 2, Ordering::SeqCst);
        s.write(AGENT, &a(), "o2", b"12345678", category, None, None)
            .unwrap();
        // o1 is rewritten last: it now counts as the fresher of the two.
        now.store(T0 + 3, Ordering::SeqCst);
        s.write(AGENT, &a(), "o1", b"87654321", category, None, None)
            .unwrap();
        now.store(T0 + 4, Ordering::SeqCst);
        s.write(
            AGENT,
            &a(),
            "nn",
            b"12345678",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
        assert_eq!(evicted(&sink), ids(&["o2"]), "{category:?}");
    }
}

#[test]
fn equal_updated_at_falls_back_to_entry_id_for_every_category() {
    for category in [MemoryCategory::Pattern, MemoryCategory::Context] {
        let sink = Arc::new(RecordingSink::default());
        let s = MemoryStore::in_memory(sink.clone())
            .unwrap()
            .with_clock(|| T0);
        s.create_memory(AGENT, 30).unwrap();
        for k in ["aa", "bb", "cc"] {
            s.write(AGENT, &a(), k, b"12345678", category, None, None)
                .unwrap();
        }
        s.write(
            AGENT,
            &a(),
            "zz",
            b"12345678",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
        let mut by_id = ids(&["aa", "bb", "cc"]);
        by_id.sort();
        assert_eq!(evicted(&sink), vec![by_id[0].clone()], "{category:?}");
    }
}

#[test]
fn an_overwrite_keeps_creator_policy_and_retention_unless_the_creator_changes_them() {
    let (s, sink) = store();
    let keep = retention(Some(30));
    s.write(
        AGENT,
        &a(),
        "k",
        b"1",
        MemoryCategory::Context,
        None,
        Some(Some(keep)),
    )
    .unwrap();

    // Another same-domain gene: may overwrite the value...
    let w = s
        .write(
            AGENT,
            &a_twin(),
            "k",
            b"2",
            MemoryCategory::Context,
            None,
            None,
        )
        .unwrap();
    assert_eq!(w.created_by, "v2:gene-a");
    assert_eq!(
        w.retention_policy,
        Some(keep),
        "an overwrite without retentionPolicy cleared it"
    );
    assert_eq!(
        s.read(AGENT, &a(), "k", None)
            .unwrap()
            .unwrap()
            .retention_policy,
        Some(keep)
    );
    // ...and may restate the same policy and retention...
    s.write(
        AGENT,
        &a_twin(),
        "k",
        b"3",
        MemoryCategory::Context,
        Some(MemoryAccessPolicy::default()),
        Some(Some(keep)),
    )
    .unwrap();
    // ...but not change either: refused, not silently ignored.
    let before = sink.telemetry.lock().unwrap().len();
    let err = s
        .write(
            AGENT,
            &a_twin(),
            "k",
            b"4",
            MemoryCategory::Context,
            None,
            Some(Some(retention(Some(1)))),
        )
        .unwrap_err();
    assert_eq!(err.code(), "MEMORY_ACCESS_DENIED");
    assert!(err.message().contains("retentionPolicy"));
    assert_eq!(sink.telemetry.lock().unwrap().len(), before + 1);
    assert_eq!(s.read(AGENT, &a(), "k", None).unwrap().unwrap().value, b"3");

    // The creator may change the retention.
    let changed = retention(Some(7));
    let w = s
        .write(
            AGENT,
            &a(),
            "k",
            b"5",
            MemoryCategory::Context,
            None,
            Some(Some(changed)),
        )
        .unwrap();
    assert_eq!(w.retention_policy, Some(changed));
}

#[test]
fn a_null_retention_is_a_reset_that_only_the_creator_may_make() {
    // Some(None) resets to "inherit the agent's
    // DataPolicy". It is a change, so a non-creator sending it over a
    // stored policy is denied (audited, with telemetry), never ignored.
    let (s, sink) = store();
    let r = retention(Some(30));
    s.write(
        AGENT,
        &a(),
        "k",
        b"1",
        MemoryCategory::Context,
        None,
        Some(Some(r)),
    )
    .unwrap();

    let before = sink.telemetry.lock().unwrap().len();
    let err = s
        .write(
            AGENT,
            &a_twin(),
            "k",
            b"2",
            MemoryCategory::Context,
            None,
            Some(None),
        )
        .unwrap_err();
    assert_eq!(err.code(), "MEMORY_ACCESS_DENIED");
    assert_eq!(sink.telemetry.lock().unwrap().len(), before + 1);
    assert_eq!(actions(&sink).last(), Some(&MemoryAction::AccessDenied));
    let stored = s.read(AGENT, &a(), "k", None).unwrap().unwrap();
    assert_eq!(
        (stored.value, stored.retention_policy),
        (b"1".to_vec(), Some(r))
    );

    // The creator resets it.
    let w = s
        .write(
            AGENT,
            &a(),
            "k",
            b"3",
            MemoryCategory::Context,
            None,
            Some(None),
        )
        .unwrap();
    assert_eq!(w.retention_policy, None);
    assert_eq!(
        s.read(AGENT, &a(), "k", None)
            .unwrap()
            .unwrap()
            .retention_policy,
        None
    );

    // Null over null is no change: anyone with write access may restate it,
    // but setting a policy is still the creator's.
    s.write(
        AGENT,
        &a_twin(),
        "k",
        b"4",
        MemoryCategory::Context,
        None,
        Some(None),
    )
    .unwrap();
    assert_eq!(
        s.write(
            AGENT,
            &a_twin(),
            "k",
            b"5",
            MemoryCategory::Context,
            None,
            Some(Some(r))
        )
        .unwrap_err()
        .code(),
        "MEMORY_ACCESS_DENIED"
    );
    // A new entry written with null simply has none.
    let fresh = s
        .write(
            AGENT,
            &a_twin(),
            "n",
            b"v",
            MemoryCategory::Context,
            None,
            Some(None),
        )
        .unwrap();
    assert_eq!(fresh.retention_policy, None);
}

#[test]
fn a_refused_first_write_leaves_no_memory_behind() {
    // An agent's first write cannot exceed the default 10 MB quota any more:
    // a value is at most 1 MiB. An oversized one is refused as
    // invalid input before the write's transaction starts, so no default
    // memory is created and nothing is logged. (A quota refusal that does
    // create memory first is the import path, covered there.)
    let (s, sink) = store();
    let err = s
        .write(
            AGENT,
            &a(),
            "big",
            &vec![0u8; DEFAULT_QUOTA_BYTES as usize],
            MemoryCategory::Cache,
            None,
            None,
        )
        .unwrap_err();
    assert_eq!(err.code(), "MEMORY_INVALID_INPUT");
    assert!(
        s.get_memory(AGENT).is_err(),
        "a refused first write created the agent's memory"
    );
    assert!(actions(&sink).is_empty());
}

#[test]
fn a_denial_names_neither_the_creator_nor_its_domain() {
    let (s, _) = store();
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Context, None, None)
        .unwrap();
    let msg = s
        .read(AGENT, &other(), "k", None)
        .unwrap_err()
        .message()
        .to_string();
    assert!(
        !msg.contains("text.summarize") && !msg.contains("v2:gene-a") && !msg.contains("\"k\""),
        "{msg}"
    );
    let p = Some(policy(
        AccessScope::CreatorGeneOnly,
        AccessScope::CreatorGeneOnly,
    ));
    s.write(AGENT, &a(), "c", b"v", MemoryCategory::Context, p, None)
        .unwrap();
    let msg = s
        .read(AGENT, &a_twin(), "c", None)
        .unwrap_err()
        .message()
        .to_string();
    assert!(!msg.contains("v2:gene-a"), "{msg}");
}

// ── §38.4 import ─────────────────────────────────────────────────────────

/// A source memory with one entry per category and three policies.
fn exported(include_cache: bool) -> (MemoryStore, AgentMemory) {
    let (s, _) = store();
    s.create_memory(AGENT, 4096).unwrap();
    let thirty_days = retention(Some(30));
    let creator_only = Some(policy(
        AccessScope::CreatorGeneOnly,
        AccessScope::CreatorGeneOnly,
    ));
    let open = Some(policy(AccessScope::AllGenes, AccessScope::AllGenes));
    s.write(
        AGENT,
        &a(),
        "pref",
        b"zh",
        MemoryCategory::Preference,
        creator_only,
        Some(Some(thirty_days)),
    )
    .unwrap();
    s.write(
        AGENT,
        &a(),
        "pat",
        b"short",
        MemoryCategory::Pattern,
        open,
        None,
    )
    .unwrap();
    s.write(
        AGENT,
        &a(),
        "ctx",
        b"faq",
        MemoryCategory::Context,
        None,
        None,
    )
    .unwrap();
    s.write(
        AGENT,
        &a(),
        "cache",
        b"tmp",
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap();
    s.read(AGENT, &a_twin(), "ctx", None).unwrap();
    let bundle = s.export(AGENT, include_cache).unwrap();
    (s, bundle)
}

fn domains_of_a() -> ImportOptions {
    ImportOptions {
        include_cache: false,
        creator_domains: [("v2:gene-a".to_string(), "text.summarize".to_string())].into(),
    }
}

const TARGET: &str = "agent-2";

#[test]
fn export_then_import_keeps_every_field_but_the_agent_bound_entry_id() {
    let (_, bundle) = exported(false);
    let (target, _) = store();
    let imported = target.import(TARGET, &bundle, &domains_of_a()).unwrap();

    assert_eq!(imported.agent_id, TARGET);
    assert_eq!(imported.quota, bundle.quota);
    assert_eq!(imported.total_size, bundle.total_size);
    let mut got = imported.entries.clone();
    let mut want = bundle.entries.clone();
    got.sort_by(|x, y| x.key.cmp(&y.key));
    want.sort_by(|x, y| x.key.cmp(&y.key));
    assert_eq!(got.len(), want.len());
    for (g, w) in got.iter().zip(&want) {
        // entryId is sha256(agentId + "\0" + key): a new agent, a new id.
        assert_eq!(g.entry_id, entry_id(TARGET, &g.key));
        assert_eq!(
            MemoryEntry {
                entry_id: w.entry_id.clone(),
                ..g.clone()
            },
            *w,
            "{} changed on the way",
            g.key
        );
    }
}

#[test]
fn import_drops_cache_unless_asked_and_ignores_cache_in_the_bundle_by_default() {
    let (_, with_cache) = exported(true);
    assert!(
        with_cache
            .entries
            .iter()
            .any(|e| e.category == MemoryCategory::Cache)
    );

    let (t1, _) = store();
    let m = t1.import(TARGET, &with_cache, &domains_of_a()).unwrap();
    assert!(
        m.entries
            .iter()
            .all(|e| e.category != MemoryCategory::Cache)
    );

    let (t2, _) = store();
    let keep = ImportOptions {
        include_cache: true,
        ..domains_of_a()
    };
    let m = t2.import(TARGET, &with_cache, &keep).unwrap();
    assert!(
        m.entries
            .iter()
            .any(|e| e.category == MemoryCategory::Cache)
    );
}

#[test]
fn entries_import_even_when_their_creator_gene_is_not_in_the_target_agent() {
    let (_, bundle) = exported(false);
    let (target, _) = store();
    // No domain known for the creator: it is not part of this agent.
    target
        .import(TARGET, &bundle, &ImportOptions::default())
        .unwrap();
    let m = target.get_memory(TARGET).unwrap();
    assert_eq!(m.entries.len(), 3);
    assert!(m.entries.iter().all(|e| e.created_by == "v2:gene-a"));

    // ALL_GENES reads for anyone; CREATOR_GENE_ONLY still answers to the
    // creator's id; SAME_DOMAIN with an unknown creator domain matches no one.
    assert!(
        target
            .read(TARGET, &other(), "pat", None)
            .unwrap()
            .is_some()
    );
    assert!(target.read(TARGET, &a(), "pref", None).unwrap().is_some());
    assert_eq!(
        target.read(TARGET, &a(), "ctx", None).unwrap_err().code(),
        "MEMORY_ACCESS_DENIED"
    );

    // With the creator's domain given, SAME_DOMAIN works as it did.
    let (mapped, _) = store();
    mapped.import(TARGET, &bundle, &domains_of_a()).unwrap();
    assert!(
        mapped
            .read(TARGET, &a_twin(), "ctx", None)
            .unwrap()
            .is_some()
    );
}

#[test]
fn import_respects_the_target_quota_and_changes_nothing_when_it_does_not_fit() {
    let (_, bundle) = exported(false);
    let (target, sink) = store();
    target.create_memory(TARGET, 10).unwrap();
    let err = target.import(TARGET, &bundle, &domains_of_a()).unwrap_err();
    assert_eq!(err.code(), "MEMORY_QUOTA_EXCEEDED");
    assert!(target.get_memory(TARGET).unwrap().entries.is_empty());
    assert_eq!(
        sink.audits.lock().unwrap().last().unwrap().action,
        MemoryAction::QuotaRejected
    );

    // A target without memory takes the bundle's quota; if that fails too,
    // no memory is left behind.
    let mut small = bundle.clone();
    small.quota = 5;
    let (fresh, _) = store();
    assert_eq!(
        fresh
            .import(TARGET, &small, &domains_of_a())
            .unwrap_err()
            .code(),
        "MEMORY_QUOTA_EXCEEDED"
    );
    assert!(fresh.get_memory(TARGET).is_err());
}

#[test]
fn import_never_overwrites_an_existing_key() {
    let (_, bundle) = exported(false);
    let (target, _) = store();
    target
        .write(
            TARGET,
            &a(),
            "pref",
            b"mine",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
    assert_eq!(
        target
            .import(TARGET, &bundle, &domains_of_a())
            .unwrap_err()
            .code(),
        "MEMORY_INVALID_INPUT"
    );
    let m = target.get_memory(TARGET).unwrap();
    assert_eq!(m.entries.len(), 1);
    assert_eq!(m.entries[0].value, b"mine");
}

/// A change that makes a bundle unimportable.
type Mutation = Box<dyn Fn(&mut AgentMemory)>;

#[test]
fn import_refuses_what_a_write_would_refuse() {
    let (_, bundle) = exported(false);
    let cases: Vec<(&str, Mutation)> = vec![
        (
            "MEMORY_ACCESS_DENIED",
            Box::new(|m| m.entries[0].access_policy.share_policy = SharePolicy::KnowledgeGene),
        ),
        (
            "MEMORY_INVALID_INPUT",
            Box::new(|m| m.entries[0].key = String::new()),
        ),
        (
            "MEMORY_INVALID_INPUT",
            Box::new(|m| {
                let dup = m.entries[0].clone();
                m.entries.push(dup);
            }),
        ),
        ("MEMORY_INVALID_INPUT", Box::new(|m| m.quota = 0)),
    ];
    for (code, mutate) in cases {
        let mut b = bundle.clone();
        mutate(&mut b);
        let (target, _) = store();
        assert_eq!(
            target
                .import(TARGET, &b, &domains_of_a())
                .unwrap_err()
                .code(),
            code
        );
        assert!(
            target.get_memory(TARGET).is_err(),
            "a refused import left memory behind ({code})"
        );
    }
    let (target, _) = store();
    assert_eq!(
        target
            .import("", &bundle, &domains_of_a())
            .unwrap_err()
            .code(),
        "MEMORY_INVALID_INPUT"
    );
    // A bundle whose retentionPolicy is not the §30.2 shape never becomes an
    // AgentMemory: the bindings parse before importing (napi test
    // retention_policy_is_validated_strictly_through_the_binding).
    let mut json = serde_json::to_value(&bundle).unwrap();
    json["entries"][0]["retentionPolicy"] = serde_json::json!({"maxRetentionDays": 7});
    assert!(serde_json::from_value::<AgentMemory>(json).is_err());
}

#[test]
fn every_imported_entry_is_one_audit_line() {
    let (_, bundle) = exported(false);
    let (target, sink) = store();
    target.import(TARGET, &bundle, &domains_of_a()).unwrap();
    let audits = sink.audits.lock().unwrap();
    assert_eq!(audits[0].action, MemoryAction::MemoryCreated);
    let imports: Vec<_> = audits
        .iter()
        .filter(|e| e.action == MemoryAction::Import)
        .collect();
    assert_eq!(imports.len(), 3);
    assert!(
        imports
            .iter()
            .all(|e| e.agent_id == TARGET && e.size_delta > 0 && e.gene_id.is_none())
    );
    assert_eq!(imports.last().unwrap().total_size, bundle.total_size);
}

// ── size limits ──────────────────────────────────────────────────────────

#[test]
fn a_value_is_at_most_one_mib() {
    let (s, _) = store();
    let at = vec![7u8; MAX_VALUE_BYTES];
    s.write(AGENT, &a(), "at", &at, MemoryCategory::Cache, None, None)
        .unwrap();
    let over = vec![7u8; MAX_VALUE_BYTES + 1];
    let err = s
        .write(
            AGENT,
            &a(),
            "over",
            &over,
            MemoryCategory::Cache,
            None,
            None,
        )
        .unwrap_err();
    assert_eq!(err.code(), "MEMORY_INVALID_INPUT");
    assert!(s.read(AGENT, &a(), "over", None).unwrap().is_none());

    // Import holds the same line.
    let mut bundle = s.export(AGENT, true).unwrap();
    bundle.entries[0].value = over;
    let (target, _) = store();
    assert_eq!(
        target
            .import(
                "agent-2",
                &bundle,
                &ImportOptions {
                    include_cache: true,
                    ..Default::default()
                }
            )
            .unwrap_err()
            .code(),
        "MEMORY_INVALID_INPUT"
    );
}

#[test]
fn a_query_over_four_mib_is_refused_not_truncated() {
    let (s, _) = store();
    s.create_memory(AGENT, 20 * 1024 * 1024).unwrap();
    // Five 1 MiB values: about 7 MiB once base64-encoded.
    for i in 0..5 {
        s.write(
            AGENT,
            &a(),
            &format!("big{i}"),
            &vec![1u8; MAX_VALUE_BYTES],
            MemoryCategory::Cache,
            None,
            None,
        )
        .unwrap();
    }
    let err = s.query(AGENT, &a(), &MemoryFilter::default()).unwrap_err();
    assert_eq!(err.code(), "MEMORY_INVALID_INPUT");
    assert!(
        err.message()
            .contains("result too large; lower limit or narrow the filter"),
        "{}",
        err.message()
    );
    // Two of them fit.
    let two = s
        .query(
            AGENT,
            &a(),
            &MemoryFilter {
                limit: Some(2),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(two.len(), 2);
    assert!(serde_json::to_vec(&two).unwrap().len() <= MAX_QUERY_RESPONSE_BYTES);
}

// ── audited quota changes, private files ─────────────────────────────────

#[test]
fn a_quota_change_is_audited() {
    let (s, sink) = store();
    s.create_memory(AGENT, 4096).unwrap();
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Cache, None, None)
        .unwrap();
    s.set_quota(AGENT, 2048).unwrap();
    let last = sink.audits.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.action, MemoryAction::QuotaChanged);
    assert_eq!((last.quota, last.total_size, last.gene_id), (2048, 2, None));
}

#[cfg(unix)]
#[test]
fn the_memory_database_is_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("rotifer-mem-dbperm-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("playground.db");
    // An existing database (the binding's other store opened it first).
    std::fs::write(&db, b"").unwrap();
    std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o644)).unwrap();
    let _s = MemoryStore::open(&db, Arc::new(NullSink)).unwrap();
    let mode = std::fs::metadata(&db).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "playground.db is {mode:o}");
    std::fs::remove_dir_all(dir).unwrap();
}

// ── audit before commit ──────────────────────────────────────────────────

/// A JSON-lines sink whose directory can be blocked by a plain file, so its
/// audit appends fail on demand.
struct BlockableLog {
    root: std::path::PathBuf,
}

impl BlockableLog {
    fn new() -> (Self, Arc<JsonlSink>) {
        let root = std::env::temp_dir().join(format!("rotifer-mem-k4-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let sink = Arc::new(JsonlSink::from_env(&root.join("rotifer"), |_| None));
        (Self { root }, sink)
    }

    fn block(&self) {
        let dir = self.root.join("rotifer");
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir).unwrap();
        }
        std::fs::write(&dir, b"not a directory").unwrap();
    }

    fn unblock(&self) {
        let dir = self.root.join("rotifer");
        if dir.is_file() {
            std::fs::remove_file(&dir).unwrap();
        }
    }
}

impl Drop for BlockableLog {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn a_change_whose_audit_line_cannot_be_written_is_rolled_back() {
    let (log, sink) = BlockableLog::new();
    let s = MemoryStore::in_memory(sink).unwrap();
    let storage = |r: Result<(), MemoryError>| r.unwrap_err().code();

    // Nothing exists yet: neither an explicit create nor a first write may
    // leave a memory behind.
    log.block();
    assert_eq!(
        storage(s.create_memory(AGENT, 64).map(drop)),
        "MEMORY_STORAGE_ERROR"
    );
    assert_eq!(
        storage(
            s.write(AGENT, &a(), "k", b"v", MemoryCategory::Cache, None, None)
                .map(drop)
        ),
        "MEMORY_STORAGE_ERROR"
    );
    assert!(
        s.get_memory(AGENT).is_err(),
        "a change without its audit line stayed"
    );

    log.unblock();
    s.create_memory(AGENT, 64).unwrap();
    s.write(
        AGENT,
        &a(),
        "old",
        &[1; 30],
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap();
    s.write(
        AGENT,
        &a(),
        "pref",
        b"zh",
        MemoryCategory::Preference,
        None,
        None,
    )
    .unwrap();
    let before = s.get_memory(AGENT).unwrap();

    log.block();
    // An update, and a write that would evict "old": both refused whole.
    for (key, value) in [("old", vec![2u8; 30]), ("new", vec![3u8; 30])] {
        assert_eq!(
            storage(
                s.write(AGENT, &a(), key, &value, MemoryCategory::Cache, None, None)
                    .map(drop)
            ),
            "MEMORY_STORAGE_ERROR",
            "{key}"
        );
    }
    assert_eq!(
        storage(s.delete(AGENT, &a(), "old")),
        "MEMORY_STORAGE_ERROR"
    );
    assert_eq!(storage(s.set_quota(AGENT, 4096)), "MEMORY_STORAGE_ERROR");
    assert_eq!(
        storage(s.import(TARGET, &before, &domains_of_a()).map(drop)),
        "MEMORY_STORAGE_ERROR"
    );
    let after = s.get_memory(AGENT).unwrap();
    assert_eq!(
        (after.quota, after.total_size, after.entries.len()),
        (before.quota, before.total_size, before.entries.len())
    );
    assert_eq!(
        s.read(AGENT, &a(), "old", None).unwrap().unwrap().value,
        vec![1u8; 30]
    );
    assert!(s.get_memory(TARGET).is_err());

    // A read is not a state change: its lastAccessedBy update is not
    // audited, so it works while the log is down. A denial stays a denial.
    assert_eq!(
        s.read(AGENT, &a_twin(), "pref", None)
            .unwrap()
            .unwrap()
            .last_accessed_by
            .as_deref(),
        Some("v2:gene-a2")
    );
    assert_eq!(
        s.read(AGENT, &other(), "pref", None).unwrap_err().code(),
        "MEMORY_ACCESS_DENIED"
    );
}

// ── query scans, it does not load ────────────────────────────────────────

#[test]
fn a_query_never_reads_rows_past_its_limit_or_outside_its_filter() {
    // The planted row's createdAt is not a number, so decoding it fails; the
    // retention purge reads only updatedAt and the policy, so
    // it passes the row by.
    // An undecodable row is planted where a scanning query never needs to
    // look: older than the two rows a limit of 2 returns, and in another
    // category than the one asked for. A query that loaded the table first
    // would hit it every time.
    let dir = std::env::temp_dir().join(format!("rotifer-mem-k2-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("playground.db");
    let tick = AtomicI64::new(T0);
    let s = MemoryStore::open(&db, Arc::new(RecordingSink::default()))
        .unwrap()
        .with_clock(move || tick.fetch_add(1000, Ordering::SeqCst));
    for key in ["p1", "p2"] {
        s.write(
            AGENT,
            &a(),
            key,
            b"v",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
    }
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO agent_memory_entries (entry_id, agent_id, category, key, value, created_by, \
             creator_domain, last_accessed_by, created_at, updated_at, read_scope, write_scope, \
             share_policy, retention_policy) VALUES ('planted', ?1, 'CONTEXT', 'bad', x'00', \
             'v2:gene-a', 'text.summarize', NULL, 'not a number', 0, 'ALL_GENES', 'ALL_GENES', 'PRIVATE', NULL)",
            rusqlite::params![AGENT],
        )
        .unwrap();
    let query = |filter: MemoryFilter| s.query(AGENT, &a(), &filter);

    let two = query(MemoryFilter {
        limit: Some(2),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        two.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(),
        ["p2", "p1"]
    );
    let preferences = query(MemoryFilter {
        category: Some(MemoryCategory::Preference),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(preferences.len(), 2);
    // The planted row is real: a query that has to reach it fails on it.
    assert_eq!(
        query(MemoryFilter::default()).unwrap_err().code(),
        "MEMORY_STORAGE_ERROR"
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn eviction_scans_the_oldest_first_and_stops_once_there_is_room() {
    // The planted row's createdAt is not a number, so decoding it fails; the
    // retention purge reads only updatedAt and the policy, so
    // it passes the row by.
    // The write's eviction plan reads candidates in eviction order and stops
    // as soon as enough is freed; it does not load every CACHE, PATTERN and
    // CONTEXT entry first. A planted undecodable CONTEXT row (evicted last)
    // is never needed when freeing one CACHE entry is enough.
    let dir = std::env::temp_dir().join(format!("rotifer-mem-k2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("playground.db");
    let tick = AtomicI64::new(T0);
    let s = MemoryStore::open(&db, Arc::new(RecordingSink::default()))
        .unwrap()
        .with_clock(move || tick.fetch_add(1000, Ordering::SeqCst));
    s.create_memory(AGENT, 64).unwrap();
    s.write(
        AGENT,
        &a(),
        "c",
        &[1; 30],
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap();
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute(
            "INSERT INTO agent_memory_entries (entry_id, agent_id, category, key, value, created_by, \
             creator_domain, last_accessed_by, created_at, updated_at, read_scope, write_scope, \
             share_policy, retention_policy) VALUES ('planted', ?1, 'CONTEXT', 'bad', x'00', \
             'v2:gene-a', 'text.summarize', NULL, 'not a number', 0, 'ALL_GENES', 'ALL_GENES', 'PRIVATE', NULL)",
            rusqlite::params![AGENT],
        )
        .unwrap();
    // 31 + 4 stored; another 31 needs 66 of 64: evicting "c" is enough.
    s.write(
        AGENT,
        &a(),
        "n",
        &[2; 30],
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap();
    assert!(s.read(AGENT, &a(), "c", None).unwrap().is_none());
    assert_eq!(
        s.read(AGENT, &a(), "n", None).unwrap().unwrap().value,
        vec![2u8; 30]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

// ── deployer delete ──────────────────────────────────────────────────────

#[test]
fn the_deployer_deletes_by_key_or_category_whatever_the_scopes() {
    // PREFERENCE is never evicted, so a full quota could stay full for good;
    // the deployer owns the agent and may delete any entry. Gene scopes do
    // not apply, and each removed entry is one audit line with
    // actor "deployer".
    let (s, sink) = store();
    let locked = Some(policy(
        AccessScope::CreatorGeneOnly,
        AccessScope::CreatorGeneOnly,
    ));
    for key in ["p1", "p2"] {
        s.write(
            AGENT,
            &a(),
            key,
            b"zh",
            MemoryCategory::Preference,
            locked,
            None,
        )
        .unwrap();
    }
    s.write(
        AGENT,
        &a(),
        "ctx",
        b"faq",
        MemoryCategory::Context,
        locked,
        None,
    )
    .unwrap();
    // Written by another gene: the deployer is not that gene either.
    s.write(
        AGENT,
        &other(),
        "pat",
        b"x",
        MemoryCategory::Pattern,
        locked,
        None,
    )
    .unwrap();

    assert_eq!(
        s.admin_delete(AGENT, AdminDelete::Category(MemoryCategory::Preference))
            .unwrap(),
        2
    );
    // Only that category went.
    let mut left = keys(&s);
    left.sort();
    assert_eq!(left, ["ctx", "pat"]);
    assert_eq!(s.admin_delete(AGENT, AdminDelete::Key("ctx")).unwrap(), 1);
    assert_eq!(s.admin_delete(AGENT, AdminDelete::Key("pat")).unwrap(), 1);
    let m = s.get_memory(AGENT).unwrap();
    assert_eq!((m.entries.len(), m.total_size), (0, 0));

    let audits = sink.audits.lock().unwrap();
    let deletes: Vec<_> = audits
        .iter()
        .filter(|e| e.action == MemoryAction::Delete)
        .collect();
    assert_eq!(deletes.len(), 4);
    for d in &deletes {
        assert_eq!((d.actor, d.gene_id.as_deref()), (Some("deployer"), None));
    }
    assert_eq!(deletes.last().unwrap().total_size, 0);
    assert_eq!(
        serde_json::to_value(deletes[0]).unwrap()["actor"],
        "deployer"
    );
    // A gene's own lines carry no actor field.
    let write = audits
        .iter()
        .find(|e| e.action == MemoryAction::Write)
        .unwrap();
    assert!(serde_json::to_value(write).unwrap().get("actor").is_none());
}

#[test]
fn a_deployer_delete_of_nothing() {
    let (s, _) = store();
    assert_eq!(
        s.admin_delete(AGENT, AdminDelete::Key("k"))
            .unwrap_err()
            .code(),
        "MEMORY_NOT_FOUND",
        "no memory at all"
    );
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Cache, None, None)
        .unwrap();
    assert_eq!(
        s.admin_delete(AGENT, AdminDelete::Key("nope"))
            .unwrap_err()
            .code(),
        "MEMORY_NOT_FOUND"
    );
    assert_eq!(
        s.admin_delete(AGENT, AdminDelete::Key(""))
            .unwrap_err()
            .code(),
        "MEMORY_INVALID_INPUT"
    );
    assert_eq!(
        s.admin_delete(AGENT, AdminDelete::Category(MemoryCategory::Pattern))
            .unwrap(),
        0
    );
}

#[test]
fn a_deployer_delete_whose_audit_cannot_be_written_deletes_nothing() {
    let (log, sink) = BlockableLog::new();
    let s = MemoryStore::in_memory(sink).unwrap();
    for key in ["a", "b"] {
        s.write(
            AGENT,
            &a(),
            key,
            b"v",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
    }
    log.block();
    assert_eq!(
        s.admin_delete(AGENT, AdminDelete::Category(MemoryCategory::Preference))
            .unwrap_err()
            .code(),
        "MEMORY_STORAGE_ERROR"
    );
    assert_eq!(s.get_memory(AGENT).unwrap().entries.len(), 2);
}

#[test]
fn eviction_audit_lines_record_the_actual_total_after_each_eviction() {
    // Each evict line's totalSize is what the memory holds right after that
    // eviction, never the projected total of the pending write (which can
    // exceed the quota). The write's own line then records the final total.
    let (s, sink) = store();
    s.create_memory(AGENT, 64).unwrap();
    s.write(
        AGENT,
        &a(),
        "c1",
        &[1; 18],
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap(); // 20
    s.write(
        AGENT,
        &a(),
        "c2",
        &[2; 18],
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap(); // 40
    // 3 + 42 = 45 more needs 85 of 64; evicting c1 leaves 65, still over,
    // so c2 goes too.
    s.write(
        AGENT,
        &a(),
        "new",
        &[3; 42],
        MemoryCategory::Cache,
        None,
        None,
    )
    .unwrap();
    let audits = sink.audits.lock().unwrap();
    let totals: Vec<(MemoryAction, u64)> = audits
        .iter()
        .rev()
        .take(3)
        .rev()
        .map(|e| (e.action, e.total_size))
        .collect();
    assert_eq!(
        totals,
        [
            (MemoryAction::Evict, 20),
            (MemoryAction::Evict, 0),
            (MemoryAction::Write, 45)
        ]
    );
    assert!(audits.iter().all(|e| e.total_size <= e.quota));
}

// ── retention is enforced ────────────────────────────────────────────────

const DAY_MS: i64 = 86_400_000;

/// A store whose clock the test sets.
fn store_at() -> (MemoryStore, Arc<RecordingSink>, Arc<AtomicI64>) {
    let sink = Arc::new(RecordingSink::default());
    let now = Arc::new(AtomicI64::new(T0));
    let clock = now.clone();
    let s = MemoryStore::in_memory(sink.clone())
        .unwrap()
        .with_clock(move || clock.load(Ordering::SeqCst));
    (s, sink, now)
}

fn expired_lines(sink: &RecordingSink) -> Vec<events::MemoryAuditEvent> {
    sink.audits
        .lock()
        .unwrap()
        .iter()
        .filter(|e| e.action == MemoryAction::Expired)
        .cloned()
        .collect()
}

#[test]
fn an_entry_expires_at_its_retention_and_not_a_second_before() {
    // now >= updatedAt + maxRetentionDays × 86400 s: still there at one day
    // less a second, gone at one day — and then never returned, not counted
    // against the quota, and recorded as one "expired" audit line.
    let (s, sink, now) = store_at();
    s.create_memory(AGENT, 4096).unwrap();
    s.write(
        AGENT,
        &a(),
        "k",
        b"v",
        MemoryCategory::Context,
        None,
        Some(Some(retention(Some(1)))),
    )
    .unwrap();

    now.store(T0 + DAY_MS - 1000, Ordering::SeqCst);
    assert!(s.read(AGENT, &a(), "k", None).unwrap().is_some());
    assert_eq!(
        s.query(AGENT, &a(), &MemoryFilter::default())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(s.get_memory(AGENT).unwrap().total_size, 2);
    assert!(expired_lines(&sink).is_empty());

    now.store(T0 + DAY_MS, Ordering::SeqCst);
    assert!(s.read(AGENT, &a(), "k", None).unwrap().is_none());
    assert!(
        s.query(AGENT, &a(), &MemoryFilter::default())
            .unwrap()
            .is_empty()
    );
    let m = s.get_memory(AGENT).unwrap();
    assert_eq!((m.entries.len(), m.total_size), (0, 0));
    let lines = expired_lines(&sink);
    assert_eq!(lines.len(), 1, "one line for one expired entry");
    assert_eq!(
        lines[0].entry_id.as_deref(),
        Some(entry_id(AGENT, "k").as_str())
    );
    assert_eq!((lines[0].size_delta, lines[0].total_size), (-2, 0));
    assert!(
        serde_json::to_value(&lines[0])
            .unwrap()
            .get("key")
            .is_none(),
        "audit lines carry no key"
    );
}

#[test]
fn every_operation_purges_expired_entries_first() {
    // An expired entry is gone for a query, a delete, an export, an import's
    // clash check and a deployer delete alike.
    let (s, _, now) = store_at();
    s.create_memory(AGENT, 4096).unwrap();
    let day = Some(Some(retention(Some(1))));
    for key in ["a", "b"] {
        s.write(AGENT, &a(), key, b"v", MemoryCategory::Context, None, day)
            .unwrap();
    }
    now.store(T0 + DAY_MS + 1000, Ordering::SeqCst);
    assert_eq!(
        s.delete(AGENT, &a(), "a").unwrap_err().code(),
        "MEMORY_NOT_FOUND"
    );
    assert!(s.export(AGENT, true).unwrap().entries.is_empty());
    assert_eq!(
        s.admin_delete(AGENT, AdminDelete::Key("b"))
            .unwrap_err()
            .code(),
        "MEMORY_NOT_FOUND"
    );
}

#[test]
fn a_write_to_an_expired_key_is_a_fresh_create() {
    // The expired entry is purged before the write looks: no write-scope
    // check against its old creator, and the writer becomes the creator.
    let (s, _, now) = store_at();
    s.write(
        AGENT,
        &a(),
        "k",
        b"old",
        MemoryCategory::Context,
        None,
        Some(Some(retention(Some(1)))),
    )
    .unwrap();
    now.store(T0 + DAY_MS + 1000, Ordering::SeqCst);
    let w = s
        .write(
            AGENT,
            &other(),
            "k",
            b"new",
            MemoryCategory::Context,
            None,
            None,
        )
        .unwrap();
    assert_eq!(w.created_by, "v2:gene-b");
    assert_eq!(w.created_at, T0 + DAY_MS + 1000);
    assert_eq!(w.retention_policy, None);
}

#[test]
fn expired_entries_free_their_quota_for_the_next_write() {
    // PREFERENCE is never evicted, so without the purge this write could
    // not fit: the expired entry would still hold 61 of 64 bytes.
    let (s, _, now) = store_at();
    s.create_memory(AGENT, 64).unwrap();
    s.write(
        AGENT,
        &a(),
        "p",
        &[1; 60],
        MemoryCategory::Preference,
        None,
        Some(Some(retention(Some(1)))),
    )
    .unwrap();
    now.store(T0 + DAY_MS + 1000, Ordering::SeqCst);
    s.write(
        AGENT,
        &a(),
        "q",
        &[2; 60],
        MemoryCategory::Preference,
        None,
        None,
    )
    .unwrap();
    assert_eq!(keys(&s), ["q"]);
}

#[test]
fn a_purge_whose_audit_line_cannot_be_written_keeps_the_entry() {
    // The purge is a state change like any other: no
    // audit line, no delete — and the call that triggered it fails.
    let (log, sink) = BlockableLog::new();
    let now = Arc::new(AtomicI64::new(T0));
    let clock = now.clone();
    let s = MemoryStore::in_memory(sink)
        .unwrap()
        .with_clock(move || clock.load(Ordering::SeqCst));
    s.write(
        AGENT,
        &a(),
        "k",
        b"v",
        MemoryCategory::Context,
        None,
        Some(Some(retention(Some(1)))),
    )
    .unwrap();
    now.store(T0 + DAY_MS + 1000, Ordering::SeqCst);
    log.block();
    assert_eq!(
        s.read(AGENT, &a(), "k", None).unwrap_err().code(),
        "MEMORY_STORAGE_ERROR"
    );
    log.unblock();
    assert!(s.read(AGENT, &a(), "k", None).unwrap().is_none());
}

#[test]
fn an_entry_without_its_own_retention_inherits_the_agents_data_policy() {
    let (s, sink, now) = store_at();
    s.create_memory(AGENT, 4096).unwrap();
    let write = |key: &str, retention: Option<RetentionPolicy>| {
        s.write(
            AGENT,
            &a(),
            key,
            b"v",
            MemoryCategory::Context,
            None,
            Some(retention),
        )
        .unwrap();
    };
    // The default DataPolicy keeps data indefinitely: nothing expires.
    write("inherits", None);
    now.store(T0 + 3650 * DAY_MS, Ordering::SeqCst);
    assert_eq!(keys(&s), ["inherits"]);

    // The agent's DataPolicy now keeps one day. An entry with no policy of
    // its own follows it; an entry with its own policy keeps its own, an
    // explicit unlimited one included.
    s.set_retention_days(AGENT, Some(1)).unwrap();
    assert_eq!(
        sink.audits.lock().unwrap().last().unwrap().action,
        MemoryAction::RetentionChanged
    );
    let t = now.load(Ordering::SeqCst);
    write("own-unlimited", Some(retention(None)));
    write("own-30-days", Some(retention(Some(30))));
    now.store(t + 2 * DAY_MS, Ordering::SeqCst);
    let mut left = keys(&s);
    left.sort();
    assert_eq!(
        left,
        ["own-30-days", "own-unlimited"],
        "the inheriting entry expired"
    );

    s.set_retention_days(AGENT, None).unwrap();
    for bad in [Some(0), Some(i32::MAX as u32 + 1)] {
        assert_eq!(
            s.set_retention_days(AGENT, bad).unwrap_err().code(),
            "MEMORY_INVALID_INPUT"
        );
    }
    assert_eq!(
        s.set_retention_days("nobody", Some(1)).unwrap_err().code(),
        "MEMORY_NOT_FOUND"
    );
}

#[test]
fn a_database_from_before_retention_gains_the_column() {
    // playground.db files made by earlier builds of this branch have no
    // agent_memories.retention_days; opening one adds it (null: unlimited).
    let dir = std::env::temp_dir().join(format!("rotifer-mem-oldschema-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let db = dir.join("playground.db");
    rusqlite::Connection::open(&db)
        .unwrap()
        .execute_batch(
            "CREATE TABLE agent_memories (agent_id TEXT PRIMARY KEY, \
             quota INTEGER NOT NULL CHECK (quota > 0), created_at INTEGER NOT NULL); \
             INSERT INTO agent_memories VALUES ('agent-1', 4096, 0);",
        )
        .unwrap();
    let s = MemoryStore::open(&db, Arc::new(RecordingSink::default())).unwrap();
    s.write(AGENT, &a(), "k", b"v", MemoryCategory::Context, None, None)
        .unwrap();
    s.set_retention_days(AGENT, Some(7)).unwrap();
    assert_eq!(s.get_memory(AGENT).unwrap().entries.len(), 1);
    drop(s);
    // Opening it again finds the column and leaves it be.
    MemoryStore::open(&db, Arc::new(RecordingSink::default())).unwrap();
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn the_longest_retention_expires_exactly_on_its_day() {
    // Boundary, the same in every binding: maxRetentionDays at
    // its largest, 2147483647, compared as (now − updatedAt) >= days × 86400 s.
    let (s, sink, now) = store_at();
    s.write(
        AGENT,
        &a(),
        "k",
        b"v",
        MemoryCategory::Context,
        None,
        Some(Some(retention(Some(i32::MAX as u32)))),
    )
    .unwrap();
    let span = i32::MAX as i64 * DAY_MS;
    now.store(T0 + span - 1, Ordering::SeqCst);
    assert!(s.read(AGENT, &a(), "k", None).unwrap().is_some());
    now.store(T0 + span, Ordering::SeqCst);
    assert!(s.read(AGENT, &a(), "k", None).unwrap().is_none());
    assert_eq!(expired_lines(&sink).len(), 1);
}

#[test]
fn a_refused_call_still_keeps_its_purge_and_its_expired_lines() {
    // The purge does not depend on the caller's permissions.
    // A call that is then refused — a denied read, a denied delete, a write
    // over quota — has already purged, and that purge is committed and
    // audited, before the refusal's own line.
    let refusals: Vec<(&str, Box<dyn Fn(&MemoryStore) -> MemoryError>)> = vec![
        (
            "denied read",
            Box::new(|s| s.read(AGENT, &other(), "kept", None).unwrap_err()),
        ),
        (
            "denied delete",
            Box::new(|s| s.delete(AGENT, &other(), "kept").unwrap_err()),
        ),
        (
            "write over quota",
            Box::new(|s| {
                s.write(
                    AGENT,
                    &a(),
                    "big",
                    &[0; 260],
                    MemoryCategory::Preference,
                    None,
                    None,
                )
                .unwrap_err()
            }),
        ),
    ];
    for (what, refuse) in refusals {
        let (s, sink, now) = store_at();
        s.create_memory(AGENT, 256).unwrap();
        s.write(
            AGENT,
            &a(),
            "kept",
            b"v",
            MemoryCategory::Preference,
            None,
            None,
        )
        .unwrap();
        s.write(
            AGENT,
            &a(),
            "old",
            b"v",
            MemoryCategory::Context,
            None,
            Some(Some(retention(Some(1)))),
        )
        .unwrap();
        now.store(T0 + DAY_MS, Ordering::SeqCst);

        let err = refuse(&s);
        assert_ne!(err.code(), "MEMORY_STORAGE_ERROR", "{what}");
        assert_eq!(keys(&s), ["kept"], "{what}: the purge was rolled back");
        let audits = sink.audits.lock().unwrap();
        let expired = audits
            .iter()
            .position(|e| e.action == MemoryAction::Expired)
            .unwrap_or_else(|| panic!("{what}: no expired line"));
        let refusal = audits
            .iter()
            .position(|e| e.error.is_some())
            .unwrap_or_else(|| panic!("{what}: no refusal line"));
        assert!(expired < refusal, "{what}: the expired line comes first");
        assert_eq!(
            audits
                .iter()
                .filter(|e| e.action == MemoryAction::Expired)
                .count(),
            1,
            "{what}"
        );
    }
}
