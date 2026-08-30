---
name: rotifer-self-evolving-agent
description: Rank an Agent's Rotifer Genes against the Arena and swap in stronger ones. Invoked explicitly via /evolve — scan local capabilities, compare Genes, inspect fitness scores, and replace weak ones with user approval. Not for capabilities outside Rotifer.
license: Apache-2.0
compatibility: Requires network access and npx to run @rotifer/mcp-server@0.17.0 for Arena rankings and Gene metadata.
metadata:
  author: rotifer-protocol
  version: "2.4.7"
  command: /evolve
  mcp-package: "@rotifer/mcp-server@0.17.0"
---

# Rotifer Self-Evolving Agent

Your Agent gets stronger by competing, not by configuring. Scan capabilities, benchmark against [Arena rankings](https://rotifer.dev), and upgrade to fitter alternatives — driven by objective performance data, not opinions.

## Runtime Integration

This skill is invoked with `/evolve` and uses the Rotifer MCP Server at runtime:

```bash
npx -y @rotifer/mcp-server@0.17.0 --tools=evolve
```

`--tools=evolve` is not decoration. The server can expose 31 tools, including
`publish_gene`, `login` and `arena_submit`; this Skill needs ten, so ten is what
it asks for. The rest are not listed and are refused if called. Nothing here can
publish on your behalf or log you in.

The launch line also omits `--allow`, so the sandbox escapes (`no_sandbox`,
`trust_unsigned`) are refused. Ten tools with an escape hatch in one of them
would not be ten tools.

## Quick Start

### Evolve Your Agent
Scan your Agent's current setup and get upgrade recommendations:
```bash
/evolve
```
This analyzes your local Agent configuration, identifies capabilities below Arena median, and recommends higher-performing replacements.

### Check Agent Status
View your Agent's capability dashboard:
```bash
/evolve status
```
Shows all installed capabilities, their fitness scores, and overall Agent health.

### Upgrade a Capability
Replace a capability with a stronger alternative:
```bash
/evolve upgrade <name>
```
Finds the top-ranked alternative in the same domain, shows you the swap, and installs it **only after you approve**. This is the one command that changes what is installed: it replaces a Gene in the project's `genes/` directory with third-party code from the marketplace, which changes what your Agent does at runtime. `create-agent` writes an Agent definition and `run-agent` executes one; every other `/evolve` command is read-only.

Genes are project files, not global ones. Install into the project the user is in — do not pass `project_root` to `install_gene` unless the user names a different project, and say which directory the Gene is going into when you propose the swap.

> **Overwriting is now undoable, so it is allowed again.** `install_gene` with
> `force: true` moves the replaced Gene into `<genes>/.snapshots/` before
> writing. Say so when you use it, and tell the user the two ways back:
> `rollback_gene` here, or `rotifer rollback <name>` in a terminal. One snapshot
> per Gene — the next overwrite of the same Gene supersedes it, and a rollback
> consumes it, so this undoes the last upgrade rather than a history.

## Discovery & Comparison

### Discover Capabilities
Find capabilities by what you need, not by internal names:
```bash
/evolve discover web scraping
/evolve discover --domain code.format
/evolve discover --fidelity Native
```

### Compare Candidates
Side-by-side fitness comparison:
```bash
/evolve compare <id-1> <id-2>
```

### Arena Rankings
See top performers in any domain:
```bash
/evolve arena search.web
/evolve arena code.format
```

### Inspect Details
Full technical details for a specific capability:
```bash
/evolve inspect <id>
```

## Agent Management

### Create a New Agent
```bash
/evolve create-agent <name>
```

### Run Your Agent
```bash
/evolve run-agent <name>
```

This **executes** the Agent's Genes — it is not a read-only command. Execution goes through the `rotifer` CLI (or an `npx -y @rotifer/playground` fallback) and stays inside the WASM sandbox. It also leaves two traces on disk: a line per Gene execution in `~/.rotifer/run-logs/<gene>.jsonl`, and a fitness state file next to the Agent definition. Both are local; neither is transmitted. **Never pass `no_sandbox`**: the server refuses it unless launched with `--allow=no-sandbox`, which this Skill does not do. Running a Gene as plain Node.js is something the user does themselves, with `rotifer agent run <name> --no-sandbox`.

## How it Works

Under the hood, Rotifer uses **Genes** — atomic, transferable AI capabilities that compete in an **Arena**. The fittest Genes (measured by the fitness function **F(g)**) rise to the top of the rankings automatically. Ranking is the automatic part; putting a Gene on your machine is not.

```text
F(g) = [S_r · ln(1 + C_util) · (1 + R_rob)] / [L · Resource_Cost]
```

No voting, no human preference — pure runtime performance metrics determine which capabilities win.

### Capability Types (Fidelity)

| Type | Description |
|------|-------------|
| **Native** | Pure WASM — fully sandboxed, highest security |
| **Hybrid** | WASM logic + controlled external calls |
| **Wrapped** | Thin envelope around an external API |

### What "Evolve" Actually Does

When you run `/evolve`, the assistant:

1. Lists your local Agent's installed Genes (`list_local_agents` + `list_local_genes`)
2. Checks each Gene's fitness against Arena rankings (`get_gene_detail` + `get_arena_rankings`)
3. Identifies Genes scoring below the domain median
4. Searches for stronger alternatives (`search_genes`)
5. Presents a ranked upgrade plan with fitness comparisons

No Gene is replaced without your confirmation.

## Security & Transparency

### Runtime dependency
This Skill runs [`@rotifer/mcp-server@0.17.0`](https://www.npmjs.com/package/@rotifer/mcp-server/v/0.17.0) via `npx` at runtime. The package is **fetched from npm on first use** and cached locally. This is a standard MCP Skill pattern but means you are trusting remote code — review the source before use.

`/evolve run-agent` is a second such path: it invokes the `rotifer` CLI, and when that is not on `PATH` it falls back to `npx -y @rotifer/playground`.

- **Source code**: [github.com/rotifer-protocol/rotifer-mcp-server](https://github.com/rotifer-protocol/rotifer-mcp-server)
- **Verify**: `npm view @rotifer/mcp-server@0.17.0 dist.integrity`

### Network requests
Gene, Arena and profile queries go to the Rotifer public API at `rotifer.dev` (hosted on Supabase). Beyond that the MCP server makes one version check per day against `registry.npmjs.org`, caching the answer in `~/.config/rotifer/update-check.json`; `npx` reaches the same registry when it fetches or refreshes a package.

**Usage telemetry.** When you are **logged in**, the MCP server reports each tool call to Rotifer Cloud, fire-and-forget: the tool's name, the Gene id the call acted on (when there is one), whether it succeeded, its latency in milliseconds, and your Rotifer user id. That is what `get_mcp_stats` reads back. Running a Gene while logged in also records that invocation, as the protocol's anti-manipulation metrics depend on it.

**Logged out, no usage record is sent.** One thing goes out either way: installing a Gene bumps that Gene's public install counter — a single request carrying the Gene id and nothing else, no user id and no session. It is how the Arena counts installs.

**`ROTIFER_TELEMETRY=0` stops all three** (`false` and `off` work too; any other value is not an opt-out). Until `0.16.1` it did not stop the install counter, and this section said "logged out, nothing is reported", which was not true of an install.

What is **not** sent: the arguments you pass, the contents of any file, your environment variables, and your local configuration. The three are `logMcpCall`, `logGeneInvocation` and the `track_download` call inside `installGene`, all in [`src/cloud.ts`](https://github.com/rotifer-protocol/rotifer-mcp-server/blob/main/src/cloud.ts) — short enough to read in full. Nothing else here reports on its own initiative: every other outbound call is a tool you invoked doing its job, the WASM artifact download, or the daily version check above.

### Credentials
Public Gene and Arena data needs no login: the MCP server reads it with the **Supabase anon key** (a public, client-safe key protected by Row Level Security). It does not read your environment variables, nor secrets belonging to any other tool.

This Skill cannot log you in: `login` is not in its tool set. If you have logged in elsewhere — `rotifer login` in a terminal — that session token lives in `~/.rotifer/credentials.json` with `0600` permissions, is sent only to the Rotifer API, and `rotifer logout` deletes it. Genes and Agents do not live there — they are project files, described below. The one other thing that lands under `~/.rotifer/` is a run log, written when you use `run-agent`; it never leaves your machine. Being logged in is what turns usage reporting on; see above.

### Local data access
- **Reads** installed Genes under `genes/`, and Agent definitions under `.rotifer/agents/` — both in the current project — to generate upgrade recommendations.
- Local configuration is **designed not to be transmitted** to any server. Comparison logic runs locally against data fetched from the public API. The only thing that leaves the machine beyond your queries is the usage record described under [Network requests](#network-requests) — tool name, Gene id, outcome, latency, user id — sent only while you are logged in, and nothing beyond it. You can verify both by inspecting the [source code](https://github.com/rotifer-protocol/rotifer-mcp-server).
- **Writes** are four things and nothing else:
  - Genes into `genes/` (`install_gene`), and the copy an overwrite replaces into `genes/.snapshots/`
  - Agent definitions into `.rotifer/agents/` (`create_agent`), and a fitness state file beside them when you run one
  - a run log at `~/.rotifer/run-logs/<gene>.jsonl` (`agent_run`) — one line per Gene execution, mode `0600`, rotated at 10 MB, never transmitted
  - the update-check cache above

  The first two are **project files, written under a project root — not into your home directory**. That root defaults to the directory the server was started in, `rotifer.json`'s `genes_dir` can rename `genes/`, and `install_gene` takes a `project_root` argument, so the destination is whichever project the call names; these commands name the current one. Nothing else on disk is modified, and no Gene is installed, replaced, or removed without explicit user confirmation.
- **An overwrite is recoverable.** `install_gene` with `force` moves the replaced copy into `<genes>/.snapshots/` before writing; `rollback_gene` restores it, and so does `rotifer rollback <name>` from a terminal — both write the same format. One snapshot per Gene: the next overwrite supersedes it, a rollback consumes it.
- Removing this Skill does **not** uninstall Genes it installed. They stay in that project's `genes/` directory as ordinary Genes; `rotifer uninstall <name>` removes one, and that is undoable through the same snapshot.

### Tool surface
The MCP server can expose 31 tools, covering compiling, publishing, Arena submission and login. This Skill launches it with `--tools=evolve`, which exposes ten:

`search_genes` · `get_gene_detail` · `get_arena_rankings` · `compare_genes` · `install_gene` · `rollback_gene` · `list_local_genes` · `list_local_agents` · `create_agent` · `agent_run`

The other 21 are not listed and are refused if called anyway, so what the assistant can reach through this Skill is the ten above and nothing else. Until version 2.4.0 all 31 were reachable — if you have an older copy, that is what it does.

The ten cover the whole surface, not just the tool list. The server also serves **resources** — read-only URIs returning the same data as tools of the same name — and those travel with the set: three of the seven (`rotifer://genes/{id}/stats`, `rotifer://developers/{name}`, `rotifer://leaderboard`) are dropped from the listing and refused if read directly, because their tools were not asked for. Until `0.16.1` they were readable whatever the tool set said. **Prompts** are not restricted, and are not meant to be: a prompt returns text and reaches nothing — no query, no file, no process.

You can check rather than take our word for it: `npx -y @rotifer/mcp-server@0.17.0 --tools=evolve` and ask it to list its tools.

### Permission justification
- `network:outbound` — query Arena rankings, Gene metadata and fitness scores from the Rotifer public API, and fetch the MCP server package itself from npm.
- `filesystem:read` — read the project's installed Genes and Agent definitions, which is what an upgrade recommendation is computed from.
- `filesystem:write` — install and roll back Genes, write Agent definitions, and append the run log and update-check cache described above.
- `process:exec` — `run-agent` executes through the `rotifer` CLI, or `npx -y @rotifer/playground` when the CLI is not installed.

Until version 2.4.3 this list said `network:outbound` and nothing else, while the Skill already read and wrote project files and shelled out to a CLI. The behaviour was described in the sections above but the declaration was narrower than the behaviour, which is the same defect as asking for ten tools and being able to reach thirty-one.

## Links

- [Creator Portal](https://rotifer.dev)
- [Capability Marketplace](https://rotifer.ai)
- [Documentation](https://rotifer.dev/docs)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)
