# Rotifer Self-Evolving Agent

> Your Agent gets stronger by competing, not by configuring. Scan capabilities, benchmark against Arena rankings, and upgrade to whatever wins.

Ranking and selection are automatic — driven by measured performance, not
opinions. **Installing is not.** Nothing on your machine changes until you say
so; see [What this Skill changes on your machine](#what-this-skill-changes-on-your-machine).

## Installation

Install from ClawHub:
1. Open OpenClaw
2. Search for "rotifer-self-evolving-agent" in the Skill marketplace
3. Click "Install"

Or manually:
```bash
cp -r rotifer-self-evolving-agent/ ~/.openclaw/workspace/skills/rotifer-self-evolving-agent/
```

## Usage

```bash
/evolve                          # Scan Agent, recommend upgrades      (read-only)
/evolve status                   # Agent capability dashboard          (read-only)
/evolve discover <query>         # Find capabilities by need           (read-only)
/evolve arena <domain>           # View Arena rankings                 (read-only)
/evolve compare <id1> <id2>      # Compare candidates                  (read-only)
/evolve inspect <id>             # Full capability details             (read-only)

/evolve upgrade <name>           # Propose a replacement — asks first, then installs
/evolve rollback [name]          # Undo the last replacement; no name lists what can be undone
/evolve create-agent <name>      # Write an Agent definition into this project

/evolve run-agent <name>         # EXECUTES a local Agent — runs Gene code
```

⚠️ `/evolve upgrade` is the one command that changes what is installed. It
replaces a Gene in your project's `genes/` directory, which changes what your
Agent does at runtime, and the replacement is third-party code from the Rotifer
marketplace.
It shows you the specific swap and waits for your yes — and keeps the copy it
replaced, so `/evolve rollback` puts it back.

⚠️ `/evolve run-agent` does not change what is installed, but it is not
read-only either: it **executes** the Genes in an Agent, through the `rotifer`
CLI or an `npx` fallback. Gene code runs inside a WASM sandbox, and this Skill
cannot switch that off — `no_sandbox` is refused unless the server was launched
with `--allow=no-sandbox`, which it is not. Running it unsandboxed is something
only you can do, from a terminal.

The six commands marked read-only never modify or execute anything.

## How it Works

This Skill wraps the [Rotifer MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server), which connects to the [Rotifer Protocol](https://rotifer.dev) — an evolution framework where AI capabilities (Genes) compete in an Arena. The fittest survive based on objective runtime metrics via the F(g) fitness function.

Key MCP tools used:

| Command | MCP Tools |
|---------|-----------|
| `evolve` | `list_local_agents` → `get_gene_detail` → `get_arena_rankings` → `search_genes` |
| `status` | `list_local_agents` + `list_local_genes` + `get_gene_detail` |
| `upgrade` | `get_arena_rankings` → `compare_genes` → `install_gene` |
| `rollback` | `rollback_gene` |
| `discover` | `search_genes` |
| `inspect` | `get_gene_detail` |
| `compare` | `compare_genes` |
| `arena` | `get_arena_rankings` |
| `create-agent` | `create_agent` |
| `run-agent` | `agent_run` |

## What this Skill changes on your machine

This Skill exists to modify your Agent's installed capabilities, so it is worth
being precise about what that means. The full version is in
[SKILL.md](SKILL.md#security--transparency).

| | |
|---|---|
| **Runs remote code** | `npx @rotifer/mcp-server@0.17.0`, fetched from npm on first use and cached. `/evolve run-agent` additionally shells out to the `rotifer` CLI, falling back to `npx -y @rotifer/playground` when it is not installed. Both are remote code — [read the source](https://github.com/rotifer-protocol/rotifer-mcp-server) or check `npm view @rotifer/mcp-server@0.17.0 dist.integrity` first. |
| **Reads** | Installed Genes under `genes/`, and Agents under `.rotifer/agents/` — both in the project you are working in. |
| **Executes** | `/evolve run-agent` runs an Agent's Genes, inside the WASM sandbox. This Skill cannot disable that sandbox. Each run appends a line to `~/.rotifer/run-logs/<gene>.jsonl` and updates a fitness file beside the Agent — both local, neither transmitted. |
| **Writes** | Genes into `genes/` (`/evolve upgrade`) and Agent definitions into `.rotifer/agents/` (`/evolve create-agent`) — both are project files, written under the project root, not into your home directory. That root defaults to the directory you are in and is an argument the install tool accepts, so it is whichever project the call names; these commands name the current one, and `rotifer.json`'s `genes_dir` can rename `genes/`. Plus a run log at `~/.rotifer/run-logs/<gene>.jsonl` when you run an Agent, and an update-check cache at `~/.config/rotifer/update-check.json`. Nothing outside those four. |
| **Sends** | Gene and Arena queries to the public Rotifer API, and one version check per day to `registry.npmjs.org`. **When you are logged in, each MCP tool call is also logged to Rotifer Cloud** — the tool's name, the Gene it acted on, whether it succeeded, how long it took, and your Rotifer user id. **Logged out, no usage record is sent** — but installing a Gene bumps that Gene's public install counter either way, one request carrying the Gene id and no identity. `ROTIFER_TELEMETRY=0` stops all three. Argument values, file contents, environment variables and your local configuration are not sent. |
| **Credentials** | It does not read your environment variables or other tools' secrets. Public data needs no login. If you do log in, your Rotifer session token is written to `~/.rotifer/credentials.json` with `0600` permissions and sent only to the Rotifer API. Genes and Agents do not live there — they are project files. |

**Every replacement is confirmed by you.** `/evolve` and `/evolve status` only
read and report. `/evolve upgrade` proposes a specific swap and waits — no Gene
is installed, replaced, or removed without an explicit yes.

**And an upgrade can be undone.** Replacing a Gene moves the old copy into
`<genes>/.snapshots/` first. Put it back with `/evolve rollback <name>`, or
`rotifer rollback <name>` from a terminal — the two write the same format, so it
does not matter which one replaced it. One snapshot per Gene: the next overwrite
supersedes it and a rollback uses it up, so this undoes the last upgrade rather
than keeping a history.

Two things worth knowing beyond that:

- **The assistant gets ten tools, not thirty-one.** This Skill launches the MCP
  server with `--tools=evolve`. Publishing, compiling, Arena submission and
  login are not exposed and are refused if called. Before version 2.4.0 all of
  them were reachable. The server's read-only resource URIs travel with that
  set — the three whose tools are excluded are dropped and refused, so there is
  no second door to the same data.
- **And it cannot leave the sandbox.** `agent_run` accepts a `no_sandbox`
  option that would run Gene code as plain Node.js. It is refused unless the
  server is launched with `--allow=no-sandbox`, and this Skill does not launch
  it that way. Ten tools with an escape hatch in one of them would not be ten
  tools.
- Removing the Skill does not uninstall Genes it installed. They stay in that
  project's `genes/` directory as ordinary Genes; `rotifer uninstall <name>`
  removes one, and that is undoable too.

## Related Skills

- [`rotifer-guide`](https://clawhub.ai/skill/rotifer-guide) — where to start if you are new to Rotifer
- [`rotifer-gene`](https://clawhub.ai/skill/rotifer-gene) — write, audit and upgrade a Gene
- [`rotifer-arena`](https://clawhub.ai/skill/rotifer-arena) — benchmark a Gene against the field
- [`rotifer-agent`](https://clawhub.ai/skill/rotifer-agent) — compose several Genes into an Agent

## Links

- [Rotifer Protocol](https://rotifer.dev)
- [Capability Marketplace](https://rotifer.ai)
- [Documentation](https://rotifer.dev/docs)
- [MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server)

## License

Apache-2.0
