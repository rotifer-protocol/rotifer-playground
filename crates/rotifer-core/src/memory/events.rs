//! What AgentMemory reports about itself.
//!
//! - Lifecycle events (ADR-271 D3): every state change — write,
//!   update, delete, eviction, quota rejection — and every access denial is
//!   one line in `.rotifer/audit.jsonl`, next to the L0 gate's lines.
//! - Telemetry (§17): an access denial is also a §17.3-shaped event in
//!   `.rotifer/telemetry.jsonl`. §17.3 has no memory event type, so
//!   `MEMORY_ACCESS_DENIED` is marked a binding extension. Local
//!   only; nothing here touches the network. Skipped when the user opted
//!   out of telemetry; audit lines are always written.
//!
//! Neither line carries a key or a value: memory can hold user data (§30),
//! and the audit log is not where it should leak. `entryId` identifies the
//! entry.

use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::types::{MemoryCategory, MemoryError, format_rfc3339_ms};

/// One AgentMemory lifecycle line in `.rotifer/audit.jsonl`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAuditEvent {
    pub ts: String,
    /// Always "agent_memory", so these lines are told apart from L0 lines.
    pub kind: &'static str,
    pub action: MemoryAction,
    pub agent_id: String,
    pub entry_id: Option<String>,
    pub category: Option<MemoryCategory>,
    /// The gene whose call caused it; None for the deployer / CLI.
    pub gene_id: Option<String>,
    /// Bytes added (positive) or freed (negative) by this event.
    pub size_delta: i64,
    /// AgentMemory total after the event.
    pub total_size: u64,
    pub quota: u64,
    /// Error code for a rejection or denial.
    pub error: Option<&'static str>,
    /// `"deployer"` on a deployer's delete; absent on
    /// every other line.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryAction {
    MemoryCreated,
    Write,
    Update,
    Delete,
    Evict,
    QuotaRejected,
    /// The deployer changed the quota.
    QuotaChanged,
    AccessDenied,
    Import,
    /// Its retention ran out.
    Expired,
    /// The agent's DataPolicy retention changed.
    RetentionChanged,
}

/// A §17.3 TelemetryEvent for a memory access denial.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryTelemetryEvent {
    pub event_type: &'static str,
    pub binding_extension: bool,
    pub trace_context: Option<serde_json::Value>,
    pub gene_id: Option<String>,
    pub timestamp: String,
    pub duration: Option<u64>,
    pub resource_usage: Option<serde_json::Value>,
    pub result: serde_json::Value,
    pub metadata: serde_json::Value,
}

impl MemoryTelemetryEvent {
    /// `gene_id` is None when the gene has no usable v2 id, `agent_id` when
    /// it runs outside an agent, `entry_id` when the call named no key.
    pub fn access_denied(
        now_ms: i64,
        gene_id: Option<&str>,
        agent_id: Option<&str>,
        entry_id: Option<&str>,
        operation: &str,
        err: &MemoryError,
    ) -> Self {
        Self {
            event_type: "MEMORY_ACCESS_DENIED",
            binding_extension: true,
            trace_context: None,
            gene_id: gene_id.map(str::to_string),
            timestamp: format_rfc3339_ms(now_ms),
            duration: None,
            resource_usage: None,
            result: serde_json::json!({
                "FAILURE": { "errorCode": err.code(), "message": err.message() }
            }),
            metadata: serde_json::json!({
                "agentId": agent_id,
                "entryId": entry_id,
                "operation": operation,
            }),
        }
    }
}

/// Where AgentMemory sends its events.
///
/// - `audit` is written before a state change commits; if it fails, the
///   change is rolled back and the call fails with MEMORY_STORAGE_ERROR.
///   No change goes unrecorded.
/// - `telemetry` is best-effort: a failure is logged, never raised.
pub trait MemoryEventSink: Send + Sync {
    fn audit(&self, event: &MemoryAuditEvent) -> std::io::Result<()>;
    fn telemetry(&self, event: &MemoryTelemetryEvent);
}

/// The CLI's environment opt-out (`telemetryOptedOutByEnv` in
/// src/telemetry/consent.ts), so one setting means the same everywhere
/// (ADR-329): DO_NOT_TRACK set to anything but `0`/`false`, or
/// ROTIFER_TELEMETRY `0`/`false`/`off`, any case, trimmed.
fn telemetry_opted_out(env: impl Fn(&str) -> Option<String>) -> bool {
    let read = |name| env(name).unwrap_or_default().trim().to_lowercase();
    let dnt = read("DO_NOT_TRACK");
    if !dnt.is_empty() && dnt != "0" && dnt != "false" {
        return true;
    }
    matches!(read("ROTIFER_TELEMETRY").as_str(), "0" | "false" | "off")
}

