# Rotifer Protocol

You are an expert in the Rotifer Protocol — a framework where AI agent capabilities are treated as **Genes** that compete in an Arena, rank by fitness, and evolve through natural selection.

## When to use this skill

Use when the user wants to:
- Install or manage AI agent capabilities that self-improve
- Create, test, or publish Genes
- Compose Genes into Agent pipelines
- Browse or search the Gene Cloud Registry

## Installation

```bash
npm install -g @rotifer/playground
```

Verify: `rotifer --version`. Requires Node.js >= 20.0.0.

## Core Workflow

### Initialize an Agent workspace

```bash
rotifer init my-agent && cd my-agent
```

Creates an Agent workspace with 5 Genesis Genes and a live Arena ranking.

### Create a Gene from existing code

```bash
rotifer scan genes/              # Find candidate functions
rotifer wrap my-function         # Wrap as a Gene
rotifer test my-function         # Validate in WASM sandbox
rotifer arena submit my-function # Submit to Arena
rotifer arena list               # Watch the rankings
```

### Write a Gene in TypeScript

```typescript
// genes/my-search/index.ts
export function express(input: { query: string }) {
  return { results: [`Found: ${input.query}`], total: 1 };
}
```

```bash
rotifer wrap my-search --domain search
rotifer compile my-search          # TS → WASM automatically
rotifer arena submit my-search     # Compete against existing Genes
```

### Browse and install community Genes

```bash
rotifer search "code format"     # Find Genes on Cloud
rotifer install <gene-ref>        # Install to your Agent workspace
rotifer arena list               # See how it ranks locally
```

### Compose Genes into Agents

```bash
rotifer agent create search-bot --genes web-search formatter --composition Seq
rotifer agent create resilient --genes primary backup --composition Try
rotifer agent run search-bot --input '{"query":"hello"}'
```

## Composition Operators

| Operator | What it does |
|----------|-------------|
| **Seq** | Sequential pipeline: A → B → C |
| **Par** | Parallel execution, merge results |
| **Cond** | Conditional branch based on input |
| **Try** | Fallback: primary with recovery |

## Key Concepts

- **Gene**: Executable capability unit with typed I/O, runs in WASM sandbox
- **Arena**: Competition ground where same-domain Genes fight on fitness
- **Fitness F(g)**: correctness × latency × efficiency × diversity
- **Fidelity**: Native (WASM) vs Wrapped (prompt template) vs Hybrid (WASM + network)
- **L0 Constraint**: Immutable safety layer that no Gene can bypass

## Full CLI Reference

| Command | Description |
|---------|-------------|
| `rotifer init` | Initialize an Agent workspace with Genesis Genes |
| `rotifer scan` | Find gene candidates in source code |
| `rotifer wrap` | Convert function to Gene |
| `rotifer test` | Test in WASM sandbox |
| `rotifer compile` | Compile TS → WASM → Rotifer IR |
| `rotifer arena submit` | Submit to Arena |
| `rotifer arena list` | View rankings |
| `rotifer arena watch` | Watch rankings live |
| `rotifer login` | Log in to Rotifer Cloud |
| `rotifer publish` | Publish Gene to Cloud |
| `rotifer search` | Search Cloud registry |
| `rotifer install` | Install from Cloud |
| `rotifer agent create` | Build Agent from Genes |
| `rotifer agent run` | Execute Agent pipeline |

## Links

- Website: https://rotifer.dev
- Gene Store: https://rotifer.dev/genes/
- Documentation: https://rotifer.dev/docs/
- Source: https://github.com/rotifer-protocol/rotifer-playground
- Discord: https://rotifer.dev/discord
