# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.9] - 2026-03-20

### Added

- **V(g) security scanner** — static analysis engine with 7 rules (S-01 to S-07) detecting dynamic code execution, system commands, obfuscation, external communication, env access, persistent connections, and filesystem operations
- **CLI: `rotifer vg [path]`** — run V(g) security scan on any Skill or Gene directory with `--json`, `--all`, `--id` options
- **Security grade mapping** — A/B/C/D/? grades based on finding severity (CRITICAL/HIGH/MEDIUM)
- Scanner supports `.ts`, `.js`, `.mts`, `.mjs`, `.cjs`, `.tsx`, `.jsx`, `.sh`, `.py` file extensions
- Comment-line skipping in scan results to reduce false positives
- Unit tests: scanner rules (S-01 to S-07 pattern matching) and scanner core (grade computation, file collection, edge cases)

## [0.7.8] - 2026-02-17

### Added

- **Security tests** — 5 new test files: path traversal, command injection, token safety, malicious input, credential file permissions (18 tests)
- **Resilience tests** — 4 new test files: network failure, API error handling, token expiry, config corruption (15 tests)
- **Edge case tests** — 5 new test files: Unicode names, concurrent operations, duplicate args, version handling, empty project (16 tests)
- Test coverage: 275 → **332 tests** (+57)

## [0.7.7] - 2026-02-17

### Added

- **CLI: `rotifer info <gene-id>`** — display detailed gene information (description, domain, version, fitness, reputation)
- **CLI: `rotifer list`** — list local genes in current project with optional `--domain` filter
- **CLI: `rotifer run <gene-name>`** — directly execute a single gene with WASM sandbox or Node.js fallback
- **CLI: `rotifer versions <owner> <name>`** — display version history chain for a gene
- **CLI: `rotifer whoami`** — show current authentication status
- **CLI: `rotifer stats <gene-id>`** — display download statistics for a gene
- **CLI: `rotifer compare <id...>`** — compare 2-5 genes side by side by fitness and reputation

### Changed

- **VSCode Extension v0.7.6** — full feature catch-up from v0.1.1: 26 commands, 3 tree views, 5 webview panels, OAuth auth manager

## [0.7.6] - 2026-03-19

### Fixed

- **Gene list deduplication** — `rotifer search` and VSCode extension now return only the latest version per (owner, name) pair, fixing inflated gene counts and duplicate entries
- **SQL root fix** — `search_genes` RPC uses `DISTINCT ON (owner_id, name)` CTE to deduplicate at database level

## [0.7.5] - 2026-02-17

### Added

- **Gene Domain Registry** — new `domain_registry` table reduces domain fragmentation across the ecosystem
  - `rotifer wrap` now suggests domains from local cache when `--domain` is omitted (interactive TTY selection, non-TTY auto-pick)
  - Domain format validation on `rotifer publish` (`a-z0-9` + dots only)
  - Local domain cache (`~/.rotifer/domain_registry.json`) auto-refreshed after `publish` and `install`
- **Gene Version Chain** (Spec §4.6) — `previous_version_id` and `changelog` fields on `genes` table
  - `rotifer publish --changelog "..."` stores version notes (max 500 chars)
  - `previous_version_id` auto-linked on publish (queries latest same-name gene by owner)
  - Trigger-based RLS: `previous_version_id` must reference same-owner gene
  - Backfill migration links existing multi-version genes chronologically
- **Domain suggest RPC** — `suggest_domain(description)` full-text search on `domain_registry`

### Fixed

- **Windows login compatibility** — `rotifer login` now opens the browser correctly on Windows; previously `start` treated the URL as a window title instead of a URI
- Extract `openBrowser()` utility to `src/utils/open-browser.ts` for cross-platform browser launching (win32/darwin/linux)

## [0.7.0] - 2026-03-01

### Added

- **Hybrid Gene Type** — genes can now access external networks through a controlled gateway
  - `rotifer init --fidelity hybrid` generates template with `network` config
  - `rotifer compile` supports Hybrid Gene (WASM + network declarations)
  - `rotifer publish` validates `allowedDomains` (no localhost/private IPs)
  - Network Gateway: domain whitelist, 30s timeout, 1MB response limit, 10 req/min rate limit
  - 11 unit tests for gateway security; 7 publish validation tests
