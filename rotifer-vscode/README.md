# Rotifer Protocol — VS Code Extension

> **Your AI Agent gets stronger by competing, not by configuring.**

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/rotifer-foundation.rotifer-vscode?label=VS%20Code&logo=visualstudiocode)](https://marketplace.visualstudio.com/items?itemName=rotifer-foundation.rotifer-vscode)
[![Open VSX](https://img.shields.io/open-vsx/v/rotifer-foundation/rotifer-vscode?label=Open%20VSX&logo=eclipse)](https://open-vsx.org/extension/rotifer-foundation/rotifer-vscode)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Browse, install, and manage [Rotifer Protocol](https://rotifer.dev) **Genes** — modular AI capabilities that compete in an Arena and evolve through objective fitness rankings.

## Quick Start

```bash
# 1. Install the extension from marketplace
# 2. Open any project
# 3. Click the Rotifer icon in the Activity Bar
# 4. Browse & install Genes with one click
```

## What are Genes?

Genes are **modular, transferable, fitness-evaluable** logic units for AI Agents. Think of them as npm packages, but they **compete against each other** — the fittest survive, the weakest get replaced. Your Agent automatically upgrades to stronger alternatives.

## Features

### Gene Registry Browser

A dedicated sidebar panel displays all published Genes grouped by domain. Click any Gene to view details — description, version, fidelity type, schemas, and reputation score.

### One-Click Install

Right-click a Gene in the registry → **Install Gene** → downloaded to your workspace's `genes/` directory, ready to use immediately.

### Arena Rankings

View detailed reputation scores: Arena performance, usage metrics, and stability ratings visualized in an interactive panel. See which Genes are winning.

### Publish SKILL.md as Gene

Right-click any `SKILL.md` file → **Rotifer: Publish as Gene** → wrapped and published to the Cloud Registry in one step.

## Commands

| Command | Description |
|---------|-------------|
| `Rotifer: Refresh Gene Registry` | Reload Gene list from Cloud |
| `Rotifer: Install Gene` | Download a Gene to workspace |
| `Rotifer: View Gene Details` | Open Gene details panel |
| `Rotifer: View Gene Reputation` | Show reputation breakdown |
| `Rotifer: Publish as Gene` | Wrap and publish a SKILL.md |

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
- [MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server) — Use Genes from any AI Agent
- [Discord](https://rotifer.dev/discord)

## License

Apache-2.0
