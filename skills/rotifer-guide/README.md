# Rotifer Guide

> From zero to your first Gene in five minutes.

Interactive onboarding for [Rotifer Protocol](https://rotifer.dev) — the open-source evolution framework for AI agents.

**Not a general help desk.** Every capability here operates on Rotifer Genes and
the Rotifer CLI. It is not for general onboarding, tutorials, troubleshooting or
search — if the request is not about Rotifer, this is the wrong Skill.

## What It Does

One Skill, five capabilities — each one asks about **Rotifer**:

| Say this | It does this |
|----------|-------------|
| "How does Rotifer work?" | **Onboarding** — core concepts with hands-on CLI examples, or `rotifer hello` for a working Agent in one command |
| "Create a Rotifer Gene that checks grammar" | **Scaffold** — extracts intent, generates the Gene skeleton |
| "My Gene's F(g) is 0" / "`rotifer compile` fails" | **Doctor** — `rotifer doctor` for the toolchain first, then the Gene itself |
| "Find a Rotifer Gene for web search" | **Explorer** — `rotifer search` across the Gene registry |
| "Upgrade my Wrapped Gene to Native" | **Upgrade** — evaluates migration path, re-scans V(g) after the rewrite |

## Quick Start

Invoke it explicitly when you are working with Rotifer, then describe what you
need in natural language:

```
I want to create a Rotifer Gene that summarizes web pages
```

The Skill picks the right sub-capability and walks you through the workflow. It
does not activate on ordinary requests that happen to mention creating,
searching or diagnosing something — Rotifer has to be what you are working on.

## Core Concepts

| Concept | One-liner |
|---------|-----------|
| Gene | Self-contained logic unit: `express(input) → output` |
| Fidelity | Native > Hybrid > Wrapped — higher = more secure |
| Arena | Genes compete for ranking via F(g) fitness score |
| Domain | Two-level category like `content.grammar` |
| phenotype.json | Gene metadata (like package.json for Genes) |

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

- [rotifer-arena](https://clawhub.ai/skills/rotifer-arena) — Compare and evaluate Genes
- [rotifer-agent](https://clawhub.ai/skills/rotifer-agent) — Compose Genes into Agents
- [rotifer-self-evolving-agent](https://clawhub.ai/skills/rotifer-self-evolving-agent) — Auto-evolve your Agent

## Links

- [Rotifer Protocol](https://rotifer.dev)
- [Documentation](https://rotifer.dev/docs)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)

## License

Apache-2.0
