---
name: skill-to-gene
description: Turn your static AI skills into evolving Genes that compete, improve, and self-select in a live Arena. Use when the user wants smarter skills, self-improving agents, or mentions evolution, fitness, arena, gene, or rotifer.
---

# Skill-to-Gene

Your skills are static. Genes evolve.

**Rotifer Protocol** upgrades AI agent capabilities from fixed skill files into **Genes** — executable units that compete in an Arena, rank by fitness, and get replaced when a better one appears. No manual maintenance. No stale tools.

---

## Why upgrade from Skills to Genes?

| | Skill | Gene |
|---|---|---|
| **Updates** | Manual — you edit, you push | Autonomous — Genes mutate and compete |
| **Quality** | Trust the author | Proven in Arena — fitness-ranked |
| **Redundancy** | Multiple skills doing the same thing | Arena selects the best, eliminates the rest |
| **Safety** | Hope for the best | L0 immutable constraint layer — cannot be bypassed |
| **Composition** | Copy-paste between skills | Algebraic: Seq / Par / Cond / Try operators |
| **Isolation** | Runs in your process | WASM sandbox — zero trust execution |

---

## Get started (30 seconds)

```bash
npm install -g @rotifer/playground
rotifer init my-project && cd my-project
```

You'll see a live Arena with 5 Genesis Genes ranked by fitness. No configuration needed.

---

## Convert any function into a Gene

```bash
rotifer scan genes/              # Find candidate functions
rotifer wrap my-function         # Wrap as a Gene
rotifer test my-function         # Validate in WASM sandbox
rotifer arena submit my-function # Submit to Arena — let it compete
rotifer arena list               # Watch the rankings
```

---

## Write a Gene in TypeScript

```typescript
// genes/my-search/index.ts
export function express(input: { query: string }) {
  return { results: [`Found: ${input.query}`], total: 1 };
}
```

```bash
rotifer wrap my-search --domain search
rotifer compile my-search          # TS → WASM automatically
rotifer arena submit my-search     # Compete against existing search Genes
```

---

## Browse & install community Genes

```bash
rotifer search "code format"     # Find Genes on Cloud
rotifer install <gene-id>        # Install to your project
rotifer arena list               # See how it ranks locally
```

Browse: [rotifer.dev/genes](https://rotifer.dev/genes/)

---

## Compose Genes into Agents

```bash
rotifer agent create search-bot --genes web-search formatter --composition Seq
rotifer agent create resilient --genes primary backup --composition Try
rotifer agent run search-bot --input '{"query":"hello"}'
```

| Operator | What it does |
|----------|-------------|
| **Seq** | Pipeline: A → B → C |
| **Par** | Parallel: run all, merge results |
| **Cond** | Branch: pick Gene based on input |
| **Try** | Fallback: primary with recovery |

---

## Full CLI

| Command | Description |
|---------|-------------|
| `rotifer init` | Initialize project with Genesis Genes |
| `rotifer scan` | Find gene candidates in source code |
| `rotifer wrap` | Convert function to Gene |
| `rotifer test` | Test in WASM sandbox |
| `rotifer compile` | Compile TS → WASM → Rotifer IR |
| `rotifer arena submit` | Submit to Arena |
| `rotifer arena list` | View rankings |
| `rotifer publish` | Publish Gene to Cloud |
| `rotifer search` | Search Cloud registry |
| `rotifer install` | Install from Cloud |
| `rotifer agent create` | Build Agent from Genes |
| `rotifer agent run` | Execute Agent pipeline |

---

## Links

- [rotifer.dev](https://rotifer.dev) — Website
- [rotifer.dev/genes](https://rotifer.dev/genes/) — Gene Store
- [rotifer.dev/docs](https://rotifer.dev/docs/) — Documentation
- [GitHub](https://github.com/rotifer-protocol/rotifer-playground) — Source
- [Discord](https://rotifer.dev/discord) — Community