/// Appends JSON lines to `<dir>/audit.jsonl` and `<dir>/telemetry.jsonl`
/// (`dir` is normally the project's `.rotifer/`). Telemetry is skipped when
/// the user opted out; audit is always written.
pub struct JsonlSink {
    audit_path: PathBuf,
    telemetry_path: PathBuf,
    telemetry_on: bool,
}

impl JsonlSink {
    /// Reads the telemetry opt-out from the process environment.
    pub fn new(rotifer_dir: &Path) -> Self {
        Self::from_env(rotifer_dir, |name| std::env::var(name).ok())
    }

    /// As [`Self::new`], with the environment supplied by `env`.
    pub fn from_env(rotifer_dir: &Path, env: impl Fn(&str) -> Option<String>) -> Self {
        Self {
            audit_path: rotifer_dir.join("audit.jsonl"),
            telemetry_path: rotifer_dir.join("telemetry.jsonl"),
            telemetry_on: !telemetry_opted_out(env),
        }
    }

    fn append<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
        let line = serde_json::to_string(value).map_err(std::io::Error::other)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut f = options.open(path)?;
        // A file another writer created (the L0 audit log shares
        // audit.jsonl) is narrowed too.
        super::store::restrict_to_owner(path)?;
        writeln!(f, "{line}")
    }
}

impl MemoryEventSink for JsonlSink {
    fn audit(&self, event: &MemoryAuditEvent) -> std::io::Result<()> {
        Self::append(&self.audit_path, event)
    }

    fn telemetry(&self, event: &MemoryTelemetryEvent) {
        if !self.telemetry_on {
            return;
        }
        if let Err(e) = Self::append(&self.telemetry_path, event) {
            tracing::warn!("could not append to {}: {e}", self.telemetry_path.display());
        }
    }
}

/// Keeps events in memory; for tests and for callers that forward them.
#[derive(Default)]
pub struct RecordingSink {
    pub audits: Mutex<Vec<MemoryAuditEvent>>,
    pub telemetry: Mutex<Vec<MemoryTelemetryEvent>>,
}

impl MemoryEventSink for RecordingSink {
    fn audit(&self, event: &MemoryAuditEvent) -> std::io::Result<()> {
        self.audits.lock().unwrap().push(event.clone());
        Ok(())
    }

    fn telemetry(&self, event: &MemoryTelemetryEvent) {
        self.telemetry.lock().unwrap().push(event.clone());
    }
}

/// Discards events.
pub struct NullSink;

impl MemoryEventSink for NullSink {
    fn audit(&self, _event: &MemoryAuditEvent) -> std::io::Result<()> {
        Ok(())
    }
    fn telemetry(&self, _event: &MemoryTelemetryEvent) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audit_event() -> MemoryAuditEvent {
        MemoryAuditEvent {
            ts: format_rfc3339_ms(1_761_800_000_000),
            kind: "agent_memory",
            action: MemoryAction::Evict,
            agent_id: "agent-1".into(),
            entry_id: Some("ab".repeat(32)),
            category: Some(MemoryCategory::Cache),
            gene_id: Some("v2:aa".into()),
            size_delta: -12,
            total_size: 100,
            quota: 1000,
            error: None,
            actor: None,
        }
    }

