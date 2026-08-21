---
name: rotifer-evolve
version: {{familyVersion}}
description: Rank an Agent's Rotifer Genes against the Arena and swap in stronger ones. Invoked explicitly via /evolve — scan local capabilities, compare Genes, inspect fitness scores, and replace weak ones with user approval. Not for capabilities outside Rotifer.
author: rotifer-protocol
---

# Rotifer Self Evolving Agent

Your Agent gets stronger by competing, not by configuring. Scan capabilities, benchmark against [Arena rankings](https://rotifer.dev), and upgrade to fitter alternatives — driven by objective performance data, not opinions.

## Runtime Integration

This plugin declares the Rotifer MCP server for you:

```bash
npx -y @rotifer/mcp-server@0.16.1 --tools=evolve
```

`--tools=evolve` is not decoration. Left undeclared, the server offers 31 tools
and 7 resources, `publish_gene`, `login` and `arena_submit` among them. Declared,
it offers **10 tools and 4 resources**. The rest are not listed and are refused
if called, so nothing here can publish on your behalf or log you in.

Resources travel with the tools they duplicate — `rotifer://developers/{name}`
returns what `get_developer_profile` returns, so it goes when that tool goes. A
restriction with an unlisted way around it is not a restriction.

The launch line also omits `--allow`, so the sandbox escapes (`no_sandbox`,
`trust_unsigned`) are refused.

## Quick Start

### Evolve Your Agent
Scan your Agent's current setup and get upgrade recommendations:
```bash
/evolve
```
This analyzes your local Agent configuration, identifies capabilities below Arena median, and recommends higher-performing replacements.

### Check Agent Status
```bash
/evolve status
```
Shows all installed capabilities, their fitness scores, and overall Agent health.

### Upgrade a Capability
```bash
/evolve upgrade <name>
```
Finds the top-ranked alternative in the same domain, shows you the swap, and installs it **only after you approve**. This is the one command that changes what is installed: it replaces a Gene in the project's `genes/` directory with third-party code from the marketplace, which changes what your Agent does at runtime.

Genes are project files, not global ones. Install into the project the user is in, and say which directory the Gene is going into when you propose the swap.

> **An overwrite is undoable.** Replacing a Gene moves the old copy into
> `<genes>/.snapshots/` first. Tell the user the two ways back: `rollback_gene`
> here, or `rotifer rollback <name>` in a terminal. One snapshot per Gene — the
> next overwrite supersedes it and a rollback consumes it, so this undoes the
> last upgrade rather than a history.

## Discovery & Comparison

### Discover Capabilities
```bash
/evolve discover web scraping
/evolve discover --domain code.format
/evolve discover --fidelity Native
```

### Compare Candidates
```bash
/evolve compare <id-1> <id-2>
```

### Arena Rankings
```bash
/evolve arena search.web
/evolve arena code.format
```

## How it Works

Under the hood, Rotifer uses **Genes** — atomic, transferable AI capabilities that compete in an **Arena**. The fittest Genes (measured by the fitness function **F(g)**) rise to the top of the rankings automatically. Ranking is the automatic part; putting a Gene on your machine is not.

```text
F(g) = [S_r · ln(1 + C_util) · (1 + R_rob)] / [L · Resource_Cost]
```

No voting, no human preference — pure runtime performance metrics determine which capabilities win.

## Security & Transparency

### Runtime dependency
The MCP server is fetched from npm on first use and cached. That is a standard
pattern, but it means you are trusting remote code — review the source, or check
`npm view @rotifer/mcp-server@0.16.1 dist.integrity`, before use.

- **Source**: [github.com/rotifer-protocol/rotifer-mcp-server](https://github.com/rotifer-protocol/rotifer-mcp-server)

### What leaves your machine
Gene and Arena queries go to the public Rotifer API. Beyond that the server
makes one npm version check per day.

**Usage reporting.** When you are **signed in**, each tool call is reported to
Rotifer Cloud: the tool's name, the Gene id it acted on, whether it succeeded,
its latency, and your user id. Running a Gene while signed in records that too.

**Signed out, no usage record is sent** — but installing a Gene bumps that
Gene's public install counter either way, one request carrying the Gene id and
no identity. `ROTIFER_TELEMETRY=0` (or `false`/`off`) stops all three.

Not sent: the arguments you pass, file contents, your environment variables, or
your local configuration.

### What changes on disk
- **Genes** into the project's `genes/`, and the copy an overwrite replaces into `genes/.snapshots/`
- **Agent definitions** into `.rotifer/agents/` in the current project, plus a fitness file when you run one
- **A run log** at `~/.rotifer/run-logs/<gene>.jsonl` when an Agent runs — local, never transmitted
- **An update-check cache** at `~/.config/rotifer/update-check.json`

Nothing else on disk is modified, and no Gene is installed, replaced or removed
without explicit confirmation. Removing this plugin does not uninstall Genes it
installed; `rotifer uninstall <name>` removes one, and that is undoable through
the same snapshot.

### Credentials
Public Gene and Arena data needs no login. This Skill cannot sign you in —
`login` is not in its tool set. If you signed in elsewhere, that token lives in
`~/.rotifer/credentials.json` with `0600` permissions and is sent only to the
Rotifer API. Being signed in is what turns usage reporting on.

## Links

- [Creator Portal](https://rotifer.dev)
- [Capability Marketplace](https://rotifer.ai)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)
- [MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server)
