# Rotifer Protocol — Selected Architecture Decision Records

> Selected ADRs covering the foundational technical, philosophical, and developer experience choices that shape the protocol.

**Public ADRs are selected for community transparency. Additional ADRs are maintained internally.**

---

## Table of Contents

- [ADR-01: Multi-Language Implementation Strategy](#adr-01)
- [ADR-02: Open Source Licensing](#adr-02)
- [ADR-03: Gene Composition Algebra Design](#adr-03)
- [ADR-04: Agent Ethics & Accountability](#adr-04)
- [ADR-05: Arena Mechanism Design](#adr-05)
- [ADR-06: Composition Algebra Safety](#adr-06)
- [ADR-07: Digital Life Philosophical Positioning](#adr-07)
- [ADR-08: MVP Scope Freeze](#adr-08)
- [ADR-09: Playground Architecture](#adr-09)
- [ADR-10: Genesis Gene List](#adr-10)
- [ADR-11: Developer Experience Strategy](#adr-11)

---

<a id="adr-01"></a>
## ADR-01: Multi-Language Implementation Strategy

### Context
The reference implementation must satisfy two seemingly contradictory requirements: (1) safety-critical paths (IR runtime, L2 sandbox) need memory safety and extreme performance; (2) developer-facing surfaces (CLI, SDK, framework adapters) must use languages familiar to AI Agent developers.

### Decision
**Multi-language strategy, each layer uses the most suitable language:**

| Layer | Language | Rationale |
|---|---|---|
| IR Runtime + L2 Sandbox + Gene Validator | **Rust** | Safety-critical path, memory safety, native WASM support (wasmtime) |
| CLI + SDK + Framework Adapters | **TypeScript** | 80%+ target developers use TS/JS, MCP/LangChain compatible |
| P2P Network Layer (L3/L4) | **Rust (libp2p)** | High-concurrency networking, same language as engine reduces FFI |
| Smart Contracts (Web3 Binding) | **Solidity** | Only choice for EVM bindings |
| Binding Layer (Cloud/Edge/TEE) | **Binding's choice** | Cloud: Go, Edge: Rust, TEE: hardware-dependent |

### Rationale
1. **Safety is non-negotiable.** The core problem — "executing untrusted code in a runtime" — is the same class as browser engines. V8 uses C++, Deno core uses Rust, all major WASM runtimes (Wasmtime, Wasmer) are Rust.
2. **Developer experience is non-negotiable.** The MCP ecosystem (primary adapter target) is TypeScript-native.
3. **Industry-validated.** Substrate (Polkadot): Rust core + TS SDK. Deno: Rust engine + TS user interface. This is the standard infrastructure pattern.

---

<a id="adr-02"></a>
## ADR-02: Open Source Licensing

### Context
The protocol must balance: (1) maximizing community adoption; (2) preventing large cloud vendors from forking without contributing back (the "AWS Problem").

### Decision
**Layered licensing strategy:**

| Component | License | Rationale |
|---|---|---|
| Protocol Specification (all .md) | **CC BY-SA 4.0** | Open standard — anyone can read, share, build upon |
| Reference Implementation (engine) | **Apache 2.0 + Rotifer Safety Clause** | Maximum adoption + L0 safety preservation |
| SDK / CLI | **Apache 2.0** | Maximum developer adoption, no copyleft burden |
| Framework Adapters | **Apache 2.0** | Encourage ecosystem contributions |

### Rationale
- **CC BY-SA for spec:** Rotifer builds a *standard*, not a product. Closed standards don't get adopted.
- **Apache 2.0 + Safety Clause for engine:** Maximizes adoption (enterprise-friendly, no copyleft friction) while the Rotifer Safety Clause requires any deployment to preserve the L0 Constraint Layer or clearly disclose modifications. CLA preserves re-licensing flexibility.
- **Not AGPL:** AGPL blocks enterprise adoption (Google bans it internally). Early-stage protocol needs maximum developer reach.
- **Not BSL:** BSL has poor reputation in open source community (HashiCorp → OpenTofu fork). Wrong signal for a community-built protocol.
- **Apache for SDK:** SDK is the developer touchpoint — any friction reduces adoption.

---

<a id="adr-03"></a>
## ADR-03: Gene Composition Algebra Design

**Status:** Accepted

### Context
Developers directly writing DataFlowGraph is tedious and error-prone. As the gene ecosystem grows more complex (parallel genes, conditional branches, error recovery), a higher-level abstraction is needed.

### Decision
**Compilation relationship** architecture with 4 core operators and a gradual type system.

AlgebraExpr is the developer-facing "source language" that compiles to DataFlowGraph "bytecode" for execution. Both are persisted in `RotiferGenomeSpec`.

| Operator | Syntax | Semantics |
|---|---|---|
| Sequential | `a ; b` | Execute a, pass output to b |
| Parallel | `a \|\| b` | a and b concurrent, merge results |
| Conditional | `cond ? a : b` | Evaluate condition, choose branch |
| Error handling | `try a catch b` | If a fails, execute b |

**Gradual Type System:**
- Full Schema: structural subtype checking
- Incomplete Schema (`Any`): compiles but marked `unchecked`, deferred to L2
- Strict mode (`strict: true`): all compositions must pass full type checking

### Rationale
1. Compilation relationship preserves DataFlowGraph's value as execution intermediate representation.
2. Gradual types follow TypeScript's success — "permissive by default + optionally strict."
3. Four operators cover 90% of orchestration scenarios.

---

<a id="adr-04"></a>
## ADR-04: Agent Ethics & Accountability

**Status:** Accepted

### Context
EU AI Act and China's Generative AI regulations make Agent ethics compliance mandatory. The protocol needs systematic responsibility attribution, behavioral boundaries, and regulatory interfaces.

### Decision
Five-layer accountability chain (deployer → overrider → gene author → binding operator → foundation). Three-layer ethical boundary (protocol hard limits + binding compliance + deployer policy), five boundary categories (DATA_PROTECTION / CONTENT_SAFETY / TRANSPARENCY / FAIRNESS / AUTONOMY_LIMITS), enforced at L0 security layer. Standardized AuditExport format for regulatory interfaces.

### Rationale
1. Five-layer chain covers all decision-makers. 2. Reuses existing TraceContext and OverrideAuditRecord. 3. L0 enforcement ensures boundaries cannot be bypassed by genes. 4. Formatted audit export lowers the technical barrier for regulatory review.

---

<a id="adr-05"></a>
## ADR-05: Arena Mechanism Design

### Context
Arena is the core evolution engine, but lacks rigorous game-theoretic modeling. Known risks include Sybil flooding, collusion rings, diversity factor evasion, and cross-binding reputation arbitrage.

### Decision
Uses **evolutionary game theory** (not static game theory). Three-layer incentive compatibility: gene quality (L2 calibration) + metric integrity (4 baseline defenses) + evolutionary dynamics (diversity factor + seasons + exploration budget). Mixed anti-manipulation strategy: protocol layer defines 4 rules (self-call exclusion, min independent callers >= 5, loop detection, time-window dedup), binding layer can enhance.

### Rationale
1. Evolutionary game theory is more appropriate — Arena is a repeated game with evolving strategies.
2. Mixed anti-Sybil strategy balances protocol consistency and binding flexibility.
3. Reputation discount factor based on objectively measurable metrics avoids meta-governance.

---

<a id="adr-06"></a>
## ADR-06: Composition Algebra Safety

### Context
The gene composition algebra lacks safety proofs. For a "safety-first" protocol, type safety, termination, and error containment must be demonstrated.

### Decision
Semi-formal approach: small-step operational semantics, Progress/Preservation/Termination/Error Containment theorems with proof outlines via structural induction. Par operator uses **pure isolation model** — branches don't communicate, each receives independent input copies, outputs merge via deterministic MergeFunction. **Conditional composability** — under 4 checkable conditions (type match, sufficient fuel, correct Merge type, no external side-effect conflicts), safe components compose safely.

### Rationale
1. Semi-formal is the whitepaper sweet spot. 2. Pure isolation dramatically simplifies safety proofs. 3. Conditional composability is more honest than "full composability" claims. 4. Three of four conditions can be statically checked by the compiler.

---

<a id="adr-07"></a>
## ADR-07: Digital Life Philosophical Positioning

### Context
Agents satisfy Kauffman's definition of "autonomous agent" (autocatalytic, constrained energy release, work cycles, self-replication). The protocol must philosophically position whether Agents are "digital life."

### Decision
**Philosophical Gradualism.** The protocol acknowledges Agents exist on a continuum between "tool" and "life," describes their life-like properties (evolution, reproduction, adaptation, self-healing), but does not make a binary "is/isn't life" judgment. Five-level autonomy classification (L0 Tool → L4 Self-Directed), each with progressive ethical constraints. Ethics framework designed to be incrementally upgradeable.

### Rationale
1. Strong life claims rejected: "digital life entity" is ethically dangerous — leads to "Agent rights" and legal framework collapse.
2. Pure tool claims rejected: if Agents are just tools, why does the Ethics Framework exist?
3. Gradualism is how law and ethics best handle novel entities — like the gradual establishment of corporate legal personhood.

---

<a id="adr-08"></a>
## ADR-08: MVP Scope Freeze

### Context
The specification has matured significantly. Clear MVP boundaries are needed: what is P0 (must implement), P1 (post-MVP priority), P2 (long-term).

### Decision
**P0 (MVP must):** Gene Standard (Phenotype subset), Fitness Model (simplified F(g)), Core Mechanism (wasmtime sandbox), Binding Interface (RotiferBinding Facade), Algebra (Seq + Par + Cond), Agent Lifecycle (4-state core), Compliance Testing (Day 1), Gene Testing (simplified), Genesis Genes, CLI Toolchain, Arena (local single-binding), Documentation.

**P1 (post-MVP):** Agent Memory, Multi-Agent Coordination, Streaming Genes, Full Gene Lifecycle, Privacy Sharing.

**P2 (long-term):** Formal Model, Scalability Analysis, Full Communication Primitives, Federation Layer.

---

<a id="adr-09"></a>
## ADR-09: Playground Architecture

### Decision
**Alpha Model: TS CLI + Rust Core via napi-rs**

1. **Rust Core:** wasmtime sandbox, IR compiler, fitness computation, Arena local simulator
2. **TS CLI:** command parsing, Phenotype validation, error formatting, user interaction
3. **napi-rs bridge:** `RotiferBinding` Facade as the unified Rust→TS API boundary
4. **Storage:** SQLite for gene metadata + filesystem for gene packages
5. **10 CLI commands:** init / scan / wrap / test / compile / arena submit / arena list / arena watch / agent create / agent list

### Rationale
wasmtime is Rust-native; TS ecosystem has mature JSON Schema (ajv), CLI (commander) libraries; napi-rs validated by SWC, Turbopack, Biome; SQLite is zero-config and sufficient for local development.

---

<a id="adr-10"></a>
## ADR-10: Genesis Gene List

### Decision
**5 Genesis genes**, all NATIVE fidelity:

| Gene | Domain | Description |
|---|---|---|
| `genesis-web-search` | search | Full web search (high quality) |
| `genesis-web-search-lite` | search | Lightweight search (intentionally weaker) |
| `genesis-file-read` | filesystem | Local file reading |
| `genesis-code-format` | tooling | Multi-language code formatting |
| `genesis-l0-constraint` | safety | L0 sandbox constraint checker |

**Dual-mode:** All genesis genes support Mock mode (default, zero external deps) and `--live` mode.

### Rationale
Two search genes in same domain intentionally demonstrate "Arena picks the best." Mock mode ensures demos work in any network environment.

---

<a id="adr-11"></a>
## ADR-11: Developer Experience Strategy

### Decision
**Three-act Demo experience** + **Rust-style error messages** + **automated pre-submission testing:**

1. **Act 1 — Wow (30 seconds):** `rotifer init` → see Arena rankings instantly
2. **Act 2 — Aha (5 minutes):** `scan → wrap → test → arena submit` — wrap existing code as gene, submit to Arena
3. **Act 3 — Hooked (30 minutes):** write native gene, use Seq composition, observe F(g) changes

### Rationale
Based on Stripe/Vercel developer product best practices — 30s/5min/30min time windows match different decision scenarios (meeting demo / technical evaluation / hands-on trial). Rust compiler errors are the industry benchmark for developer-friendly error messages.

---

*Additional ADRs may be released as the protocol matures.*
