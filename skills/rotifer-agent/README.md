# Rotifer Agent

> From intent to running Agent in seven steps.

Build a Rotifer Agent by composing [Genes](https://rotifer.dev/docs) — the atomic, fitness-evaluable capability units of [Rotifer Protocol](https://rotifer.dev).

**Not a general agent framework.** This composes Rotifer Genes into a Rotifer
Genome, through the Rotifer CLI. It does not build agents for LangChain, CrewAI
or anything else, and the words Seq / Par / Cond / Try name Genome composition
strategies here — seeing them in ordinary code is not a reason to invoke it.

## What It Does

Say what the Agent should do **in Rotifer terms**, and this Skill handles the architecture:

| Say this | It does this |
|----------|-------------|
| "Build a Rotifer Agent that checks document quality" | Decomposes into grammar + readability + tone Genes, recommends Par composition |
| "Compose Rotifer Genes into a code review Agent" | Selects security-auditor + code-complexity + docs-writer, designs a Seq(Par, …) Genome |
| "Make a Rotifer Genome for search and summarize" | Picks web-search → summarizer → formatter, wires up Seq |

## The Seven Phases

1. **Intent decomposition** — break the goal into 2-6 capability units
2. **Gene selection** — find the fittest Gene for each unit from Arena rankings
3. **Gap filling** — create missing Genes (route to gene → dev module)
4. **Genome composition** — choose Seq / Par / Cond / Try / TryPool
5. **Agent creation** — `rotifer agent create`
6. **Test run** — `rotifer agent run` with validation checklist
7. **Iteration** — swap underperforming Genes, tune composition

## Composition Strategies

| Strategy | Semantics | Use when |
|----------|-----------|----------|
| **Seq(A, B, C)** | Pipeline: A → B → C | Output of one feeds the next |
| **Par(A, B)** | Parallel: run simultaneously | Independent tasks, merge results |
| **Cond(p, A, B)** | Branch: if p then A else B | Input determines the path |
| **Try(A, B)** | Fallback: A fails → B | Primary path unreliable |
| **TryPool(A, B, C)** | Race: all try, first wins | Multiple equivalent implementations |

## Quick Start

```
Build a Rotifer Agent that checks document quality — grammar, readability, and tone
```

The Skill decomposes the intent, finds top-ranked Genes, and creates the Agent.

## What this Skill does on your machine

It has no code of its own — it tells your assistant which `rotifer` commands to
run. That is what its manifest's process-execution, filesystem and network
permissions are for: the CLI acting, not this Skill.

| | |
|---|---|
| **Runs** | The `rotifer` CLI (`@rotifer/playground`), fetched from npm if not installed. |
| **Reads** | Genes and Agent definitions in the current project. |
| **Writes** | Genes into the project's `genes/`, Agent definitions into `.rotifer/agents/`. Nothing outside the project. |
| **Sends** | Registry and Arena queries to the public Rotifer API. Your code is not uploaded unless you run `rotifer publish` yourself. |

Commands that install, publish or overwrite are proposed for your approval
first, never run silently. Full detail in [SKILL.md](SKILL.md).

## Related Skills

- [rotifer-guide](https://clawhub.ai/skills/rotifer-guide) — Learn Rotifer from scratch
- [rotifer-arena](https://clawhub.ai/skills/rotifer-arena) — Compare and evaluate Genes
- [rotifer-self-evolving-agent](https://clawhub.ai/skills/rotifer-self-evolving-agent) — Auto-evolve your Agent

## Links

- [Rotifer Protocol](https://rotifer.dev)
- [Documentation](https://rotifer.dev/docs)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)

## License

Apache-2.0
