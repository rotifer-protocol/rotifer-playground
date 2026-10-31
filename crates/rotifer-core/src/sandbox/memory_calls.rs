//! The bodies of the `rotifer.readMemory / writeMemory / queryMemory /
//! deleteMemory` host functions, without the wasmtime glue.
//!
//! ABI, the same convention as `rotifer.net` / `rotifer.kv`:
//! `(req_ptr, req_len, out_ptr, out_cap) -> i32`. The request and the
//! response are the AgentMemory wire JSON. A result ≥ 0 is the number of response
//! bytes written to `out`; a negative result is an error code, and if the
//! buffer has room `out` carries the ADR-334 envelope
//! `{"__rotifer_error":{"code":"MEMORY_…","message":"MEMORY_…: …"}}`, which a
//! gene can return as-is to refuse (the sandbox turns it into INVALID_INPUT).
//!
//! | call          | request                                                         | response            |
//! |---------------|-----------------------------------------------------------------|---------------------|
//! | `readMemory`  | `{key, category?}`                                              | MemoryEntry or `null` |
//! | `writeMemory` | `{key, value (base64), category, accessPolicy?, retentionPolicy?}` | MemoryEntry       |
//! | `queryMemory` | MemoryFilter, or empty for none                                  | `[MemoryEntry]`     |
//! | `deleteMemory`| `{key}`                                                         | nothing (0 bytes)   |
//!
//! `writeMemory` checks `out_cap` before it writes: a write is never applied
//! when its response would not fit.
//!
//! Codes: -1 buffer too small, -2 MEMORY_ACCESS_DENIED (also "no agent
//! context"), -8 MEMORY_QUOTA_EXCEEDED, -10 MEMORY_INVALID_INPUT, -12
//! MEMORY_NOT_FOUND, -13 MEMORY_STORAGE_ERROR. The wasmtime glue adds -4
//! (no envelope) when the run's deadline, host budget or fuel cannot cover
//! the call; each call costs [`MEMORY_CALL_FUEL`].

use std::sync::Arc;

use serde::Deserialize;

use super::hybrid::errors::{
    ERR_BUFFER_TOO_SMALL, ERR_INVALID_REQUEST, ERR_PERMISSION_DENIED, ERR_QUOTA_EXCEEDED,
};
use crate::memory::types::base64_bytes;
use crate::memory::{
    CallerGene, MemoryAccessPolicy, MemoryCategory, MemoryEntry, MemoryError, MemoryFilter,
    MemoryStore, RetentionPolicy, entry_id,
};

/// MEMORY_NOT_FOUND (new in the hybrid code table).
pub const ERR_MEMORY_NOT_FOUND: i32 = -12;

/// MEMORY_STORAGE_ERROR: the store itself failed — a
/// database or IO error. Never folded into -10, which blames the request.
pub const ERR_MEMORY_STORAGE: i32 = -13;

/// Fuel each memory call takes from the run's wasmtime fuel, whatever it
/// does. ADR-327 D4 prices a storage op at ≈1 ms of guest
/// compute (≈9.5e9 fuel per wall-second); measured on a disk-backed store
/// (release build, 2026-10-30), a write takes ≈0.6 ms and a read ≈0.36 ms,
/// so 1e7 is not cheaper than the host work it stands for. At the CLI's 5e8
/// starting rung that is at most 50 calls per run.
pub const MEMORY_CALL_FUEL: u64 = 10_000_000;

/// The largest request a memory call reads from the guest. Checked before
/// anything is copied, so a guest cannot make the host allocate an arbitrary
/// `req_len`. 4 MiB holds the largest valid request: a 1 MiB
/// value is about 1.4 MiB once base64-encoded.
pub const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;

/// Room the response of a write may need beyond the provisional entry:
/// another gene's id as creator, a `lastAccessedBy`, a kept retentionPolicy
/// (under 100 bytes in its §30.2 shape).
const WRITE_RESPONSE_MARGIN: usize = 256;

