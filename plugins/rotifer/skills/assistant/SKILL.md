---
name: rotifer-assistant
version: 0.8.2
description: Unified entry point for Rotifer Protocol — guide, architect, and challenge your agents
author: rotifer-protocol
---

# Rotifer Assistant

Describe your need, and I'll route you to the right module.

## /guide — Understand Rotifer Protocol

**Core Concepts in 60 Seconds**

Rotifer Protocol models software capabilities as **Genes** — modular, fitness-evaluable logic units that evolve through competition.

### Key Abstractions

| Concept | What it means |
|---------|--------------|
| **Gene** | A unit of capability with `express(input) → output` |
| **Genome** | An ordered set of genes that form an Agent |
| **Agent** | A genome + composition strategy |
| **Arena** | Competitive evaluation — genes prove fitness |
| **Binding** | Execution environment (Local, Cloud, Web3) |

### Fidelity Levels

| Level | Runs code? | Network? | Use case |
|-------|-----------|----------|----------|
| **Native** | ✅ WASM sandbox | ❌ | Pure computation |
| **Hybrid** | ✅ Node.js | ✅ Controlled | API-dependent logic |
| **Wrapped** | ❌ Prompt only | ❌ | AI-native guidance |

### Quick Commands

```
rotifer init my-project     # Scaffold a project
rotifer hello               # Interactive agent builder
rotifer gene list            # See installed genes
rotifer search <keyword>     # Find genes
```

→ Ready to build? Try **/architect**

## /architect — Design Your Agent

**From idea to running Agent in 3 steps.**

### Step 1: Find Genes

```
rotifer search security     # Find security-related genes
rotifer search content       # Find content analysis genes
```

Browse the [Gene Marketplace](https://rotifer.ai) for community genes.

### Step 2: Create Agent

```
# Sequential pipeline (each gene feeds the next)
rotifer agent create my-auditor --genes solidity-parser vuln-detector audit-reporter

# Parallel execution (all genes run simultaneously)
rotifer agent create my-scanner --genes security-scanner code-complexity --composition Par

# Failover (try primary, fall back to secondary)
rotifer agent create my-search --genes sirchmunk-search genesis-web-search --composition Try
```

### Step 3: Run & Iterate

```
rotifer agent run my-auditor --input '{"source": "..."}'
rotifer agent run my-auditor --verbose   # See intermediate results
rotifer agent run my-auditor --input '{"source": "..."}' --json  # Machine output
```

### Composition Types

| Type | Pattern | When to use |
|------|---------|------------|
| `Seq` | A → B → C | Pipeline processing |
| `Par` | A ∥ B ∥ C | Independent analysis |
| `Cond` | if P then A else B | Branching logic |
| `Try` | A catch B | Graceful degradation |
| `TryPool` | Best of {A, B, C} | Competitive selection |

→ Want to compare performance? Try **/challenge**

## /challenge — Arena Evaluation

**Let your genes compete. The fittest survive.**

### Submit to Arena

```
rotifer arena submit my-gene
```

Your gene will be evaluated against others in the same domain using the fitness function:

```
F(g) = (S_r × log(1+C_util) × (1+R_rob)) / (L × R_cost)
```

### Watch Live Rankings

```
rotifer arena watch           # Live leaderboard
rotifer arena watch --domain code.security  # Filter by domain
```

### Head-to-Head Comparison

```
rotifer compare gene-a gene-b --input '{"test": "data"}'
```

Side-by-side execution with timing, output diff, and fitness delta.

### Improvement Loop

1. Submit → see ranking
2. Identify weaknesses (low robustness? high cost?)
3. Upgrade fidelity: `rotifer compile my-gene` (Wrapped → Native)
4. Re-submit → compare improvement

→ New to the protocol? Start with **/guide**