- **Dogfooding: AI Documentation Assistant** — 4-Gene pipeline built with Rotifer
  - `doc-retrieval` (Hybrid) — pgvector semantic search over documentation
  - `answer-synthesizer` (Hybrid) — LLM-agnostic answer generation (Claude / OpenAI)
  - `source-linker` (Native) — maps sources to documentation URLs
  - Supabase pgvector setup with `doc_chunks` table and `match_documents` RPC
  - Document indexing script (`index-docs.ts`) for Markdown chunking + embedding
  - 8 E2E tests for 4-Gene Seq pipeline
- **IDE Plugin v1** (Cursor / VS Code)
  - Gene Explorer sidebar: search, filter, view details, install
  - One-click gene installation
  - Reputation score display per gene
  - Right-click "Publish as Rotifer Gene" for SKILL.md files
- **Gene Composition Pipeline Hardening**
  - Schema compatibility pre-check at `rotifer agent create`
  - Error propagation and pipeline interruption handling
  - Pipeline execution logging (input/output/duration per gene)
  - 5 schema compatibility tests
- **Supabase Security Audit** (Vision Roadmap D6)
  - RLS policy verification for all tables (zero bypass)
  - SECURITY DEFINER function audit (no privilege escalation)
  - WASM upload malicious payload protection
  - API authentication bypass testing
  - Reusable security test scripts

### Changed

- CLI now supports `--fidelity hybrid` in `init` and `wrap` commands
- `rotifer agent run` injects NetworkGateway for Hybrid Gene execution
- Test count: 254 → 300+ (Rust + TS combined)

[0.7.0]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.7.0

## [0.6.5] - 2026-02-27

### Added

- **RotiferBinding Trait** — protocol binding abstraction layer
  - `binding_id()`, `metering_unit()`, `capabilities()`, `execute_ir()`, `negotiate()`
  - `LocalBinding` — refactored existing WasmtimeSandbox as a binding implementation
  - `Web3MockBinding` — simulates Web3 environment constraints (Gas metering, 16MB memory, 5s timeout, no filesystem)
  - Capability Negotiation: Compatible / PartiallyCompatible / Incompatible paths
  - `IrTransferRequest` and `transfer_ir()` for cross-binding IR transfer API
- **Cross-Binding Integration Tests** — 9 tests (planned 6 + 3 bidirectional transfer)
  - Basic interop, resource over-limit rejection, optional extension functions
  - Required function missing rejection, Gas metering validation, no-IR degradation
- **IR Specification Feedback Report** — `ir-cross-binding-validation.md`

### Changed

- Rust test count: 224 → 254 (+30 binding tests)
- All existing tests pass unchanged (refactoring preserved behavior)

[0.6.5]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.6.5

## [0.6.0] - 2026-02-25

### Added

- **Gene Detail Pages** — each gene now has a dedicated page at `/genes/[name]/` with:
  - README rendering (Markdown→HTML via `marked`)
  - Phenotype schema display (inputSchema/outputSchema)
  - Stats: version, R(g), downloads, WASM size, dates
  - One-click install command copy
- **Developer Profile Pages** — each developer has a page at `/developers/[user]/` with:
  - R(d) reputation score and stats grid
  - Published gene list with links
- **Gene Registry Upgrade** — `/genes/` listing page now fetches from Cloud API
  - Client-side search (name + description fuzzy match)
  - Domain and fidelity filters
  - Sort by newest / reputation / downloads
  - Fallback to static `genes.json` if Cloud API unavailable
- **Cloud API Extensions** (Supabase Migration 004):
  - `genes.readme` column — stores gene README as Markdown text
  - `arena_history` view — gene fitness over time
  - `get_gene_stats()` RPC — download stats by time period (7d/30d/90d)
- **CLI `publish` README Support** — `rotifer publish` automatically reads and uploads `README.md`
- **5 Native Showcase Genes**:
  - `text-summarizer` (text.summarize) — extractive text summarization
  - `json-validator` (data.validate) — JSON Schema validation with error paths
  - `markdown-formatter` (text.format) — Markdown formatting normalization
  - `code-complexity` (code.analyze) — cyclomatic complexity analysis
  - `url-extractor` (text.extract) — URL extraction and categorization
- **Gene Cold Start** — 51 total genes (40 Skill Import + 5 Genesis + 5 Native showcase + 1 test)
- **Bilingual Pages** — all new pages available in English and Chinese

### Changed

- Gene detail README rendering now converts Markdown to HTML at build time using `marked`

## [0.5.5] - 2026-02-25

### Added