/// What a run's memory calls act on.
/// - `agent_id` is None when the gene runs outside an agent: every call is
///   denied ("no agent context") and recorded as telemetry only.
/// - `caller` is None when the running gene has no content-derived id: every
///   call is denied, because `createdBy` must be one, and the
///   denial is audited in the agent's log with telemetry.
#[derive(Clone)]
pub struct MemoryLink {
    pub store: Arc<MemoryStore>,
    pub agent_id: Option<String>,
    pub caller: Option<CallerGene>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryOp {
    Read,
    Write,
    Query,
    Delete,
}

impl MemoryOp {
    /// The operation name in audit and telemetry lines.
    pub fn operation(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Query => "query",
            Self::Delete => "delete",
        }
    }

    pub fn host_name(self) -> &'static str {
        match self {
            Self::Read => "readMemory",
            Self::Write => "writeMemory",
            Self::Query => "queryMemory",
            Self::Delete => "deleteMemory",
        }
    }
}

/// The result of one call: bytes for `out`, and the return code.
#[derive(Debug, PartialEq, Eq)]
pub struct CallResult {
    pub code: i32,
    pub out: Vec<u8>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadRequest {
    key: String,
    #[serde(default)]
    category: Option<MemoryCategory>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteRequest {
    key: String,
    #[serde(with = "base64_bytes")]
    value: Vec<u8>,
    category: MemoryCategory,
    #[serde(default)]
    access_policy: Option<MemoryAccessPolicy>,
    /// Absent keeps the stored policy; null resets it to inherit.
    #[serde(default, deserialize_with = "present")]
    retention_policy: Option<Option<RetentionPolicy>>,
}

/// A field that is present — even as null — is `Some`; `default` makes an
/// absent one `None`.
fn present<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteRequest {
    key: String,
}

/// The host return code for a memory error.
pub fn error_code(err: &MemoryError) -> i32 {
    match err {
        MemoryError::AccessDenied(_) => ERR_PERMISSION_DENIED,
        MemoryError::QuotaExceeded(_) => ERR_QUOTA_EXCEEDED,
        MemoryError::NotFound(_) => ERR_MEMORY_NOT_FOUND,
        MemoryError::InvalidInput(_) => ERR_INVALID_REQUEST,
        MemoryError::Storage(_) => ERR_MEMORY_STORAGE,
    }
}

fn envelope(err: &MemoryError) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "__rotifer_error": { "code": err.code(), "message": err.to_string() }
    }))
    .unwrap_or_default()
}

fn fail(err: MemoryError, out_cap: usize) -> CallResult {
    let env = envelope(&err);
    CallResult {
        code: error_code(&err),
        out: if env.len() <= out_cap {
            env
        } else {
            Vec::new()
        },
    }
}

fn respond<T: serde::Serialize>(value: &T, out_cap: usize) -> CallResult {
    match serde_json::to_vec(value) {
        Ok(bytes) if bytes.len() <= out_cap => CallResult {
            code: bytes.len() as i32,
            out: bytes,
        },
        Ok(_) => CallResult {
            code: ERR_BUFFER_TOO_SMALL,
            out: Vec::new(),
        },
        Err(e) => fail(MemoryError::Storage(e.to_string()), out_cap),
    }
}

fn parse<'a, T: Deserialize<'a>>(op: MemoryOp, request: &'a [u8]) -> Result<T, MemoryError> {
    serde_json::from_slice(request).map_err(|e| {
        MemoryError::InvalidInput(format!("{} request is not valid: {e}", op.host_name()))
    })
}

