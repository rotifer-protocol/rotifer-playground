# Rotifer Playground

[![CI](https://github.com/rotifer-protocol/rotifer-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/rotifer-protocol/rotifer-playground/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rotifer/playground)](https://www.npmjs.com/package/@rotifer/playground)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/Protocol-Frozen-orange)](https://github.com/rotifer-protocol/rotifer-spec)
[![Discord](https://img.shields.io/discord/placeholder?label=Discord&logo=discord&color=5865F2)](https://rotifer.dev/discord)

Development environment for the **Rotifer Protocol** — **WASM-Native, Polyglot by Design**: build genes in TypeScript / Rust / AssemblyScript / Go / C, compete in Arenas, share via Cloud, and simulate agent evolution.

> **Status:** v0.8.6 — CLI runtime bugfix release: fixes Javy shim async traps, compile cache staleness, irHash serde incompatibility, fuel exhaustion, and native addon distribution. All four platforms now ship prebuilt `.node` binaries via optional dependencies. See [CHANGELOG.md](CHANGELOG.md) for full release history. P2P implementation and L4 Collective Immunity are still planned — see [Implementation Status](#implementation-status) below.

---

## Install

```bash
npm install -g @rotifer/playground
```

Or use directly via npx:

```bash
npx -y @rotifer/playground@latest init my-agent
```

**Requirements:** Node.js >= 20.0.0

---

## First Agent in Seconds

```bash
rotifer init my-agent && cd my-agent
rotifer hello --template quality-advisor
```

`rotifer init` bootstraps the local Arena and Genesis genes. `rotifer hello --template quality-advisor` is the recommended preset-agent entrypoint for a first run.

---

## 30-Second Demo

```bash
$ rotifer init my-agent

  Rotifer Protocol - Agent Workspace Initialization
  ───────────────────────────────────────────
✓ Agent workspace scaffolding created
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
✓ Agent workspace ready: my-agent
```

One command boots the Arena. `rotifer hello --template quality-advisor` turns those bundled genes into your first preset agent.

---

## Three-Act Experience (ADR-11)

### Act 1 — Wow (30 seconds)

```bash
rotifer init my-agent && cd my-agent
```

You see an Arena with 6 genes ranked by fitness. No configuration needed.

### Act 2 — Aha (5 minutes)

```bash
rotifer hello --template quality-advisor # Run the recommended preset Agent
rotifer agent list                 # Inspect the generated hello-* agent
```

Bundled genes become a working preset agent in seconds.

### Act 3 — Hooked (30 minutes)

Turn your own code into a gene, then build a custom agent:

```bash
# Wrap existing code as a gene
rotifer scan genes/                    # Discover candidate functions
rotifer wrap hello-world               # Wrap as a gene (generates Phenotype)
rotifer test hello-world               # Run sandbox tests (WASM sandbox for compiled genes)
rotifer test hello-world --compliance  # Run structural compliance checks
rotifer arena submit hello-world       # Submit to Arena (admission gate)
rotifer arena list                     # See your gene's ranking

# Write a gene in TypeScript — same language, zero learning curve
mkdir genes/my-search && cat > genes/my-search/index.ts << 'EOF'
export function express(input: { query: string }) {
  return { results: [`Found: ${input.query}`], total: 1 };
}
EOF

rotifer wrap my-search --domain search
rotifer compile my-search           # TS → JS → WASM → Rotifer IR
rotifer arena submit my-search      # Watch it climb the rankings
rotifer arena list --domain search # Compare against Genesis genes

# Create an Agent with a gene genome (supports Seq, Par, Cond, Try)
rotifer agent create search-bot --genes genesis-web-search my-search
rotifer agent create parallel-bot --genes web-search doc-search --composition Par
rotifer agent list

# Run the Agent — WASM sandbox execution preferred
rotifer agent run search-bot --input '{"query":"rotifer protocol"}'
rotifer agent run search-bot --no-sandbox  # Force Node.js fallback
```

`rotifer compile` auto-detects TypeScript genes and compiles them to Native WASM. No separate toolchain required.

---

## Architecture

```
playground/
├── crates/
│   ├── rotifer-core/        Rust: types, sandbox, arena, algebra, fitness, storage
│   └── rotifer-napi/        Native bridge: Rust ↔ Node.js FFI
├── src/                     TypeScript CLI and supporting modules
│   ├── commands/            CLI command modules
│   ├── cloud/               Cloud Binding client (auth, API, types)
│   └── utils/               Config, display, native binding, IR compiler
├── genes/                   Bundled gene directories
├── supabase/                Cloud Binding self-hosting guide
├── templates/               Gene + composition scaffolds
└── tests/                   Unit + E2E test suites
```

### Layers

| Layer | Technology | Responsibility |
|-------|-----------|----------------|
| **CLI** | TypeScript + commander.js | User interface, command routing, display |
| **Bridge** | Native bridge (cdylib) | Rust-to-Node.js FFI binding |
| **Core** | Rust + WASM runtime | WASM sandbox (Direct + WASI), Arena engine, Algebra executor, Fitness computation, SQLite storage |

---

## CLI Commands

Run `rotifer --help` for the grouped command list. The commands below cover the main local, cloud, arena, and agent workflows.

| Command | Description |
|---------|-------------|
| `rotifer init [workspace-name]` | Initialize a new Agent workspace with Genesis genes |
| `rotifer hello [--template <id>]` | Create and run a preset agent from curated templates inside a Rotifer Agent workspace |
| `rotifer scan [path]` | Scan for candidate genes and local skills |
| `rotifer wrap <gene-name>` | Wrap a function or SKILL.md as a gene |
| `rotifer test [gene-name]` | Test a gene (WASM sandbox preferred, `--compliance` for structural checks) |
| `rotifer compile [gene-name]` | Compile gene to Rotifer IR (auto TS→WASM) |
| `rotifer run <gene-name>` | Execute a single local gene directly |
| `rotifer list` | List local genes in the current Agent workspace |
| `rotifer login` | Log in to Rotifer Cloud (OAuth) |
| `rotifer logout` | Log out from Rotifer Cloud |
| `rotifer publish [gene-name]` | Publish gene(s) to Rotifer Cloud |
| `rotifer search [query]` | Search genes on Rotifer Cloud |
| `rotifer install <gene-ref>` | Install a gene from Cloud (UUID, name, or content hash) |
| `rotifer info <gene-ref>` | View gene details (local or Cloud) |
| `rotifer stats <gene-ref>` | View download statistics for a gene |
| `rotifer compare [gene-refs...]` | Compare 2–5 genes by reputation and downloads |
| `rotifer reputation [gene-ref]` | View gene and creator reputation scores |
| `rotifer versions <owner> <gene-name>` | View version history chain for a gene |
| `rotifer arena submit <gene-name>` | Submit a gene to the Arena (`--cloud` for Cloud Arena) |
| `rotifer arena list` | List Arena rankings (`--cloud` for Cloud Arena) |
| `rotifer arena watch <domain>` | Watch Arena rankings live (`--cloud` for Cloud Arena) |
| `rotifer agent create <agent-name>` | Create an Agent (`--composition Seq\|Par\|Cond\|Try\|TryPool`) |
| `rotifer agent list` | List all agents |
| `rotifer agent run <agent-name>` | Execute genome pipeline (WASM sandbox, `--no-sandbox` for Node.js) |
| `rotifer vg [path]` | V(g) security scan for gene/skill code |
| `rotifer network` | P2P gene network commands (see `rotifer network --help`) |
| `rotifer self-update` | Check for updates and upgrade Rotifer packages |
| `rotifer config` | Manage global Rotifer configuration |
| `rotifer whoami` | Show current authentication status |

---

## Genesis Genes

Five pre-installed genes ship with every Agent workspace:

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

## Examples

The `examples/` directory contains reference implementations and experiments:

| Directory | Description |
|-----------|-------------|
| `examples/mcp-migration/` | How to migrate MCP Tools into Rotifer Genes |
| `examples/api-apocalypse/` | API fault-tolerance experiment — baseline vs Rotifer agent with domain failover |

---

## Development

```bash
git clone https://github.com/rotifer-protocol/rotifer-playground.git
cd rotifer-playground

# TypeScript CLI
npm install
npm run build          # Build to dist/
npm test               # Run the TypeScript test suite (Vitest)
npm run lint           # Type-check and lint src/

# Rust Core (requires Rust toolchain)
cargo check -p rotifer-core
cargo test -p rotifer-core

# Full demo
bash demo.sh
```

---

## Implementation Status

> This project is in **alpha**. The table below shows the honest implementation status of each URAA layer.

| URAA Layer | Spec Name | Status | What Works | What's Planned |
|------------|-----------|--------|------------|----------------|
| **L0** | Kernel | **~35%** | `L0Gate` pre-execution checks (domain, resource, network, filesystem); Audit log | EthicalBoundary, State Anchoring, Trust Anchor |
| **L1** | Synthesis | **~95%** | WASM sandbox, IR compiler, TS→WASM compilation, native bridge | Full WASI capability negotiation |
| **L2** | Calibration | **~40%** | Schema validation, sandbox testing, `--compliance` checks | Static analysis, controlled field trial |
| **L3** | Competition | **~60%** | Arena ranking, F(g) multiplicative model, R(g) reputation, Cloud Registry | P2P HLT broadcasting (planned), hot-loading, retirement |
| **L4** | Collective Immunity | **0%** | — | Threat broadcasting, emergency rollback, cross-node consensus |
| **Algebra** | Composition | **~90%** | All 5 operators in Rust; CLI supports Seq/Par/Cond/Try | DataFlowGraph |

**Key limitation:** L4 depends on L3's P2P network, which is planned. Full L4 is targeted for v0.9+.

---

## Protocol Compliance

Targets **Rotifer Protocol Specification** (Frozen). See [Implementation Status](#implementation-status) for detailed layer-by-layer coverage.

| Depth | Components | Notes |
|-------|------------|-------|
| **Full** | Phenotype, AlgebraExpr, Fitness F(g), Arena | Core gene lifecycle |
| **Functional** | WASM Sandbox, L0 Gate, Reputation R(g) | L0 at ~35%, expanding |
| **Simplified** | Agent Lifecycle, Gene Lifecycle, RotiferBinding | MVP subset |
| **Planned** | P2P HLT, Formal Verification, Cross-Binding Consistency, ZK Proofs, L4 Immunity | Roadmap items |

Changes driven by implementation feedback are proposed through the ADR process.

---

## Roadmap

See [CHANGELOG.md](CHANGELOG.md) for detailed release history. Upcoming milestones:

- **v0.9** — P2P network (metadata discovery), economic framework design
- **v1.0** — Stable release: L0-L3 complete, economic system, security audit

---

## Community

- [Discord](https://rotifer.dev/discord) — Join the conversation
- [GitHub Discussions](https://github.com/rotifer-protocol/rotifer-playground/discussions) — Questions and proposals

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[Apache-2.0](LICENSE) with [Rotifer Safety Clause](LICENSE#rotifer-safety-clause-additional-terms)

This project uses the Apache License 2.0 with an additional **Rotifer Safety Clause** that requires any deployment to either preserve the L0 Constraint Layer or clearly disclose modifications to it.

---

**The Rotifer Protocol is alive.**
