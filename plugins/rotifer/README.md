<div align="center">
  <img src="assets/icon.png" alt="Rotifer Protocol" width="96" height="96">
  <h1>Rotifer Protocol — Cursor Plugin</h1>
  <p><strong>Self-evolving AI agent capabilities.</strong> Scan what your agent can do, benchmark it against public rankings, and swap in something better.</p>
  <p>
    <a href="https://github.com/rotifer-protocol/rotifer-playground/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-blue.svg" alt="License: Apache-2.0"></a>
    <a href="https://www.npmjs.com/package/@rotifer/playground"><img src="https://img.shields.io/npm/v/@rotifer/playground?label=CLI" alt="npm"></a>
    <a href="https://www.npmjs.com/package/@rotifer/mcp-server"><img src="https://img.shields.io/npm/v/@rotifer/mcp-server?label=MCP%20server" alt="npm"></a>
  </p>
</div>

---

## What this is

Most agent capabilities are written once and never measured again. Rotifer treats a
capability as a **Gene** — a versioned, testable unit with a declared input/output
schema, compiled to WASM, and scored by a fitness function `F(g)` in a public Arena.

Because Genes are portable and comparable, an agent can do something ordinary code
cannot: **find out that a better implementation of its own capability exists, and adopt it.**

This plugin brings that loop into Cursor.

## What it does

| | |
|---|---|
| **Scan** | Walk the workspace and identify functions that are already Gene-shaped |
| **Wrap** | Turn a plain function into a Gene with a `phenotype.json` contract |
| **Compare** | Check a local Gene against Arena rankings for the same capability |
| **Upgrade** | Install a higher-scoring Gene and run it in a sandbox before trusting it |
| **Publish** | Share a Gene, with an automatic `V(g)` safety-scan badge |

Every Gene runs inside a WASM sandbox with fuel metering and memory limits, so
trying someone else's capability does not mean trusting their code with your machine.

## What ships in this plugin

**Skills** — the agent picks these up automatically when relevant:

| Skill | Purpose |
|---|---|
| `rotifer` | Browse, install, and compete Genes in the live Arena |
| `rotifer-hello` | Interactive agent creation from curated templates — quality diagnosis, security scanning, content analysis, Web3 auditing, document Q&A |
| `rotifer-self-evolving-agent` | The full loop: scan capabilities, benchmark against live Arena rankings, and replace weaker Genes. Ranking is the automatic part — every replacement waits for your approval and can be rolled back |
| `rotifer-assistant` | Unified entry point — guide, architect, and challenge your agents |

**Rule** — `rotifer-gene-dev` keeps generated Genes inside the project's conventions:
naming, structure, fidelity declaration, and phenotype schema. It activates on
`**/genes/**` and `**/phenotype.json`.

**MCP server** — [`@rotifer/mcp-server`](https://www.npmjs.com/package/@rotifer/mcp-server),
launched on demand via `npx`, nothing to install ahead of time.

Left undeclared, the server offers 31 tools and 7 resources covering the whole
lifecycle, including compiling, publishing, Arena submission and login. **This
plugin launches it with `--tools=evolve`, which offers 10 tools and 4 resources**
— enough to search, compare, install and roll back Genes and to create and run
Agents, and nothing more. The rest are not listed and are refused if called, so
nothing here can publish on your behalf or sign you in. The launch line also omits
`--allow`, so the sandbox escape hatches stay off.

Resources are narrowed alongside the tools they duplicate, because a restriction
with an unlisted way around it is not a restriction.

The version is pinned rather than floating, so what you install is what you reviewed:

```bash
npx -y @rotifer/mcp-server@0.16.1 --tools=evolve
```

You can run that yourself and ask it to list its tools.

## Fidelity: what a Gene honestly is

Every Gene declares how it actually works. This is a hard requirement, not a label:

- **Native** — real executable WASM, runs fully inside the sandbox
- **Wrapped** — a wrapper around an external API, and says so
- **Hybrid** — declares its external dependencies, how it degrades when they are
  unavailable, and a simulation spec for that case

A Gene that misrepresents its fidelity is a broken Gene. Rankings are only meaningful
if you know what you are comparing.

## Requirements

- **Node.js ≥ 20**
- No account needed to scan, wrap, test, or run Genes locally
- An account is only required to publish or to submit to the Cloud Arena

## Try it without the plugin

Everything here is public and works standalone, so you can verify it end to end first:

```bash
# CLI
npx @rotifer/playground@latest init my-agent
npx @rotifer/playground@latest scan
npx @rotifer/playground@latest doctor

# MCP server
npx @rotifer/mcp-server@latest
```

## Status

The protocol is **pre-1.0** and under active development; APIs may change between
minor versions. Arena, Cloud publishing, the WASM sandbox, and the safety-badge
pipeline are live. P2P gene propagation is experimental and **off by default** —
the CLI never joins a network unless you ask it to.

See the [changelog](https://rotifer.dev/docs/changelog/) for full release history.

## Links

- **Docs** — https://rotifer.dev/docs/
- **Repository** — https://github.com/rotifer-protocol/rotifer-playground
- **Protocol spec** — https://github.com/rotifer-protocol/rotifer-spec
- **Issues** — https://github.com/rotifer-protocol/rotifer-playground/issues

## License

Apache-2.0. See [LICENSE](https://github.com/rotifer-protocol/rotifer-playground/blob/main/LICENSE).
