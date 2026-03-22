//! L0 Kernel — the innermost, immutable constraint layer.
//!
//! `L0Gate` enforces permission boundaries *before* a gene enters the sandbox.
//! Every execution must pass through `L0Gate::check()` first; violations are
//! recorded in an append-only audit log.

mod gate;
mod audit;

pub use gate::{L0Gate, L0Violation};
pub use audit::{AuditEntry, AuditLog};
