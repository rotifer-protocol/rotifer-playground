---
name: rotifer-self-evolving-agent
version: 0.8.2
description: Your Agent evolves itself — scans capabilities, benchmarks against Arena rankings, and upgrades automatically
author: rotifer-protocol
---

# Rotifer Self Evolving Agent

Your Agent gets stronger by competing, not by configuring. Scan capabilities, benchmark against [Arena rankings](https://rotifer.dev), and upgrade to fitter alternatives — driven by objective performance data, not opinions.

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
Finds the top-ranked alternative in the same domain and installs it.

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

Under the hood, Rotifer uses **Genes** — atomic, transferable AI capabilities that compete in an **Arena**. The fittest Genes (measured by the fitness function **F(g)**) survive and are automatically selected.

```text
F(g) = [S_r · ln(1 + C_util) · (1 + R_rob)] / [L · Resource_Cost]
```

No voting, no human preference — pure runtime performance metrics determine which capabilities win.

## Links

- [Creator Portal](https://rotifer.dev)
- [Capability Marketplace](https://rotifer.ai)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)
- [MCP Server](https://www.npmjs.com/package/@rotifer/mcp-server)
