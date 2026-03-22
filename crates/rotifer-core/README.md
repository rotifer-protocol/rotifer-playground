# rotifer-core

[![crates.io](https://img.shields.io/crates/v/rotifer-core.svg)](https://crates.io/crates/rotifer-core)
[![docs.rs](https://docs.rs/rotifer-core/badge.svg)](https://docs.rs/rotifer-core)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](https://github.com/rotifer-protocol/rotifer-playground/blob/main/LICENSE)

Core library for the **Rotifer Protocol** — a decentralized evolution framework for autonomous AI agent capabilities.

## Modules

| Module | Description |
|--------|-------------|
| `types` | Protocol-wide types: genes, phenotypes, contexts, execution results |
| `sandbox` | WASM-based sandboxed gene execution via `wasmtime` |
| `arena` | Competitive fitness-ranked gene selection (L0 Arena) |
| `algebra` | Gene composition operators: `Seq`, `Par`, `Cond`, `Try`, `Transform` |
| `fitness` | Fitness scoring and admission gate per spec §5 |
| `compiler` | IR compiler pipeline: custom sections, injection, verification |
| `storage` | Persistent gene, agent, and arena storage (SQLite) |
| `agent` | Agent lifecycle management |

## Quick Start

```rust
use rotifer_core::types::{Context, PermissionSet, compute_gene_id};
use rotifer_core::sandbox::WasmtimeSandbox;

// Create a sandbox with default constraints
let sandbox = WasmtimeSandbox::with_defaults().unwrap();

// Compile a gene to Rotifer IR
use rotifer_core::compiler::{compile_to_ir, genesis};
let wasm = genesis::build_echo_gene_wasm();
// ... see docs for full compilation pipeline
```

## License

Apache-2.0 — see [LICENSE](https://github.com/rotifer-protocol/rotifer-playground/blob/main/LICENSE).
