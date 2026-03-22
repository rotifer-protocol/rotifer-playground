//! Append-only audit log for L0 gate decisions.

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use super::gate::L0CheckResult;

/// A single entry in the L0 audit log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub ts: String,
    pub gene_id: String,
    pub gene_domain: String,
    pub action: AuditAction,
    pub l0_passed: bool,
    pub violations: Vec<String>,
    pub sandbox: Option<String>,
    pub fuel_consumed: Option<u64>,
    pub memory_peak_kb: Option<u64>,
    pub duration_ms: Option<u64>,
    pub result: String,
}

/// What happened at the L0 gate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditAction {
    Execute,
    L0Block,
    L0Pass,
}

/// Append-only audit log writer.
pub struct AuditLog {
    path: std::path::PathBuf,
}

impl AuditLog {
    /// Open (or create) an audit log at the given path.
    pub fn new(path: &Path) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    /// Write a pre-execution L0 check result to the log.
    pub fn log_l0_check(
        &self,
        gene_id: &str,
        gene_domain: &str,
        check_result: &L0CheckResult,
    ) -> std::io::Result<()> {
        let entry = AuditEntry {
            ts: chrono::Utc::now().to_rfc3339(),
            gene_id: gene_id.to_string(),
            gene_domain: gene_domain.to_string(),
            action: if check_result.passed {
                AuditAction::L0Pass
            } else {
                AuditAction::L0Block
            },
            l0_passed: check_result.passed,
            violations: check_result
                .violations
                .iter()
                .map(|v| v.to_string())
                .collect(),
            sandbox: None,
            fuel_consumed: None,
            memory_peak_kb: None,
            duration_ms: None,
            result: if check_result.passed {
                "passed".to_string()
            } else {
                "blocked".to_string()
            },
        };

        self.append(&entry)
    }

    /// Write a post-execution result to the log.
    #[allow(clippy::too_many_arguments)]
    pub fn log_execution(
        &self,
        gene_id: &str,
        gene_domain: &str,
        sandbox_type: &str,
        fuel_consumed: u64,
        memory_peak_kb: u64,
        duration_ms: u64,
        success: bool,
    ) -> std::io::Result<()> {
        let entry = AuditEntry {
            ts: chrono::Utc::now().to_rfc3339(),
            gene_id: gene_id.to_string(),
            gene_domain: gene_domain.to_string(),
            action: AuditAction::Execute,
            l0_passed: true,
            violations: vec![],
            sandbox: Some(sandbox_type.to_string()),
            fuel_consumed: Some(fuel_consumed),
            memory_peak_kb: Some(memory_peak_kb),
            duration_ms: Some(duration_ms),
            result: if success {
                "success".to_string()
            } else {
                "failure".to_string()
            },
        };

        self.append(&entry)
    }

    fn append(&self, entry: &AuditEntry) -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;

        let json = serde_json::to_string(entry)
            .map_err(std::io::Error::other)?;

        writeln!(file, "{json}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::NamedTempFile;

    #[test]
    fn log_l0_pass() {
        let tmp = NamedTempFile::new().unwrap();
        let log = AuditLog::new(tmp.path()).unwrap();

        let check = L0CheckResult {
            passed: true,
            violations: vec![],
            checks_performed: 3,
        };

        log.log_l0_check("abc123", "search.web", &check).unwrap();

        let content = std::fs::read_to_string(tmp.path()).unwrap();
        assert!(content.contains("\"l0_passed\":true"));
        assert!(content.contains("\"result\":\"passed\""));
    }

    #[test]
    fn log_l0_block() {
        let tmp = NamedTempFile::new().unwrap();
        let log = AuditLog::new(tmp.path()).unwrap();

        let check = L0CheckResult {
            passed: false,
            violations: vec![super::super::gate::L0Violation::NetworkAccessDenied],
            checks_performed: 1,
        };

        log.log_l0_check("xyz789", "evil.hack", &check).unwrap();

        let content = std::fs::read_to_string(tmp.path()).unwrap();
        assert!(content.contains("\"l0_passed\":false"));
        assert!(content.contains("\"result\":\"blocked\""));
    }

    #[test]
    fn log_execution() {
        let tmp = NamedTempFile::new().unwrap();
        let log = AuditLog::new(tmp.path()).unwrap();

        log.log_execution("abc", "search.web", "wasm", 42000, 128, 23, true)
            .unwrap();

        let content = std::fs::read_to_string(tmp.path()).unwrap();
        assert!(content.contains("\"fuel_consumed\":42000"));
        assert!(content.contains("\"result\":\"success\""));
    }

    #[test]
    fn append_multiple_entries() {
        let tmp = NamedTempFile::new().unwrap();
        let log = AuditLog::new(tmp.path()).unwrap();

        log.log_execution("a", "d1", "wasm", 100, 64, 10, true).unwrap();
        log.log_execution("b", "d2", "wasm", 200, 128, 20, false).unwrap();

        let content = std::fs::read_to_string(tmp.path()).unwrap();
        let lines: Vec<_> = content.lines().collect();
        assert_eq!(lines.len(), 2);
    }
}
