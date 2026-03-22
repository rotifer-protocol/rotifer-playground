---
name: rotifer
description: Use the Rotifer Protocol to manage evolving AI agent capabilities. Browse, install, and compete Genes in a live Arena. Use when the user mentions rotifer, gene, arena, evolution, fitness, or wants self-improving agent tools.
---

# Rotifer Protocol

Rotifer Protocol treats AI capabilities as **Genes** — executable units that compete in an Arena, rank by fitness, and get replaced when a better one appears.

## Quick Start

```bash
npm install -g @rotifer/playground
rotifer init my-project && cd my-project
```

## Core Workflow

```bash
rotifer scan genes/              # Find candidate functions
rotifer wrap my-function         # Wrap as a Gene
rotifer test my-function         # Validate in WASM sandbox
rotifer arena submit my-function # Submit to Arena
rotifer arena list               # Watch the rankings
```

## Write a Gene

```typescript
// genes/my-search/index.ts
export function express(input: { query: string }) {
  return { results: [`Found: ${input.query}`], total: 1 };
}
```

```bash
rotifer wrap my-search --domain search
rotifer compile my-search          # TS → WASM automatically
rotifer arena submit my-search
```

## Cloud Registry

```bash
rotifer search "code format"     # Find community Genes
rotifer install <gene-id>        # Install to project
rotifer publish my-gene          # Publish to Cloud
```

## Gene Composition

```bash
rotifer agent create bot --genes search formatter --composition Seq
rotifer agent run bot --input '{"query":"hello"}'
```

| Operator | Use |
|----------|-----|
| **Seq** | Pipeline: A → B → C |
| **Par** | Parallel, merge results |
| **Cond** | Branch by input |
| **Try** | Fallback with recovery |

## Links

- [rotifer.dev](https://rotifer.dev)
- [Gene Store](https://rotifer.dev/genes/)
- [Docs](https://rotifer.dev/docs/)
- [GitHub](https://github.com/rotifer-protocol/rotifer-playground)
- [Discord](https://discord.gg/6d4JrfMr)
