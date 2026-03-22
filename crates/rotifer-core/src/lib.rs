//! Core library for the **Rotifer Protocol** — a decentralized evolution
//! framework for autonomous AI agent capabilities.
//!
//! This crate provides the foundational building blocks:
//!
//! - [`types`] — Protocol-wide types: genes, phenotypes, contexts, execution results.
//! - [`sandbox`] — WASM-based sandboxed gene execution via `wasmtime`.
//! - [`arena`] — Competitive fitness-ranked gene selection (L0 Arena).
//! - [`algebra`] — Gene composition operators: `Seq`, `Par`, `Cond`, `Try`, `Transform`.
//! - [`fitness`] — Fitness scoring and admission gate per §5.
//! - [`compiler`] — IR compiler pipeline: custom sections, injection, verification.
//! - [`storage`] — Persistent gene, agent, and arena storage (SQLite).
//! - [`agent`] — Agent lifecycle management.

pub mod types;
pub mod sandbox;
pub mod binding;
pub mod arena;
pub mod algebra;
pub mod fitness;
pub mod compiler;
pub mod storage;
pub mod agent;
pub mod reputation;
pub mod p2p;
pub mod l0;