- **L0 Kernel Gate** — pre-execution permission enforcement
  - `L0Gate::check()` validates domain whitelist, resource limits, network and filesystem access
  - `AuditLog` — append-only execution audit trail (`.rotifer/audit.jsonl`)
  - NAPI `l0Check()` — run L0 gate checks from the CLI without executing the gene
- **WASM Sandbox Execution Path** — compiled genes now execute through the real WASM sandbox
  - NAPI `executeGene()` — accepts WASM bytes + input, returns output + `fuel_consumed` / `memory_peak_kb` / `duration_ms`
  - `rotifer test` prefers WASM sandbox for compiled genes; Node.js fallback for uncompiled genes
  - `rotifer agent run` prefers WASM sandbox; new `--no-sandbox` flag for explicit Node.js fallback
  - `rotifer arena submit` runs genes in WASM sandbox for real F(g) metrics
- **AlgebraExecutor CLI Integration** — Rust five-operator algebra engine now exposed to CLI
  - NAPI `executeAlgebra()` — accepts algebra expression JSON + gene WASM map
  - `rotifer agent create --composition <Seq|Par|Cond|Try>` — configure composition type
  - `rotifer agent create --par-merge <first|concat|merge>` — merge strategy for Par branches
- **Compliance Testing** — `rotifer test --compliance` runs 6 structural checks:
  - C1: Sandbox execution verification (sandbox_type == "wasm")
  - C2: Fuel consumption verification (fuel_consumed > 0)
  - C3: L0Gate pre-execution check pass
  - C4: Phenotype field completeness (Gene Standard)
  - C5: F(g) computability (all input metrics available)
  - C6: IR segment integrity (custom WASM sections)

### Changed

- **F(g) Fitness Formula** — switched from additive to multiplicative model (formula_version: 2)
  - Old: `(success_rate + latency_score + resource_efficiency) / 3`
  - New: `[S_r · ln(1+C_util) · (1+R_rob)] / [L · Cost]`
  - Any single zero-valued factor drives the entire score to zero (no mutual compensation)
  - Added `coverage` and `robustness` metrics (default 0.5 when unmeasured)
  - `formula_version` field enables v1/v2 coexistence in Arena
- **ConstraintSet** — added `Serialize`/`Deserialize` derives for JSON round-tripping
- Test count: 165 → 188 TS tests; 224 Rust tests (all passing)

[0.5.5]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.5.5

## [0.5.0-alpha.2] - 2026-02-24

### Added

- **Skill Import Pipeline** — convert AI IDE skills into Rotifer genes
  - `rotifer scan --skills [--skills-path <dir>]` — discover SKILL.md files with YAML frontmatter
  - `rotifer wrap <name> --from-skill <path>` — wrap a SKILL.md as a gene with phenotype
  - Metadata-only publishing: Wrapped genes upload phenotype + SKILL.md without WASM
  - Supports Cursor, Codex, and custom skill directories
  - 21 new tests (E2E + unit) for scan --skills, wrap --from-skill, and parseSkillFrontmatter
  - Skill Import Guide (EN + ZH) added to website documentation

### Changed

- Test count: 144 → 165 (21 new skill import tests)
- Website sidebar updated with Skill Import guide

[0.5.0-alpha.2]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.5.0-alpha.2

## [0.5.0-alpha.1] - 2026-02-23

### Added

- **Reputation System** — measurable trust signals for genes and developers
  - Gene reputation R(g) = α·Arena + β·Usage + γ·Stability (weights: 0.5, 0.3, 0.2)
  - Developer reputation R(d) = avg(gene reputations) + community bonus
  - Time-based decay (5%/month, floor at 0.01) prevents reputation stagnation
  - `rotifer reputation <gene-id>` — view gene reputation breakdown
  - `rotifer reputation --mine` — view your developer reputation
  - `rotifer reputation --leaderboard` — top developers ranked by reputation
  - Database migration `003_reputation.sql` with `gene_reputation` and `developer_reputation` tables
  - Server-side reputation computation via PostgreSQL functions
  - Reputation leaderboard API (`get_reputation_leaderboard()`)

- **P2P Gene Network Scaffolding** — CLI scaffolding and type definitions for future decentralized gene discovery (stub only; no libp2p integration yet)
  - P2P type system: `GeneAnnouncement`, `DiscoveryQuery`, `DiscoveryResponse`, `NodeStatus`
  - Network protocol names reserved: `/rotifer/gene-discovery/1.0.0`, `/rotifer/gene-announce/1.0.0`
  - `rotifer network start` — initialize local network config (stub; no actual P2P node)
  - `rotifer network peers` — list bootstrap peer entries (stub; no live discovery)
  - `rotifer network search` — placeholder; falls back to Cloud Registry
  - `rotifer network status` — show network configuration
  - Architecture: Cloud-first hybrid model designed; P2P layer to be implemented in a future version

