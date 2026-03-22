# Rotifer Playground

[![CI](https://github.com/rotifer-protocol/rotifer-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/rotifer-protocol/rotifer-playground/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rotifer/playground)](https://www.npmjs.com/package/@rotifer/playground)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/Protocol-Frozen-orange)](https://github.com/rotifer-protocol/rotifer-spec)
[![Discord](https://img.shields.io/discord/placeholder?label=Discord&logo=discord&color=5865F2)](https://discord.gg/6d4JrfMr)

Development environment for the **Rotifer Protocol** — build genes, compete in Arenas, share via Cloud, and simulate agent evolution.

> **Status:** Alpha (v0.5.0-alpha.1). Core gene lifecycle, IR compiler, Cloud Binding, Reputation System, and comprehensive documentation are functional. P2P Network and L4 Collective Immunity are planned — see [Implementation Status](#implementation-status) below.

---

## Install

```bash
npm install -g @rotifer/playground
```

Or use directly via npx:

```bash
npx @rotifer/playground init my-project
```

**Requirements:** Node.js >= 20.0.0

---

## 30-Second Demo

```bash
$ rotifer init my-project

  Rotifer Protocol - Project Initialization
  ───────────────────────────────────────────
✓ Project scaffolding created
ℹ Installing Genesis genes...
✓ 5 Genesis genes installed

  Arena Rankings
  ────────────────
  #   Name                        Domain        F(g)    Fidelity
  ────────────────────────────────────────────────────────────────
  1   genesis-web-search          search        0.87    Native
  2   genesis-code-format         tooling       0.81    Native
  3   genesis-l0-constraint       safety        0.79    Native
  4   genesis-web-search-lite     search        0.77    Native
  5   genesis-file-read           filesystem    0.74    Native
  6   hello-world                 general       0.57    Wrapped

ℹ 6 genes across 5 domain(s) — Arena is alive!
✓ Project ready: my-project
```

One command. Five Genesis genes. A living Arena.

---

## Three-Act Experience (ADR-11)

### Act 1 — Wow (30 seconds)

```bash
rotifer init my-project && cd my-project
```

You see an Arena with 6 genes ranked by fitness. No configuration needed.

### Act 2 — Aha (5 minutes)

```bash
rotifer scan genes/               # Discover candidate functions
rotifer wrap hello-world           # Wrap as a gene (generates Phenotype)
rotifer test hello-world           # Run L2 sandbox tests (WASM sandbox for compiled genes)
rotifer test hello-world --compliance  # Run structural compliance checks
rotifer arena submit hello-world   # Submit to Arena (admission gate)
rotifer arena list                 # See your gene's ranking
```

Your existing code becomes a gene and competes in the Arena.

### Act 3 — Hooked (30 minutes)

Write a TypeScript gene and compile it to Native WASM automatically:

```bash
# Write a gene in TypeScript — same language, zero learning curve
mkdir genes/my-search && cat > genes/my-search/index.ts << 'EOF'
export function express(input: { query: string }) {
  return { results: [`Found: ${input.query}`], total: 1 };
}
EOF

rotifer wrap my-search --domain search
rotifer compile my-search          # TS → JS → WASM (Javy) → Rotifer IR
rotifer arena submit my-search     # Watch it climb the rankings
rotifer arena list --domain search # Compare against Genesis genes

# Create an Agent with a gene genome (supports Seq, Par, Cond, Try)
rotifer agent create search-bot --genes genesis-web-search my-search
rotifer agent create parallel-bot --genes web-search doc-search --composition Par
rotifer agent list

# Run the Agent — WASM sandbox execution preferred
rotifer agent run search-bot --input '{"query":"rotifer protocol"}'
rotifer agent run search-bot --no-sandbox  # Force Node.js fallback
```

**v0.3 highlight:** `rotifer compile` auto-detects TypeScript genes and compiles them to Native WASM via [Javy](https://github.com/bytecodealliance/javy) (QuickJS→WASM). No separate toolchain required.

---

## Architecture

```
playground/
├── crates/
│   ├── rotifer-core/        Rust: types, sandbox, arena, algebra, fitness, storage
│   └── rotifer-napi/        napi-rs bridge: Rust ↔ Node.js FFI
├── src/                     TypeScript CLI (commander.js)
│   ├── commands/            16 CLI commands
│   ├── cloud/               Cloud Binding client (auth, API, types)
│   ├── utils/               Config, display, NAPI binding, Javy compiler
│   └── errors/              Rust-style error formatting
├── genes/                   5 Genesis genes (bundled)
├── supabase/                Cloud Binding self-hosting guide
├── templates/               Gene + composition scaffolds
└── tests/                   Unit + E2E test suites (114 tests)
```

### Layers

| Layer | Technology | Responsibility |
|-------|-----------|----------------|
| **CLI** | TypeScript + commander.js | User interface, command routing, display |
| **Bridge** | napi-rs (cdylib) | Rust-to-Node.js FFI binding |
| **Core** | Rust + wasmtime | WASM sandbox (Direct + WASI), Arena engine, Algebra executor, Fitness computation, SQLite storage |

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `rotifer init [name]` | Initialize a new gene project with Genesis genes |
| `rotifer scan [path]` | Scan source files for candidate gene functions |
| `rotifer wrap <name>` | Wrap a function as a Rotifer gene |
| `rotifer test [name]` | Test a gene (WASM sandbox preferred, `--compliance` for structural checks) |
| `rotifer compile [name]` | Compile gene to Rotifer IR (auto TS→WASM via Javy) |
| `rotifer arena submit <name>` | Submit a gene to the Arena (`--cloud` for Cloud Arena) |
| `rotifer arena list` | List Arena rankings (`--cloud` for Cloud Arena) |
| `rotifer arena watch <domain>` | Watch Arena rankings live (`--cloud` for Cloud Arena) |
| `rotifer login` | Log in to Rotifer Cloud via GitHub OAuth |
| `rotifer logout` | Log out from Rotifer Cloud |
| `rotifer publish <name>` | Publish a gene to Rotifer Cloud |
| `rotifer search [query]` | Search genes on Rotifer Cloud |
| `rotifer install <gene-id>` | Install a gene from Rotifer Cloud |
| `rotifer agent create <name>` | Create an Agent (`--composition Seq\|Par\|Cond\|Try`) |
| `rotifer agent list` | List all agents |
| `rotifer agent run <name>` | Execute genome pipeline (WASM sandbox, `--no-sandbox` for Node.js) |

---

## Genesis Genes

Five pre-installed genes ship with every project:

| Gene | Domain | Fidelity | Description |
|------|--------|----------|-------------|
| `genesis-web-search` | search | Native | Full web search with multiple results |
| `genesis-web-search-lite` | search | Native | Lightweight single-answer search |
| `genesis-file-read` | filesystem | Native | Read local files (L0 sandbox restricted) |
| `genesis-code-format` | tooling | Native | Format source code (JSON, TS, etc.) |
| `genesis-l0-constraint` | safety | Native | L0 sandbox constraint checker |

---

## Gene Composition (Algebra)

Genes can be composed using the Rotifer Algebra:

| Operator | Description | Example |
|----------|-------------|---------|
| **Seq** | Sequential pipeline | Search → Format |
| **Par** | Parallel with merge | Search + Search-Lite, take first |
| **Cond** | Conditional branch | If query.length > 100 → Lite, else → Full |
| **Try** | Fault tolerance | Primary with fallback |
| **Transform** | Map/transform | Inner gene → mapper gene |

See `templates/composition/` for JSON examples.

---

## Development

```bash
git clone https://github.com/rotifer-protocol/rotifer-playground.git
cd playground

# TypeScript CLI
npm install
npm run build          # Build to dist/
npm test               # Run 114 TypeScript tests
npm run lint           # Type check only

# Rust Core (requires Rust toolchain)
cargo check -p rotifer-core
cargo test -p rotifer-core

# Full demo
bash demo.sh
```

---

## Implementation Status

> This project is in **alpha**. The table below shows the honest implementation status of each URAA layer as of v0.5.5.

| URAA Layer | Spec Name | Status | What Works | What's Planned |
|------------|-----------|--------|------------|----------------|
| **L0** | Kernel | **~35%** | `L0Gate` pre-execution checks (domain, resource, network, filesystem); Audit log | EthicalBoundary, State Anchoring, Trust Anchor |
| **L1** | Synthesis | **~95%** | WASM sandbox (wasmtime), IR compiler, Javy TS→WASM, NAPI bridge | Full WASI capability negotiation |
| **L2** | Calibration | **~40%** | Schema validation, sandbox testing, `--compliance` checks | Static analysis, controlled field trial |
| **L3** | Competition | **~60%** | Arena ranking, F(g) multiplicative model, R(g) reputation, Cloud Registry | P2P HLT broadcasting (stub only), hot-loading, retirement |
| **L4** | Collective Immunity | **0%** | — | Threat broadcasting, emergency rollback, cross-node consensus |
| **Algebra** | Composition | **~90%** | All 5 operators in Rust; CLI supports Seq/Par/Cond/Try | DataFlowGraph |

**Key limitation:** L4 depends on L3's P2P network, which is currently a stub. Full L4 is targeted for v0.9+.

---

## Protocol Compliance

Targets **Rotifer Protocol Specification** (Frozen). See [Implementation Status](#implementation-status) for detailed layer-by-layer coverage.

| Depth | Components | Notes |
|-------|------------|-------|
| **Full** | Phenotype, AlgebraExpr, Fitness F(g), Arena | Core gene lifecycle |
| **Functional** | WASM Sandbox, L0 Gate, Reputation R(g) | L0 at ~35%, expanding |
| **Simplified** | Agent Lifecycle, Gene Lifecycle, RotiferBinding | MVP subset |
| **Stub/Planned** | P2P HLT, Formal Verification, Cross-Binding Consistency, ZK Proofs, L4 Immunity | Roadmap items |

Changes driven by implementation feedback are proposed through the ADR process.

---

## Roadmap

- [x] **v0.1** — Core CLI + Genesis genes + Arena
- [x] **v0.2** — IR compiler pipeline, live Arena watching, NAPI bridge
- [x] **v0.3** — Frontend SDK: TS→WASM auto-compilation via Javy, WASI sandbox support
- [x] **v0.4** — Cloud Binding: publish/search/install genes, Cloud Arena, GitHub OAuth
- [x] **v0.5** — Reputation System, developer documentation, L0 Gate
- [x] **v0.5.5** — Foundation Hardening: WASM sandbox enforcement, L0 Gate integration, F(g) spec alignment
- [ ] **v0.6** — Web Registry: dynamic gene pages, developer profiles, gene cold start (≥50 genes)
- [ ] **v0.6.5** — Cross-Binding Proof: `RotiferBinding` trait, Web3 Mock Binding, IR interop validation
- [ ] **v0.7** — Hybrid Gene, IDE plugins (Cursor/VS Code), developer dogfooding
- [ ] **v0.8** — Security hardening, P2P protocol design (RFC)
- [ ] **v0.9** — P2P network (metadata discovery), economic framework design
- [ ] **v1.0** — Stable release: L0-L3 complete, economic system, security audit

---

## Community

- [Discord](https://discord.gg/6d4JrfMr) — Join the conversation
- [GitHub Discussions](https://github.com/rotifer-protocol/rotifer-playground/discussions) — Questions and proposals

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[Apache-2.0](LICENSE) with [Rotifer Safety Clause](LICENSE#rotifer-safety-clause-additional-terms)

This project uses the Apache License 2.0 with an additional **Rotifer Safety Clause** that requires any deployment to either preserve the L0 Constraint Layer or clearly disclose modifications to it.

---

**The Rotifer Protocol is alive.**
