# Rotifer Protocol — VS Code Extension

Browse, install, and manage [Rotifer Protocol](https://rotifer.dev) genes directly from your IDE.

## Features

### Gene Registry Browser

A dedicated sidebar panel displays all published genes grouped by domain. Click any gene to view details (description, version, fidelity, schemas, reputation score).

### One-Click Install

Right-click a gene in the registry and select **Install Gene** to download it into your workspace's `genes/` directory — ready to use immediately.

### Gene Reputation

View detailed reputation scores for any gene: Arena performance, usage metrics, and stability ratings visualized in an interactive panel.

### Publish SKILL.md as Gene

Right-click any `SKILL.md` file in the Explorer and select **Rotifer: Publish as Gene** to wrap and publish it to the Cloud Registry in one step.

## Getting Started

1. Install the extension
2. Open a Rotifer project (or run `npx @rotifer/playground init my-project`)
3. Click the **Rotifer** icon in the Activity Bar
4. Browse the Gene Registry and install genes

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `rotifer.cloudEndpoint` | Rotifer Cloud URL | Supabase endpoint for the Gene Registry |
| `rotifer.anonKey` | *(empty)* | Supabase anonymous key for API access |

## Commands

| Command | Description |
|---------|-------------|
| `Rotifer: Refresh Gene Registry` | Reload the gene list from Cloud |
| `Rotifer: Install Gene` | Download a gene to your workspace |
| `Rotifer: View Gene Details` | Open gene details panel |
| `Rotifer: View Gene Reputation` | Show reputation breakdown |
| `Rotifer: Publish as Gene` | Wrap and publish a SKILL.md file |

## Requirements

- VS Code 1.85.0 or later (also works with Cursor)
- Node.js 20+ (for CLI operations)

## Links

- [Rotifer Protocol](https://rotifer.dev)
- [Documentation](https://rotifer.dev/docs)
- [GitHub](https://github.com/rotifer-protocol/rotifer-playground)
- [Discord](https://discord.gg/6d4JrfMr)

## License

Apache-2.0 + Rotifer Safety Clause