- **Comprehensive Documentation** — 18 new documentation pages
  - CLI Command Reference: Gene Lifecycle, Arena, Cloud, Agent (EN + ZH)
  - Gene Development Guide (EN + ZH)
  - Composition Patterns Guide with Seq/Par/Cond/Try examples (EN + ZH)
  - Cloud Binding Guide (EN + ZH)
  - Architecture Deep-Dive Guide (EN + ZH) — URAA, Fitness, Arena, Agent lifecycle, Bindings
  - Examples: Hello Gene, HTTP Fetch, Search+Summarize Pipeline, MCP Migration (EN + ZH)
  - Updated Astro sidebar with Guides, CLI Reference, and Examples sections

### Changed

- CLI now has 20 commands (was 16): added `reputation`, `network start/peers/search/status`
- `rotifer search` now shows R(g) reputation score column
- `rotifer arena list --cloud` now shows R(g) reputation alongside F(g) and V(g)
- Rust core: added `reputation` and `p2p` modules (p2p module contains type definitions and stubs only)
- Test count: 114 → 144 (30 new tests for reputation, network scaffolding, and cloud reputation)

[0.5.0-alpha.1]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.5.0-alpha.1

## [0.4.0-alpha.1] - 2026-02-23

### Added

- **Cloud Binding** — Cross-developer gene sharing via Supabase-backed REST API
  - `rotifer login` — GitHub OAuth authentication via PKCE flow
  - `rotifer logout` — Clear cloud credentials
  - `rotifer publish <gene>` — Upload gene (phenotype + WASM) to cloud registry, saves `.cloud-manifest.json`
  - `rotifer search [query]` — Search and browse cloud gene registry
  - `rotifer install <gene-id>` — Download gene from cloud to local project
  - Cloud Binding REST API specification (`docs/cloud-binding-api.md`)
  - Supabase database schema with RLS policies (see `supabase/README.md` for self-hosting guide)

- **Cloud Arena** — Remote Arena competition across developers
  - `rotifer arena submit --cloud` — Submit gene to cloud Arena
  - `rotifer arena list --cloud` — View cloud Arena rankings
  - `rotifer arena watch --cloud` — Real-time cloud ranking updates (polling)
  - Server-side ranking via PostgreSQL `get_arena_rankings()` function

- **Endpoint-agnostic design** — CLI supports custom Cloud Binding endpoints via `--endpoint` flag or `~/.rotifer/cloud.json` config, enabling multiple deployments (global Supabase + rotifer.cloud China)

- **Supabase CLI integration** — Project linked via `supabase link`, migrations pushed via `supabase db push`

### Fixed

- OAuth login: switched from implicit flow to PKCE for secure token exchange
- Missing user profile on first login: added DB trigger `handle_new_user()` with backfill
- `rotifer publish` now saves `.cloud-manifest.json` in source gene dir for `arena submit --cloud` linkage
- `rotifer publish` graceful error when not logged in (was showing raw stack trace)

### Changed

- CLI description updated from "local development environment" to "development environment" (reflects cloud capabilities)
- Test count: 91 → 114 (23 new cloud tests)

## [0.3.0-alpha.1] - 2026-02-17

### Added

- **TS→WASM Auto-Compilation** (Javy / QuickJS)
  - `rotifer compile` auto-detects `index.ts`/`index.js` and compiles to Native WASM
  - Pipeline: TypeScript → esbuild (bundle) → WASI shim → Javy (QuickJS→WASM) → Rotifer IR
  - New `--lang <ts|wasm>` option to force compilation mode
  - `javy-compiler.ts` utility with `compileTypeScriptToWasm()`, `isJavyAvailable()`, `findGeneSource()`

- **WASI Sandbox Support** (`rotifer-core::sandbox`)
  - `WasmtimeSandbox` now supports both Direct (`express`) and WASI (`_start`) execution modes
  - Minimal WASI shim: 9 host functions (`fd_read`, `fd_write`, `clock_time_get`, etc.)
  - Auto-detection of WASI vs Direct modules at runtime

- **IR Verifier Updates**
  - SIMD instructions downgraded from error to warning (common in Javy/QuickJS output)
  - `_start` entry point accepted alongside `express` for WASI modules

### Changed