    #[test]
    fn jsonl_sink_appends_one_line_per_event_to_each_file() {
        let dir = std::env::temp_dir().join(format!("rotifer-mem-sink-{}", uuid::Uuid::new_v4()));
        let sink = JsonlSink::from_env(&dir, |_| None);
        sink.audit(&audit_event()).unwrap();
        sink.audit(&audit_event()).unwrap();
        let denial = MemoryTelemetryEvent::access_denied(
            1_761_800_000_000,
            Some("v2:bb"),
            Some("agent-1"),
            Some("cd"),
            "read",
            &MemoryError::AccessDenied("no".into()),
        );
        sink.telemetry(&denial);

        let audit = std::fs::read_to_string(dir.join("audit.jsonl")).unwrap();
        assert_eq!(audit.lines().count(), 2);
        let line: serde_json::Value = serde_json::from_str(audit.lines().next().unwrap()).unwrap();
        assert_eq!(line["kind"], "agent_memory");
        assert_eq!(line["action"], "evict");
        assert_eq!(line["category"], "CACHE");
        assert_eq!(line["sizeDelta"], -12);

        let telemetry = std::fs::read_to_string(dir.join("telemetry.jsonl")).unwrap();
        let t: serde_json::Value = serde_json::from_str(telemetry.trim()).unwrap();
        assert_eq!(t["eventType"], "MEMORY_ACCESS_DENIED");
        assert_eq!(t["bindingExtension"], true);
        assert_eq!(t["result"]["FAILURE"]["errorCode"], "MEMORY_ACCESS_DENIED");
        assert_eq!(t["metadata"]["operation"], "read");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn telemetry_follows_the_cli_opt_out_and_audit_is_always_written() {
        // With the CLI's rule (src/telemetry/consent.ts):
        // DO_NOT_TRACK set to anything but 0/false, or ROTIFER_TELEMETRY
        // 0/false/off (any case, trimmed), turns telemetry off.
        let denial = MemoryTelemetryEvent::access_denied(
            0,
            Some("v2:aa"),
            Some("agent-1"),
            Some("ab"),
            "read",
            &MemoryError::AccessDenied("no".into()),
        );
        let cases: [(&[(&str, &str)], bool); 9] = [
            (&[], true),
            (&[("ROTIFER_TELEMETRY", "0")], false),
            (&[("ROTIFER_TELEMETRY", " OFF ")], false),
            (&[("ROTIFER_TELEMETRY", "false")], false),
            (&[("ROTIFER_TELEMETRY", "1")], true),
            (&[("DO_NOT_TRACK", "1")], false),
            (&[("DO_NOT_TRACK", "0")], true),
            (
                &[("DO_NOT_TRACK", "false"), ("ROTIFER_TELEMETRY", "0")],
                false,
            ),
            (&[("DO_NOT_TRACK", "1"), ("ROTIFER_TELEMETRY", "1")], false),
        ];
        for (vars, on) in cases {
            let dir =
                std::env::temp_dir().join(format!("rotifer-mem-optout-{}", uuid::Uuid::new_v4()));
            let sink = JsonlSink::from_env(&dir, |name| {
                vars.iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| v.to_string())
            });
            sink.audit(&audit_event()).unwrap();
            sink.telemetry(&denial);
            assert!(dir.join("audit.jsonl").exists(), "{vars:?}");
            assert_eq!(dir.join("telemetry.jsonl").exists(), on, "{vars:?}");
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn audit_lines_carry_no_key_or_value() {
        let line = serde_json::to_value(audit_event()).unwrap();
        assert!(line.get("key").is_none());
        assert!(line.get("value").is_none());
    }

    #[test]
    fn an_unwritable_path_fails_the_audit_and_only_logs_the_telemetry() {
        // A file where the directory should be: create_dir_all fails.
        let file =
            std::env::temp_dir().join(format!("rotifer-mem-notadir-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"x").unwrap();
        let sink = JsonlSink::from_env(&file.join("sub"), |_| None);
        // The audit append reports the failure, so the store can roll the
        // change back; telemetry returns without raising.
        // Neither touches the file that blocks the directory.
        assert!(sink.audit(&audit_event()).is_err());
        sink.telemetry(&MemoryTelemetryEvent::access_denied(
            0,
            Some("v2:aa"),
            Some("agent-1"),
            Some("ab"),
            "read",
            &MemoryError::AccessDenied("no".into()),
        ));
        assert_eq!(std::fs::read(&file).unwrap(), b"x");
        assert!(!file.join("sub").exists());
        std::fs::remove_file(file).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn audit_and_telemetry_files_are_private_to_the_user() {
        // They record which genes touched which entries; not
        // world-readable whatever the umask, including an audit.jsonl the L0
        // gate created first with default permissions.
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("rotifer-mem-perm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("audit.jsonl"), b"").unwrap();
        std::fs::set_permissions(
            dir.join("audit.jsonl"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        let sink = JsonlSink::from_env(&dir, |_| None);
        sink.audit(&audit_event()).unwrap();
        sink.telemetry(&MemoryTelemetryEvent::access_denied(
            0,
            Some("v2:aa"),
            Some("agent-1"),
            Some("ab"),
            "read",
            &MemoryError::AccessDenied("no".into()),
        ));
        for name in ["audit.jsonl", "telemetry.jsonl"] {
            let mode = std::fs::metadata(dir.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "{name} is {mode:o}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
