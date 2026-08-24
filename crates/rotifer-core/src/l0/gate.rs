//! Pre-execution gate that enforces L0 constraints on gene invocations.

use crate::sandbox::ConstraintSet;
use crate::types::gene::Phenotype;
use crate::types::PermissionSet;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Violation emitted when a gene fails L0 pre-execution checks.
#[derive(Debug, Clone, Error, Serialize, Deserialize)]
pub enum L0Violation {
    #[error("domain '{0}' is not in the allowed list")]
    DomainNotAllowed(String),
    #[error("requested memory {requested} bytes exceeds limit {limit} bytes")]
    MemoryExceeded { requested: u64, limit: u64 },
    #[error("requested fuel {requested} exceeds limit {limit}")]
    FuelExceeded { requested: u64, limit: u64 },
    #[error("network access required but not permitted")]
    NetworkAccessDenied,
    #[error("filesystem access to '{0}' not permitted")]
    FilesystemAccessDenied(String),
    #[error("execution timeout {requested}ms exceeds limit {limit}ms")]
    TimeoutExceeded { requested: u64, limit: u64 },
}

/// L0 pre-execution gate — checks gene metadata against runtime constraints.
///
/// Operates in permissive mode: only checks explicitly declared permissions.
/// A gene that does not declare network_access won't be checked for it.
pub struct L0Gate;

/// Result of an L0 check: either clean pass or a list of violations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct L0CheckResult {
    pub passed: bool,
    pub violations: Vec<L0Violation>,
    pub checks_performed: u32,
}

impl L0Gate {
    /// Run all L0 pre-execution checks. Returns `Ok(result)` with details.
    pub fn check(
        phenotype: &Phenotype,
        permissions: &PermissionSet,
        constraints: &ConstraintSet,
    ) -> L0CheckResult {
        let mut violations = Vec::new();
        let mut checks_performed = 0u32;

        Self::check_domain(&phenotype.domain, permissions, &mut violations, &mut checks_performed);
        Self::check_resource_limits(permissions, constraints, &mut violations, &mut checks_performed);
        Self::check_network(permissions, &mut violations, &mut checks_performed);
        Self::check_filesystem(permissions, &mut violations, &mut checks_performed);

        L0CheckResult {
            passed: violations.is_empty(),
            violations,
            checks_performed,
        }
    }

    fn check_domain(
        domain: &str,
        permissions: &PermissionSet,
        violations: &mut Vec<L0Violation>,
        checks: &mut u32,
    ) {
        if let Some(allowed) = &permissions.allowed_domains {
            *checks += 1;
            let domain_matches = allowed.iter().any(|d| {
                domain == d || domain.starts_with(&format!("{d}."))
            });
            if !domain_matches {
                violations.push(L0Violation::DomainNotAllowed(domain.to_string()));
            }
        }
    }

    fn check_resource_limits(
        permissions: &PermissionSet,
        constraints: &ConstraintSet,
        violations: &mut Vec<L0Violation>,
        checks: &mut u32,
    ) {
        if let Some(max_mem) = permissions.resource_limits.max_memory_bytes {
            *checks += 1;
            if max_mem > constraints.max_memory_bytes {
                violations.push(L0Violation::MemoryExceeded {
                    requested: max_mem,
                    limit: constraints.max_memory_bytes,
                });
            }
        }

        if let Some(max_fuel) = permissions.resource_limits.max_fuel_units {
            *checks += 1;
            if max_fuel > constraints.max_fuel {
                violations.push(L0Violation::FuelExceeded {
                    requested: max_fuel,
                    limit: constraints.max_fuel,
                });
            }
        }

        if let Some(max_time) = permissions.resource_limits.max_execution_time_ms {
            *checks += 1;
            if max_time > constraints.max_execution_time_ms {
                violations.push(L0Violation::TimeoutExceeded {
                    requested: max_time,
                    limit: constraints.max_execution_time_ms,
                });
            }
        }
    }

    fn check_network(
        permissions: &PermissionSet,
        _violations: &mut Vec<L0Violation>,
        checks: &mut u32,
    ) {
        *checks += 1;
        if permissions.network_access {
            // In permissive mode, network access is allowed if declared.
            // Stricter modes will deny based on constraint policy.
        }
        // Note: violation is raised by the sandbox at runtime if an actual
        // network call is attempted by a gene that declared network_access: false.
    }