- Test coverage: 180 → 275 tests (91 TypeScript + 184 Rust)
- Documentation updated across README (EN/ZH), Getting Started (EN/ZH), and website

[0.3.0-alpha.1]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.3.0-alpha.1

## [0.2.0-alpha.1] - 2026-02-22

### Added

- **IR Compiler Pipeline** (`rotifer-core::compiler`)
  - Custom section builders: `rotifer.version`, `rotifer.phenotype`, `rotifer.constraints`, `rotifer.metering`
  - WASM injector with `irHash` computation (SHA-256 content-addressable)
  - IR verifier: static validation of exports, prohibited instructions, memory limits
  - 5 genesis WASM genes: `echo`, `wrap`, `search`, `summarize`, `translate`
  - `compile_to_ir()` API and NAPI bindings

- **CLI Upgrades**
  - `rotifer compile` — full IR compilation with `--wasm`, phenotype update, `compile-result.json`
  - `rotifer arena watch` — real-time ranking diff monitoring with summaries

- **Algebra Parallelism**
  - `Par` operator now uses true CPU parallelism via `std::thread::scope`

- **crates.io Publish**
  - `rotifer-core` published as an independent Rust crate
  - Full rustdoc coverage on all 150+ public API items

### Fixed

- `Try` operator: now correctly returns primary result on success (was re-executing)

### Changed

- Test coverage: 22 → 180 tests across 10 modules (including edge cases)
- Dependencies: added `rmp-serde`, `wasm-encoder`, `wasmparser`

[0.2.0-alpha.1]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.2.0-alpha.1

## [0.1.0-alpha.1] - 2026-02-20

### Added

- **CLI Framework**: 10 commands covering the full gene development lifecycle
  - `rotifer init` — project scaffolding with Genesis genes and Arena preview
  - `rotifer scan` — discover candidate functions from source files
  - `rotifer wrap` — wrap functions as Rotifer genes (Phenotype generation)
  - `rotifer test` — L2 sandbox testing (schema validation, conformance)
  - `rotifer compile` — Phenotype validation and gene fingerprinting
  - `rotifer arena submit` — submit genes to local Arena with admission gate
  - `rotifer arena list` — view Arena rankings with F(g), V(g), Fidelity
  - `rotifer arena watch` — placeholder for live ranking updates
  - `rotifer agent create` — create Agents with gene genomes
  - `rotifer agent list` — view all registered Agents

- **Rust Core** (`rotifer-core` crate)
  - Type system: Context, GeneResult, Phenotype, Gene, Agent, AlgebraExpr
  - WASM Sandbox via wasmtime (resource limits, fuel consumption, epoch interruption)
  - Arena Engine: local ranking with fitness-based sorting
  - Algebra Executor: Seq, Par, Cond, Try, Transform composition
  - Fitness computation: simplified F(g) model with admission threshold
  - SQLite storage: genes, agents, arena entries
  - Gene compiler: scan, wrap, schema generation
  - Agent manager: create, activate, terminate lifecycle

- **napi-rs Bridge** (`rotifer-napi` crate)
  - PlaygroundBinding facade: 10 methods bridging Rust Core to TypeScript
  - Source file scanner (TypeScript + Rust function detection)

- **5 Genesis Genes** (pre-installed with every project)
  - `genesis-web-search` — full search with multiple results
  - `genesis-web-search-lite` — lightweight single-answer search
  - `genesis-file-read` — local file reading
  - `genesis-code-format` — source code formatting
  - `genesis-l0-constraint` — L0 sandbox constraint checker

- **Developer Experience** (ADR-11)
  - Three-act Demo: Wow (30s) → Aha (5min) → Hooked (30min)
  - Rust-style error messages with codes, suggestions, and docs links
  - Automatic pre-submission testing on `arena submit`
  - Deterministic Arena rankings from Phenotype content hashing

- **Templates**: gene scaffold + Seq/Par composition examples
- **Test Suite**: 29 tests (unit + E2E) covering full lifecycle
- **demo.sh**: automated three-act demonstration script

### Protocol Compliance

Implements Rotifer Protocol Specification (Frozen):
- **Full**: Phenotype, AlgebraExpr, WASM Sandbox, Fitness F(g), Arena
- **Simplified**: Agent Lifecycle, Gene Lifecycle, RotiferBinding
- **Stub**: Formal Verification, Cross-Binding Consistency, ZK Proofs

[0.1.0-alpha.1]: https://github.com/rotifer-protocol/rotifer-playground/releases/tag/v0.1.0-alpha.1
