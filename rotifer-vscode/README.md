# Rotifer Protocol — VS Code Extension

> **Your AI Agent gets stronger by competing, not by configuring.**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/rotifer-foundation.rotifer-vscode?label=VS%20Code&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=rotifer-foundation.rotifer-vscode)
[![Open VSX](https://img.shields.io/open-vsx/v/rotifer-foundation/rotifer-vscode?label=Open%20VSX&logo=eclipse)](https://open-vsx.org/extension/rotifer-foundation/rotifer-vscode)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Browse, install, and manage [Rotifer Protocol](https://rotifer.dev) genes directly from your IDE — then compose them into agents that run in a WASM sandbox.

## Your First Agent in 30 Seconds

```bash
npm install -g @rotifer/playground
rotifer init my-project && cd my-project
rotifer hello                    # pick a template → agent runs immediately
```

`rotifer hello` ships with 6 curated templates — code security scanning, UI/UX diagnosis, content analysis, document Q&A, and more. Each creates a ready-to-run agent from your installed genes.

## What are Genes?

Genes are **modular, transferable, fitness-evaluable** logic units for AI Agents. Think of them as npm packages, but they **compete against each other** — the fittest survive, the weakest get replaced. Your Agent automatically upgrades to stronger alternatives.

## Features

### Gene Registry Browser

A dedicated sidebar panel displays all published genes grouped by domain. Click any gene to view details — description, version, fidelity type, schemas, and reputation score.

### One-Click Install

Right-click a gene in the registry and select **Install Gene** to download it into your workspace's `genes/` directory — ready to use immediately.

### Arena Rankings

View detailed reputation scores: Arena performance, usage metrics, and stability ratings visualized in an interactive panel. See which genes are winning.

### Agent Composition

Compose multiple genes into agents using the Rotifer Algebra (Seq, Par, Cond, Try, TryPool):

```bash
rotifer agent create search-bot --genes genesis-web-search my-search
rotifer agent run search-bot --input '{"query":"rotifer protocol"}'
```

### Publish SKILL.md as Gene

Right-click any `SKILL.md` file → **Rotifer: Publish as Gene** → wrapped and published to the Cloud Registry in one step.

## Commands

| Command | Description |
|---------|-------------|
| `Rotifer: Refresh Gene Registry` | Reload gene list from Cloud |
| `Rotifer: Install Gene` | Download a gene to workspace |
| `Rotifer: View Gene Details` | Open gene details panel |
| `Rotifer: View Gene Reputation` | Show reputation breakdown |
| `Rotifer: Publish as Gene` | Wrap and publish a SKILL.md |

## MCP Server Integration

For AI-native workflows, pair this extension with the [MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server) — 29 tools, 7 resources, 4 prompts accessible from Cursor, Claude Desktop, or any MCP client:

```json
{
  "mcpServers": {
    "rotifer": { "command": "npx", "args": ["@rotifer/mcp-server"] }
  }
}
```

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `rotifer.cloudEndpoint` | Rotifer Cloud URL | Supabase endpoint for Gene Registry |
| `rotifer.anonKey` | *(empty)* | Supabase anonymous key for API access |

## Works With

- **VS Code** 1.85.0+
- **Cursor**
- **Windsurf**
- Any VS Code-compatible editor

## Links

- [rotifer.dev](https://rotifer.dev) — Main site
- [rotifer.ai](https://rotifer.ai) — Gene Marketplace
- [GitHub](https://github.com/rotifer-protocol/rotifer-playground)
- [MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server) — Use genes from any AI Agent
- [Discord](https://rotifer.dev/discord)

## License

Apache-2.0