    fn check_filesystem(
        permissions: &PermissionSet,
        violations: &mut Vec<L0Violation>,
        checks: &mut u32,
    ) {
        if let Some(paths) = &permissions.file_system_access {
            *checks += 1;
            for path in paths {
                if path.contains("..") || path.starts_with('/') {
                    violations.push(L0Violation::FilesystemAccessDenied(path.clone()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ResourceLimits;
    use crate::types::gene::Fidelity;

    fn test_phenotype(domain: &str) -> Phenotype {
        Phenotype {
            domain: domain.to_string(),
            input_schema: serde_json::json!({}),
            output_schema: serde_json::json!({}),
            dependencies: vec![],
            version: "0.1.0".to_string(),
            author: "test".to_string(),
            created_at: 0,
            ir_hash: None,
            fidelity: Fidelity::Native,
            source_framework: None,
            regulatory_tags: None,
            transparency: crate::types::gene::GeneTransparency::Open,
            streaming_capability: None,
            pricing_hint: None,
            semantic_requirements: None,
            network: None,
            external_dependencies: None,
            llm_requirements: None,
            guard_config: None,
        }
    }

    #[test]
    fn pass_with_default_permissions() {
        let phenotype = test_phenotype("search.web");
        let permissions = PermissionSet::default();
        let constraints = ConstraintSet::default();
        let result = L0Gate::check(&phenotype, &permissions, &constraints);
        assert!(result.passed);
        assert!(result.violations.is_empty());
    }

    #[test]
    fn domain_allowed() {
        let phenotype = test_phenotype("search.web");
        let permissions = PermissionSet {
            allowed_domains: Some(vec!["search".to_string(), "code".to_string()]),
            ..Default::default()
        };
        let result = L0Gate::check(&phenotype, &permissions, &ConstraintSet::default());
        assert!(result.passed, "search.web should match 'search' prefix");
    }

    #[test]
    fn domain_not_allowed() {
        let phenotype = test_phenotype("evil.hack");
        let permissions = PermissionSet {
            allowed_domains: Some(vec!["search".to_string(), "code".to_string()]),
            ..Default::default()
        };
        let result = L0Gate::check(&phenotype, &permissions, &ConstraintSet::default());
        assert!(!result.passed);
        assert!(matches!(&result.violations[0], L0Violation::DomainNotAllowed(d) if d == "evil.hack"));
    }

    #[test]
    fn memory_exceeded() {
        let phenotype = test_phenotype("test");
        let permissions = PermissionSet {
            resource_limits: ResourceLimits {
                max_memory_bytes: Some(128 * 1024 * 1024), // 128 MB
                ..Default::default()
            },
            ..Default::default()
        };
        let constraints = ConstraintSet {
            max_memory_bytes: 64 * 1024 * 1024, // 64 MB limit
            ..Default::default()
        };
        let result = L0Gate::check(&phenotype, &permissions, &constraints);
        assert!(!result.passed);
        assert!(matches!(&result.violations[0], L0Violation::MemoryExceeded { .. }));
    }

    #[test]
    fn fuel_exceeded() {
        let phenotype = test_phenotype("test");
        let permissions = PermissionSet {
            resource_limits: ResourceLimits {
                max_fuel_units: Some(5_000_000),
                ..Default::default()
            },
            ..Default::default()
        };
        let constraints = ConstraintSet {
            max_fuel: 1_000_000,
            ..Default::default()
        };
        let result = L0Gate::check(&phenotype, &permissions, &constraints);
        assert!(!result.passed);
        assert!(matches!(&result.violations[0], L0Violation::FuelExceeded { .. }));
    }

    #[test]
    fn filesystem_path_traversal_blocked() {
        let phenotype = test_phenotype("test");
        let permissions = PermissionSet {
            file_system_access: Some(vec!["../../etc/passwd".to_string()]),
            ..Default::default()
        };
        let result = L0Gate::check(&phenotype, &permissions, &ConstraintSet::default());
        assert!(!result.passed);
        assert!(matches!(&result.violations[0], L0Violation::FilesystemAccessDenied(_)));
    }

    #[test]
    fn filesystem_absolute_path_blocked() {
        let phenotype = test_phenotype("test");
        let permissions = PermissionSet {
            file_system_access: Some(vec!["/etc/passwd".to_string()]),
            ..Default::default()
        };
        let result = L0Gate::check(&phenotype, &permissions, &ConstraintSet::default());
        assert!(!result.passed);
    }

    #[test]
    fn filesystem_relative_path_allowed() {
        let phenotype = test_phenotype("test");
        let permissions = PermissionSet {
            file_system_access: Some(vec!["data/input.json".to_string()]),
            ..Default::default()
        };
        let result = L0Gate::check(&phenotype, &permissions, &ConstraintSet::default());
        assert!(result.passed);
    }

    #[test]
    fn multiple_violations() {
        let phenotype = test_phenotype("evil.hack");
        let permissions = PermissionSet {
            allowed_domains: Some(vec!["search".to_string()]),
            resource_limits: ResourceLimits {
                max_memory_bytes: Some(256 * 1024 * 1024),
                max_fuel_units: Some(10_000_000),
                ..Default::default()
            },
            file_system_access: Some(vec!["/root/.ssh/id_rsa".to_string()]),
            ..Default::default()
        };
        let constraints = ConstraintSet::default();
        let result = L0Gate::check(&phenotype, &permissions, &constraints);
        assert!(!result.passed);
        assert!(result.violations.len() >= 3, "expected domain + memory + fuel + fs violations");
    }

    #[test]
    fn checks_performed_counted() {
        let phenotype = test_phenotype("test");
        let permissions = PermissionSet {
            allowed_domains: Some(vec!["test".to_string()]),
            resource_limits: ResourceLimits {
                max_memory_bytes: Some(32 * 1024 * 1024),
                max_fuel_units: Some(500_000),
                max_execution_time_ms: Some(10_000),
            },
            file_system_access: Some(vec!["data".to_string()]),
            ..Default::default()
        };
        let result = L0Gate::check(&phenotype, &permissions, &ConstraintSet::default());
        assert!(result.checks_performed >= 5);
    }
}
