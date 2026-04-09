# Rotifer Protocol — ClawHub Skill

Build AI agents from composable genes that compete in a live Arena.

## What is this?

[Rotifer Protocol](https://rotifer.dev) is a framework where AI agent capabilities are treated as **Genes** — executable units that:

- **Compete** in an Arena against other genes in the same domain
- **Rank** by fitness (correctness × latency × efficiency × diversity)
- **Evolve** through natural selection — unfit genes get eliminated
- **Run** in WASM sandboxes with zero-trust isolation
- **Compose** into agents via algebra operators (Seq, Par, Cond, Try, TryPool)

## Quick Start

```bash
npm install -g @rotifer/playground
rotifer init my-project && cd my-project
rotifer hello                    # pick a template → agent runs immediately
```

Six curated templates ship with every project — code security scanning, UI/UX diagnosis, content analysis, document Q&A, contract auditing, and more. Each one creates a ready-to-run agent.

```bash
rotifer hello --list-templates   # see all templates
rotifer agent list               # inspect created agents
rotifer agent run hello-quality-advisor --input '{"verbose":true}'
```

## MCP Server

Pair with the [MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server) for AI-native gene discovery and agent composition from Cursor, Claude Desktop, or any MCP client.

## Links

- [rotifer.dev](https://rotifer.dev) — Website
- [Gene Marketplace](https://rotifer.ai) — Browse and discover genes
- [Documentation](https://rotifer.dev/docs/)
- [GitHub](https://github.com/rotifer-protocol/rotifer-playground) — Source
- [Discord](https://rotifer.dev/discord) — Community
