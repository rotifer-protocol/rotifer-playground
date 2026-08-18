---
name: rotifer-hello
version: 0.9.5
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
rotifer hello --template uiux-diagnosis
rotifer hello --template content-analysis
rotifer hello --template code-security
rotifer hello --template doc-qa
rotifer hello --template web3-toolkit
```

### List All Templates
```
rotifer hello --list-templates
```

## Available Templates

### Quick Start (Zero Config)

| Template | Genes | What it Does |
|----------|-------|-------------|
| **Quality Advisor** | `gene-health-scanner` | Seven-dimension gene library health diagnostic |
| **UI/UX Diagnosis** | `uiux-analyzer` → `uiux-reporter` | WCAG 2.2 + Nielsen heuristic analysis with prioritized fix report |
| **Content Analysis** | `content-quality-analyzer` → `content-optimizer` | Bilingual readability, virality scoring, and optimization suggestions |
| **Code Security** | `security-scanner` | Vulnerability detection + credential leak scanning |

### Power Templates

| Template | Genes | What it Does |
|----------|-------|-------------|
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
