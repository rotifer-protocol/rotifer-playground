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

Along the way it can submit a Gene to the Arena (`rotifer arena submit`, scored on
your machine) and follow its ranking (`rotifer arena list`, `rotifer arena watch`).

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
| **Runs** | The `rotifer` CLI, pinned to `@rotifer/playground@0.36.1`. If it is not installed, `npx` fetches that exact version into npm's cache, `npm i -g` puts it in npm's global prefix, and `npm install --save-dev` keeps it inside the project. |
| **Reads** | Genes and Agent definitions in the current project. |
| **Writes in the project** | Genes into `genes/` (with their compiled output and score caches), and Agent definitions into `.rotifer/agents/`. |
| **Writes outside the project** | The CLI's own state in your home directory: `~/.rotifer/` (a local database, an audit log, a run log, the telemetry setting, and your session token if you run `rotifer login`) and `~/.config/rotifer/` (a daily update-check cache), plus the WASM runtime's compile cache in your user cache folder. Installing the CLI writes to npm's cache, or to npm's global prefix with `npm i -g`. |
| **Sends** | Registry and Arena queries to the public Rotifer API, and a package download from ClawHub for `rotifer wrap --from-clawhub`. When you are signed in, running a Gene installed from Cloud also records that invocation (the Gene id and your Agent) against your account. The CLI also sends an anonymous heartbeat each time it runs a Gene: a random machine id, the channel it ran from and the CLI version, nothing about the Gene or your files. `rotifer telemetry off`, `ROTIFER_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off; `ROTIFER_TELEMETRY=0` also stops the signed-in record. Three steps send your work, and each runs only when the user asks for it: the Web Studio scaffold path sends the description and the generated source to rotifer.ai (`/api/playground/generate`, `scan`, `publish`); `rotifer publish` uploads a Gene's source to the Rotifer Cloud Registry and makes it public; `rotifer arena submit --cloud` sends a published Gene's scores to the Cloud Arena. Without those, your code stays on this machine. |

The CLI scaffold path is the default: it is entirely local and produces the same
scaffold, so prefer it for anything you would not post publicly.

Commands that install software, send work off the machine (Path A, `rotifer publish`,
`rotifer arena submit --cloud`) or overwrite files are proposed for your approval
first, never run silently. Full detail in [SKILL.md](SKILL.md).

## Related Skills

- [rotifer-arena](https://clawhub.ai/skill/rotifer-arena) — Compare and evaluate Genes
- [rotifer-agent](https://clawhub.ai/skill/rotifer-agent) — Compose Genes into Agents
- [rotifer-self-evolving-agent](https://clawhub.ai/skill/rotifer-self-evolving-agent) — Auto-evolve your Agent

## Links

- [Rotifer Protocol](https://rotifer.dev)
- [Documentation](https://rotifer.dev/docs)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)

## License

Apache-2.0