/// Run one memory host call.
pub fn handle(
    link: Option<&MemoryLink>,
    op: MemoryOp,
    request: &[u8],
    out_cap: usize,
) -> CallResult {
    const NO_AGENT: &str =
        "no agent context: the gene is not running as part of an agent, so it has no AgentMemory";
    // No store attached at all (a sandbox without memory wiring): there is
    // nowhere to record the denial.
    let Some(link) = link else {
        return fail(MemoryError::AccessDenied(NO_AGENT.into()), out_cap);
    };
    let store = &link.store;
    let Some(agent) = link.agent_id.as_deref() else {
        let gene = link.caller.as_ref().map(|c| c.gene_id.as_str());
        return fail(
            store.deny_without_agent(gene, op.operation(), NO_AGENT.into()),
            out_cap,
        );
    };
    let Some(caller) = &link.caller else {
        // The entry the call named, when it named a key, so the audit line
        // says what was asked for.
        let entry = serde_json::from_slice::<serde_json::Value>(request)
            .ok()
            .and_then(|v| v.get("key")?.as_str().map(|k| entry_id(agent, k)))
            .filter(|_| op != MemoryOp::Query);
        return fail(
            store.deny_unidentified(
                agent,
                entry.as_deref(),
                op.operation(),
                "this gene has no content-derived id, which memory entries record as their creator"
                    .into(),
            ),
            out_cap,
        );
    };

    match op {
        MemoryOp::Read => match parse::<ReadRequest>(op, request)
            .and_then(|r| store.read(agent, caller, &r.key, r.category))
        {
            Ok(entry) => respond(&entry, out_cap),
            Err(e) => fail(e, out_cap),
        },
        MemoryOp::Write => {
            let req = match parse::<WriteRequest>(op, request) {
                Ok(r) => r,
                Err(e) => return fail(e, out_cap),
            };
            let provisional = MemoryEntry {
                entry_id: entry_id(agent, &req.key),
                category: req.category,
                key: req.key.clone(),
                value: req.value.clone(),
                created_by: caller.gene_id.clone(),
                last_accessed_by: None,
                created_at: 0,
                updated_at: 0,
                access_policy: req.access_policy.unwrap_or_default(),
                retention_policy: req.retention_policy.flatten(),
            };
            let needed = serde_json::to_vec(&provisional).map_or(usize::MAX, |b| b.len())
                + WRITE_RESPONSE_MARGIN;
            if needed > out_cap {
                return CallResult {
                    code: ERR_BUFFER_TOO_SMALL,
                    out: Vec::new(),
                };
            }
            match store.write(
                agent,
                caller,
                &req.key,
                &req.value,
                req.category,
                req.access_policy,
                req.retention_policy,
            ) {
                Ok(entry) => respond(&entry, out_cap),
                Err(e) => fail(e, out_cap),
            }
        }
        // The filter is optional: an empty request is no filter.
        MemoryOp::Query => match (if request.iter().all(u8::is_ascii_whitespace) {
            Ok(MemoryFilter::default())
        } else {
            parse::<MemoryFilter>(op, request)
        })
        .and_then(|f| store.query(agent, caller, &f))
        {
            Ok(entries) => respond(&entries, out_cap),
            Err(e) => fail(e, out_cap),
        },
        MemoryOp::Delete => match parse::<DeleteRequest>(op, request)
            .and_then(|r| store.delete(agent, caller, &r.key))
        {
            Ok(()) => CallResult {
                code: 0,
                out: Vec::new(),
            },
            Err(e) => fail(e, out_cap),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::NullSink;

    fn link(domain: &str, id: &str) -> MemoryLink {
        MemoryLink {
            store: Arc::new(MemoryStore::in_memory(Arc::new(NullSink)).unwrap()),
            agent_id: Some("agent-1".into()),
            caller: Some(CallerGene {
                gene_id: id.into(),
                domain: domain.into(),
            }),
        }
    }

    fn json(r: &CallResult) -> serde_json::Value {
        serde_json::from_slice(&r.out).unwrap()
    }

    const WRITE: &[u8] = br#"{"key":"lang","value":"emgtQ04=","category":"PREFERENCE"}"#;

    #[test]
    fn write_then_read_returns_the_entry_in_wire_shape() {
        let l = link("text.x", "v2:a");
        let w = handle(Some(&l), MemoryOp::Write, WRITE, 4096);
        assert!(w.code > 0, "{w:?}");
        assert_eq!(w.code as usize, w.out.len());
        assert_eq!(json(&w)["createdBy"], "v2:a");

        let r = handle(Some(&l), MemoryOp::Read, br#"{"key":"lang"}"#, 4096);
        let v = json(&r);
        assert_eq!(v["value"], "emgtQ04=");
        assert_eq!(v["category"], "PREFERENCE");
        assert_eq!(v["accessPolicy"]["readScope"], "SAME_DOMAIN");
    }

    #[test]
    fn a_missing_key_reads_as_null_and_deletes_as_not_found() {
        let l = link("text.x", "v2:a");
        let r = handle(Some(&l), MemoryOp::Read, br#"{"key":"nope"}"#, 64);
        assert_eq!((r.code, r.out.as_slice()), (4, b"null".as_slice()));
        let d = handle(Some(&l), MemoryOp::Delete, br#"{"key":"nope"}"#, 512);
        assert_eq!(d.code, ERR_MEMORY_NOT_FOUND);
        assert_eq!(json(&d)["__rotifer_error"]["code"], "MEMORY_NOT_FOUND");
    }

    #[test]
    fn delete_returns_zero_bytes() {
        let l = link("text.x", "v2:a");
        handle(Some(&l), MemoryOp::Write, WRITE, 4096);
        let d = handle(Some(&l), MemoryOp::Delete, br#"{"key":"lang"}"#, 512);
        assert_eq!(
            d,
            CallResult {
                code: 0,
                out: Vec::new()
            }
        );
    }

    #[test]
    fn a_denial_is_minus_two_with_the_envelope() {
        let writer = link("text.x", "v2:a");
        handle(Some(&writer), MemoryOp::Write, WRITE, 4096);
        let reader = MemoryLink {
            caller: Some(CallerGene {
                gene_id: "v2:b".into(),
                domain: "search.web".into(),
            }),
            ..writer.clone()
        };
        let r = handle(Some(&reader), MemoryOp::Read, br#"{"key":"lang"}"#, 1024);
        assert_eq!(r.code, ERR_PERMISSION_DENIED);
        let env = json(&r);
        assert_eq!(env["__rotifer_error"]["code"], "MEMORY_ACCESS_DENIED");
        assert!(
            env["__rotifer_error"]["message"]
                .as_str()
                .unwrap()
                .starts_with("MEMORY_ACCESS_DENIED: ")
        );
    }

    #[test]
    fn quota_is_minus_eight() {
        let l = link("text.x", "v2:a");
        l.store.create_memory("agent-1", 8).unwrap();
        let r = handle(Some(&l), MemoryOp::Write, WRITE, 4096);
        assert_eq!(r.code, ERR_QUOTA_EXCEEDED);
        assert_eq!(json(&r)["__rotifer_error"]["code"], "MEMORY_QUOTA_EXCEEDED");
    }

    #[test]
    fn bad_requests_are_minus_ten() {
        let l = link("text.x", "v2:a");
        for (op, req) in [
            (MemoryOp::Read, b"not json".as_slice()),
            (
                MemoryOp::Write,
                br#"{"key":"k","value":"!!","category":"CACHE"}"#.as_slice(),
            ),
            (
                MemoryOp::Write,
                br#"{"key":"k","value":"","category":"cache"}"#.as_slice(),
            ),
            (MemoryOp::Query, br#"{"unknown":1}"#.as_slice()),
            (MemoryOp::Delete, br#"{"key":""}"#.as_slice()),
        ] {
            let r = handle(Some(&l), op, req, 1024);
            assert_eq!(
                r.code,
                ERR_INVALID_REQUEST,
                "{op:?} {}",
                String::from_utf8_lossy(req)
            );
            assert_eq!(json(&r)["__rotifer_error"]["code"], "MEMORY_INVALID_INPUT");
        }
    }

    #[test]
    fn a_response_that_does_not_fit_is_minus_one_and_a_write_is_not_applied() {
        let l = link("text.x", "v2:a");
        let w = handle(Some(&l), MemoryOp::Write, WRITE, 64);
        assert_eq!(
            w,
            CallResult {
                code: ERR_BUFFER_TOO_SMALL,
                out: Vec::new()
            }
        );
        assert!(
            l.store.get_memory("agent-1").is_err(),
            "the write was applied anyway"
        );

        handle(Some(&l), MemoryOp::Write, WRITE, 4096);
        let r = handle(Some(&l), MemoryOp::Read, br#"{"key":"lang"}"#, 16);
        assert_eq!(r.code, ERR_BUFFER_TOO_SMALL);
    }

    #[test]
    fn an_envelope_that_does_not_fit_leaves_out_empty() {
        let l = link("text.x", "v2:a");
        let d = handle(Some(&l), MemoryOp::Delete, br#"{"key":"nope"}"#, 8);
        assert_eq!(
            d,
            CallResult {
                code: ERR_MEMORY_NOT_FOUND,
                out: Vec::new()
            }
        );
    }

    #[test]
    fn an_empty_query_request_is_no_filter() {
        let l = link("text.x", "v2:a");
        handle(Some(&l), MemoryOp::Write, WRITE, 4096);
        let q = handle(Some(&l), MemoryOp::Query, b"", 4096);
        assert_eq!(json(&q).as_array().unwrap().len(), 1);
    }

    #[test]
    fn the_host_call_holds_the_one_mib_value_line() {
        use base64::Engine as _;
        let l = link("text.x", "v2:a");
        let req = |n: usize| {
            format!(
                r#"{{"key":"v","value":"{}","category":"CACHE"}}"#,
                base64::engine::general_purpose::STANDARD.encode(vec![3u8; n])
            )
        };
        let at = handle(
            Some(&l),
            MemoryOp::Write,
            req(crate::memory::types::MAX_VALUE_BYTES).as_bytes(),
            4 << 20,
        );
        assert!(
            at.code > 0,
            "{:?}",
            String::from_utf8_lossy(&at.out[..at.out.len().min(200)])
        );
        let over = handle(
            Some(&l),
            MemoryOp::Write,
            req(crate::memory::types::MAX_VALUE_BYTES + 1).as_bytes(),
            4 << 20,
        );
        assert_eq!(over.code, ERR_INVALID_REQUEST);
        assert_eq!(
            json(&over)["__rotifer_error"]["code"],
            "MEMORY_INVALID_INPUT"
        );
    }

    #[test]
    fn query_returns_an_array() {
        let l = link("text.x", "v2:a");
        handle(Some(&l), MemoryOp::Write, WRITE, 4096);
        let q = handle(
            Some(&l),
            MemoryOp::Query,
            br#"{"category":"PREFERENCE"}"#,
            4096,
        );
        assert_eq!(json(&q).as_array().unwrap().len(), 1);
        let none = handle(Some(&l), MemoryOp::Query, br#"{"category":"CACHE"}"#, 4096);
        assert_eq!(none.out, b"[]");
    }

    #[test]
    fn without_an_agent_or_a_gene_id_every_call_is_denied() {
        // No agent context is -2 / MEMORY_ACCESS_DENIED for all
        // four calls, never "not found" and never a silent no-op.
        for (op, req) in [
            (MemoryOp::Read, br#"{"key":"k"}"#.as_slice()),
            (MemoryOp::Write, WRITE),
            (MemoryOp::Query, b"{}".as_slice()),
            (MemoryOp::Delete, br#"{"key":"k"}"#.as_slice()),
        ] {
            let r = handle(None, op, req, 1024);
            assert_eq!(r.code, ERR_PERMISSION_DENIED, "{op:?}");
            let env = json(&r);
            assert_eq!(env["__rotifer_error"]["code"], "MEMORY_ACCESS_DENIED");
            assert!(
                env["__rotifer_error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("no agent context"),
                "{op:?}"
            );
        }

        let anonymous = MemoryLink {
            caller: None,
            ..link("text.x", "v2:a")
        };
        let w = handle(Some(&anonymous), MemoryOp::Write, WRITE, 4096);
        assert_eq!(w.code, ERR_PERMISSION_DENIED);
        assert!(anonymous.store.get_memory("agent-1").is_err());
    }

    #[test]
    fn a_storage_failure_is_minus_thirteen_never_invalid_input() {
        // A broken store is MEMORY_STORAGE_ERROR (-13); -10
        // would tell the gene its request was wrong.
        let dir = std::env::temp_dir().join(format!("rotifer-mem-broken-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("playground.db");
        let l = MemoryLink {
            store: Arc::new(MemoryStore::open(&db, Arc::new(NullSink)).unwrap()),
            ..link("text.x", "v2:a")
        };
        rusqlite::Connection::open(&db)
            .unwrap()
            .execute_batch("DROP TABLE agent_memory_entries")
            .unwrap();
        for (op, req) in [
            (MemoryOp::Write, WRITE),
            (MemoryOp::Read, br#"{"key":"lang"}"#.as_slice()),
            (MemoryOp::Query, b"{}".as_slice()),
            (MemoryOp::Delete, br#"{"key":"lang"}"#.as_slice()),
        ] {
            let r = handle(Some(&l), op, req, 4096);
            assert_eq!(r.code, ERR_MEMORY_STORAGE, "{op:?}");
            assert_eq!(
                json(&r)["__rotifer_error"]["code"],
                "MEMORY_STORAGE_ERROR",
                "{op:?}"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_identity_denial_inside_an_agent_is_audited_and_recorded() {
        // A violation is audit + telemetry. A gene without a
        // usable v2 id (e.g. a gene directory with an extra package.json)
        // still runs inside an agent, so the denial belongs to that agent.
        let sink = Arc::new(crate::memory::RecordingSink::default());
        let l = MemoryLink {
            caller: None,
            store: Arc::new(MemoryStore::in_memory(sink.clone()).unwrap()),
            ..link("text.x", "v2:a")
        };
        let lang = Some(entry_id("agent-1", "lang"));
        let cases = [
            (MemoryOp::Write, WRITE, "write", lang.clone()),
            (
                MemoryOp::Read,
                br#"{"key":"lang"}"#.as_slice(),
                "read",
                lang.clone(),
            ),
            (MemoryOp::Query, b"{}".as_slice(), "query", None),
            (
                MemoryOp::Delete,
                br#"{"key":"lang"}"#.as_slice(),
                "delete",
                lang,
            ),
        ];
        for (op, req, _, _) in &cases {
            let r = handle(Some(&l), *op, req, 1024);
            assert_eq!(r.code, ERR_PERMISSION_DENIED, "{op:?}");
        }
        let audits = sink.audits.lock().unwrap();
        let telemetry = sink.telemetry.lock().unwrap();
        assert_eq!((audits.len(), telemetry.len()), (4, 4));
        for (((_, _, operation, entry), audit), event) in
            cases.iter().zip(audits.iter()).zip(telemetry.iter())
        {
            assert_eq!(
                audit.action,
                crate::memory::events::MemoryAction::AccessDenied
            );
            assert_eq!(audit.agent_id, "agent-1");
            assert_eq!(audit.gene_id, None);
            assert_eq!(&audit.entry_id, entry, "{operation}");
            assert_eq!(audit.error, Some("MEMORY_ACCESS_DENIED"));
            assert_eq!(event.gene_id, None);
            assert_eq!(event.metadata["agentId"], "agent-1");
            assert_eq!(event.metadata["operation"], *operation);
        }
        assert!(
            l.store.get_memory("agent-1").is_err(),
            "a denied write created memory"
        );
    }

    #[test]
    fn no_agent_context_is_recorded_as_telemetry_only() {
        // There is no agent to attribute an audit line to, so a call from a
        // gene outside any agent is telemetry only — and is still denied.
        let sink = Arc::new(crate::memory::RecordingSink::default());
        let l = MemoryLink {
            agent_id: None,
            store: Arc::new(MemoryStore::in_memory(sink.clone()).unwrap()),
            ..link("text.x", "v2:a")
        };
        for op in [
            MemoryOp::Read,
            MemoryOp::Write,
            MemoryOp::Query,
            MemoryOp::Delete,
        ] {
            let req: &[u8] = if op == MemoryOp::Write {
                WRITE
            } else {
                br#"{"key":"lang"}"#
            };
            let r = handle(Some(&l), op, req, 1024);
            assert_eq!(r.code, ERR_PERMISSION_DENIED, "{op:?}");
            assert!(
                json(&r)["__rotifer_error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("no agent context"),
                "{op:?}"
            );
        }
        assert!(sink.audits.lock().unwrap().is_empty());
        let telemetry = sink.telemetry.lock().unwrap();
        assert_eq!(telemetry.len(), 4);
        for (event, operation) in telemetry.iter().zip(["read", "write", "query", "delete"]) {
            assert_eq!(event.gene_id.as_deref(), Some("v2:a"));
            assert!(event.metadata["agentId"].is_null());
            assert!(event.metadata["entryId"].is_null());
            assert_eq!(event.metadata["operation"], operation);
        }
    }

    #[test]
    fn an_expired_entry_is_gone_for_a_gene_too() {
        // Through the host call: a gene reads null, finds
        // nothing in a query, and its write starts a fresh entry.
        use std::sync::atomic::{AtomicI64, Ordering};
        let now = Arc::new(AtomicI64::new(1_761_800_000_000));
        let clock = now.clone();
        let l = MemoryLink {
            store: Arc::new(
                MemoryStore::in_memory(Arc::new(NullSink))
                    .unwrap()
                    .with_clock(move || clock.load(Ordering::SeqCst)),
            ),
            ..link("text.x", "v2:a")
        };
        let day = r#"{"maxRetentionDays":1,"autoDeleteOnTermination":false,"anonymizationSupported":false}"#;
        assert!(write_with_retention(&l, "v2:a", day).code > 0);
        now.fetch_add(86_400_000, Ordering::SeqCst);
        let r = handle(Some(&l), MemoryOp::Read, br#"{"key":"k"}"#, 1024);
        assert_eq!((r.code, r.out.as_slice()), (4, b"null".as_slice()));
        assert_eq!(handle(Some(&l), MemoryOp::Query, b"", 1024).out, b"[]");
        let w = write_with_retention(&l, "v2:twin", "null");
        assert!(w.code > 0, "{}", String::from_utf8_lossy(&w.out));
        assert_eq!(json(&w)["createdBy"], "v2:twin");
    }

    fn write_with_retention(l: &MemoryLink, id: &str, retention: &str) -> CallResult {
        let req = format!(
            r#"{{"key":"k","value":"","category":"CONTEXT","retentionPolicy":{retention}}}"#
        );
        let caller = MemoryLink {
            caller: Some(CallerGene {
                gene_id: id.into(),
                domain: "text.x".into(),
            }),
            ..l.clone()
        };
        handle(Some(&caller), MemoryOp::Write, req.as_bytes(), 4096)
    }

    #[test]
    fn retention_policy_is_exactly_the_section_30_2_shape() {
        // Exactly {maxRetentionDays: 1..=i32::MAX | null,
        // autoDeleteOnTermination: bool, anonymizationSupported: bool}, or
        // null. Anything missing, extra or mistyped is -10.
        let l = link("text.x", "v2:a");
        let full = |days: &str| {
            format!(
                r#"{{"maxRetentionDays":{days},"autoDeleteOnTermination":true,"anonymizationSupported":false}}"#
            )
        };
        for ok in [
            full("30"),
            full("1"),
            full("2147483647"),
            full("null"),
            "null".to_string(),
        ] {
            let w = write_with_retention(&l, "v2:a", &ok);
            assert!(
                w.code > 0,
                "{ok} was refused: {}",
                String::from_utf8_lossy(&w.out)
            );
            let stored: serde_json::Value = serde_json::from_str(&ok).unwrap();
            assert_eq!(json(&w)["retentionPolicy"], stored, "{ok}");
        }
        let bad = [
            full("0"),
            full("-1"),
            full("2147483648"),
            full("1.5"),
            full("30.0"),
            full(r#""30""#),
            full("true"),
            r#"{"autoDeleteOnTermination":true,"anonymizationSupported":false}"#.to_string(),
            r#"{"maxRetentionDays":30,"anonymizationSupported":false}"#.to_string(),
            r#"{"maxRetentionDays":30,"autoDeleteOnTermination":true}"#.to_string(),
            r#"{"maxRetentionDays":30,"autoDeleteOnTermination":"true","anonymizationSupported":false}"#
                .to_string(),
            r#"{"maxRetentionDays":30,"autoDeleteOnTermination":true,"anonymizationSupported":null}"#
                .to_string(),
            r#"{"maxRetentionDays":30,"autoDeleteOnTermination":true,"anonymizationSupported":false,"note":"x"}"#
                .to_string(),
            "{}".to_string(),
            "[]".to_string(),
            "30".to_string(),
            r#""forever""#.to_string(),
        ];
        for b in bad {
            let w = write_with_retention(&l, "v2:a", &b);
            assert_eq!(w.code, ERR_INVALID_REQUEST, "{b} was accepted");
            assert_eq!(
                json(&w)["__rotifer_error"]["code"],
                "MEMORY_INVALID_INPUT",
                "{b}"
            );
        }
    }

    #[test]
    fn a_null_retention_resets_to_inherit_and_only_the_creator_may_send_it() {
        // Null = "inherit the agent's DataPolicy". Only the
        // creator may reset; anyone else sending null over a stored policy is
        // -2, not a silent no-op. Omitting the field keeps what is stored.
        let l = link("text.x", "v2:a");
        let r = r#"{"maxRetentionDays":30,"autoDeleteOnTermination":false,"anonymizationSupported":false}"#;
        assert!(write_with_retention(&l, "v2:a", r).code > 0);

        let denied = write_with_retention(&l, "v2:twin", "null");
        assert_eq!(denied.code, ERR_PERMISSION_DENIED);
        let kept = l.store.get_memory("agent-1").unwrap().entries[0].clone();
        assert!(
            kept.retention_policy.is_some(),
            "a refused null cleared the policy"
        );

        let twin = MemoryLink {
            caller: Some(CallerGene {
                gene_id: "v2:twin".into(),
                domain: "text.x".into(),
            }),
            ..l.clone()
        };
        let omitted = handle(
            Some(&twin),
            MemoryOp::Write,
            br#"{"key":"k","value":"AA==","category":"CONTEXT"}"#,
            4096,
        );
        assert!(omitted.code > 0);
        assert_eq!(json(&omitted)["retentionPolicy"]["maxRetentionDays"], 30);

        let reset = write_with_retention(&l, "v2:a", "null");
        assert!(reset.code > 0);
        assert!(json(&reset)["retentionPolicy"].is_null());
        assert!(
            l.store.get_memory("agent-1").unwrap().entries[0]
                .retention_policy
                .is_none()
        );

        // Restating null over a null is no change, so the twin may.
        assert!(write_with_retention(&l, "v2:twin", "null").code > 0);
    }
}
