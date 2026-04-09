# Rotifer Playground

[![CI](https://github.com/rotifer-protocol/rotifer-playground/actions/workflows/ci.yml/badge.svg)](https://github.com/rotifer-protocol/rotifer-playground/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rotifer/playground)](https://www.npmjs.com/package/@rotifer/playground)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org/)
[![Protocol](https://img.shields.io/badge/Protocol-Frozen-orange)](https://github.com/rotifer-protocol/rotifer-spec)
[![Discord](https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white)](https://rotifer.dev/discord)

Build AI agents from composable **Genes** — modular, fitness-ranked, sandbox-executed skill units. One command gives you a working agent; the Arena decides which genes survive.

> **Status:** v0.8.5 — public playground for gene development, Arena competition, and agent composition. See [CHANGELOG.md](CHANGELOG.md) for release history. P2P discovery and L4 Collective Immunity are planned — see [Implementation Status](#implementation-status).

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

## First Agent in 30 Seconds

```bash
npm install -g @rotifer/playground   # or: npx @rotifer/playground init my-project
rotifer init my-project && cd my-project
rotifer hello                        # pick a template → agent runs immediately
```

`rotifer init` bootstraps the Arena with 5 Genesis genes ranked by fitness.
`rotifer hello` turns them into a working agent — no config, no boilerplate.

---

## `rotifer hello` — Agent Templates

Six curated templates ship with every project. Each one creates an agent, wires the right genes, and runs in one step:

**Quick Start** (works instantly, no setup)

| Template | What it does | Example |
|----------|-------------|---------|
| `quality-advisor` | Diagnose & optimize your gene library | `rotifer hello --template quality-advisor --dir ./genes` |
| `uiux-diagnosis` | Catch AI-generated-looking UI patterns | `rotifer hello --template uiux-diagnosis --file page.html` |
| `content-analysis` | Analyze articles for virality signals | `cat draft.md \| rotifer hello --template content-analysis` |
| `code-security` | Find vulnerabilities in gene code | `rotifer hello --template code-security --dir ./genes` |

**Power Templates** (may need API key or domain knowledge)

| Template | What it does | Badge |
|----------|-------------|-------|
| `doc-qa` | Ask your docs, get cited answers | API key |
| `web3-toolkit` | Contract audit + chain data analysis | Web3 |

```bash
rotifer hello --list-templates       # see all templates with descriptions
rotifer hello                        # interactive TUI — pick and run
rotifer hello --template doc-qa      # skip TUI, go straight to a template
```

Each `hello` agent is persisted as `hello-<template>` under `.rotifer/agents/` and reused on repeat runs.

---

## Three-Act Experience

### Act 1 — Wow (30 seconds)

```bash
rotifer init my-project && cd my-project
rotifer hello
```

You see an Arena with 6 genes ranked by fitness, pick a template, and an agent runs. No configuration.

### Act 2 — Aha (5 minutes)

```bash
rotifer agent list                 # inspect the hello-* agent that was created
rotifer agent run hello-quality-advisor --input '{"verbose":true}'
rotifer arena list                 # see gene rankings
```

Agents are JSON records with a **genome** — an ordered list of genes composed via algebra operators.

### Act 3 — Hooked (30 minutes)

Write a gene in TypeScript, compile to WASM, and compose a custom agent:

```bash
mkdir genes/my-search && cat > genes/my-search/index.ts << 'EOF'
export function express(input: { query: string }) {
  return { results: [`Found: ${input.query}`], total: 1 };
}
EOF

rotifer wrap my-search --domain search
rotifer compile my-search             # TS → JS → WASM → Rotifer IR
rotifer test my-search --compliance   # sandbox + structural checks
rotifer arena submit my-search        # watch it climb the rankings

# Compose a multi-gene agent
rotifer agent create search-bot --genes genesis-web-search my-search
rotifer agent run search-bot --input '{"query":"rotifer protocol"}'

# Or use parallel composition with fault tolerance
rotifer agent create resilient-bot --genes web-search doc-search --composition TryPool
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

Run `rotifer --help` for the grouped command list.

### Agent Workflow

| Command | Description |
|---------|-------------|
| `rotifer hello [--template <id>]` | Create and run a preset agent from curated templates |
| `rotifer agent create <name>` | Create an Agent (`--composition Seq\|Par\|Cond\|Try\|TryPool`) |
| `rotifer agent list` | List all agents in the project |
| `rotifer agent run <name>` | Execute genome pipeline (WASM sandbox, `--no-sandbox` for Node.js) |

### Gene Lifecycle

| Command | Description |
|---------|-------------|
| `rotifer init [name]` | Initialize a new gene project with Genesis genes |
| `rotifer scan [path]` | Scan for candidate genes and local skills |
| `rotifer wrap <gene>` | Wrap a function or SKILL.md as a gene |
| `rotifer test [gene]` | Test a gene (sandbox + `--compliance` for structural checks) |
| `rotifer compile [gene]` | Compile gene to Rotifer IR (auto TS → WASM) |
| `rotifer run <gene>` | Execute a single local gene directly |
| `rotifer list` | List local genes |
| `rotifer vg [path]` | V(g) security scan for gene/skill code |

### Arena & Cloud

| Command | Description |
|---------|-------------|
| `rotifer arena submit <gene>` | Submit a gene to the Arena (`--cloud` for Cloud Arena) |
| `rotifer arena list` | List Arena rankings (`--cloud` for Cloud Arena) |
| `rotifer arena watch <domain>` | Watch Arena rankings live |
| `rotifer publish [gene]` | Publish gene(s) to Rotifer Cloud |
| `rotifer search [query]` | Search genes on Rotifer Cloud |
| `rotifer install <ref>` | Install a gene from Cloud (UUID, name, or content hash) |
| `rotifer info <ref>` | View gene details (local or Cloud) |
| `rotifer stats <ref>` | View download statistics |
| `rotifer compare [refs...]` | Compare 2–5 genes by reputation and downloads |
| `rotifer reputation [ref]` | View gene and creator reputation scores |
| `rotifer versions <owner> <gene>` | View version history chain |

### System

| Command | Description |
|---------|-------------|
| `rotifer login` / `logout` | Rotifer Cloud OAuth (GitHub/GitLab) |
| `rotifer whoami` | Show current authentication status |
| `rotifer api-key create\|list\|revoke` | Manage Evolution API keys |
| `rotifer config get\|set\|list` | Manage global configuration |
| `rotifer network` | P2P gene network commands (stub — full P2P in v0.9) |
| `rotifer self-update` | Check for updates and upgrade Rotifer packages |

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

## AI IDE Integration

Install the [MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server) to let your AI assistant search genes, compose agents, and run pipelines from within the IDE:

```json
{
  "mcpServers": {
    "rotifer": {
      "command": "npx",
      "args": ["@rotifer/mcp-server"]
    }
  }
}
```

Works with Cursor, Claude Desktop, Windsurf, and any MCP-compatible client. See [@rotifer/mcp-server](https://github.com/rotifer-protocol/rotifer-mcp-server) for the full tool list.

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
