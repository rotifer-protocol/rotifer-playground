---
name: rotifer-hello
version: {{familyVersion}}
description: Interactive agent creation — choose from curated templates covering quality diagnosis, security scanning, content analysis, Web3 auditing, and document Q&A
author: rotifer-protocol
---

# Hello, Rotifer

Create your first AI Agent in under 60 seconds. Choose a template, see it run, understand the protocol.

## Quick Start

### Interactive Mode
```
rotifer hello
```
Launches a visual template picker. Choose a scenario, watch genes execute in sequence, and see Protocol Insights (fitness score, domain, evolution path).

### Direct Template
```
rotifer hello --template quality-advisor
```

### List All Templates
```
rotifer hello --list-templates
```
Shows which templates can run in this workspace and which need genes first.

## Available Templates

### Ready After `rotifer init`

| Template | Genes | What it Does |
|----------|-------|-------------|
| **Quality Advisor** | `gene-health-scanner` | Seven-dimension gene library health diagnostic |

### Needs Genes First

These templates cannot run from a new workspace yet. Running one exits 1 and says, gene by gene, whether it can be installed (with the `rotifer install @rotifer-protocol/<gene>` command to copy) or is not available. `rotifer hello` asks Rotifer Cloud (read-only, up to 5 seconds) but never downloads anything itself. With `--json`, stdout carries one JSON document, so scripts and agents can read the reason.

| Template | Genes | What it Does |
|----------|-------|-------------|
| **UI/UX Diagnosis** | `uiux-analyzer` → `uiux-reporter` | WCAG 2.2 + Nielsen heuristic analysis with prioritized fix report |
| **Content Analysis** | `content-quality-analyzer` → `content-optimizer` | Bilingual readability, virality scoring, and optimization suggestions |
| **Code Security** | `security-scanner` | Vulnerability detection + credential leak scanning |
| **Doc Q&A** | `doc-retrieval` → `answer-synthesizer` | RAG pipeline with cited answers (requires API key) |
| **Web3 Toolkit** | `solidity-parser` → `vuln-detector` → `audit-reporter` | Smart contract security audit pipeline |

## After Running

Every template run displays **Protocol Insights**:
- **Fitness Score** — Simulated F(g) based on gene fidelity and execution success
- **Primary Domain** — The gene's classification in the Rotifer taxonomy
- **Evolution Path** — Suggestions for upgrading Wrapped genes to Native

## What's Next

- `/evolve` — Scan and upgrade your agent's capabilities
- `rotifer gene list` — Browse all installed genes
- `rotifer agent create` — Build a custom agent from scratch
- [Capability Marketplace](https://rotifer.ai) — Discover community genes
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)
