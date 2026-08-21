# Rotifer Arena

> Objective, quantifiable evaluation of Rotifer Genes.

Head-to-head Gene comparison in the Arena of [Rotifer Protocol](https://rotifer.dev).

**Not for general benchmarking.** Everything here operates on Rotifer Genes and
the Rotifer CLI — it does not evaluate arbitrary AI capabilities, load-test
services, or compare things that are not Genes. A ClawHub Skill can be evaluated
only by first importing it *as* a Gene, which is a step you approve.

## What It Does

Compare Rotifer Genes and produce a report you can act on:

| Say this | It does this |
|----------|-------------|
| "Evaluate the web-search skill from ClawHub as a Rotifer Gene" | Imports it as a Gene, compiles, finds the top opponent in its domain, runs the Arena evaluation |
| "Compare my two Rotifer Genes" | Head-to-head F(g) comparison with fitness breakdown |
| "Build a Rotifer Gene benchmark for this domain" | Scaffolds the scenario, creates the Genes, runs evaluation |

**Setup it does need**: a Rotifer workspace (`rotifer.json`), the CLI
(`npm i -g @rotifer/playground`), and — for Native Genes — the TS→WASM toolchain
that `rotifer doctor` checks.

Every evaluation produces a structured Markdown report with:
- **F(g)** fitness scores and ranking
- **V(g)** security assessment
- Fidelity comparison (Native vs Hybrid vs Wrapped)
- Upgrade path recommendations

## Quick Start

```
Compare my particle-brute and particle-spatial Genes
```

The Skill handles the rest: confirms both Genes exist, submits to Arena, and generates a comparison report.

## Workflow

1. **Identify target** — understand what to evaluate
2. **Compile & verify** — `rotifer compile` the Gene
3. **Match opponent** — auto-find the strongest competitor in the same domain
4. **Arena submit** — run the evaluation
5. **Generate report** — structured Markdown with scores, rankings, and next steps

## What this Skill does on your machine

It has no code of its own — it tells your assistant which `rotifer` commands to
run. That is what its manifest's process-execution, filesystem and network
permissions are for: the CLI acting, not this Skill.

| | |
|---|---|
| **Runs** | The `rotifer` CLI (`@rotifer/playground`), fetched from npm if not installed. |
| **Reads** | Genes and Agent definitions in the current project. |
| **Writes** | Compiled Gene artifacts in the project, and — only when you reply "save" — an evaluation report under `arena-reports/`. Nothing outside the project. |
| **Sends** | Arena submissions and registry queries to the public Rotifer API. Your Gene's source is not uploaded unless you run `rotifer publish` yourself. |

Full detail in [SKILL.md](SKILL.md).

## Related Skills

- [rotifer-guide](https://clawhub.ai/skills/rotifer-guide) — Learn Rotifer from scratch
- [rotifer-agent](https://clawhub.ai/skills/rotifer-agent) — Compose Genes into Agents
- [rotifer-self-evolving-agent](https://clawhub.ai/skills/rotifer-self-evolving-agent) — Auto-evolve your Agent

## Links

- [Rotifer Protocol](https://rotifer.dev)
- [Documentation](https://rotifer.dev/docs)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)

## License

Apache-2.0
