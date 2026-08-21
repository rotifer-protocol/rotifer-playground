---
name: rotifer-agent
description: >-
  Build a Rotifer Agent from Genes — decompose intent into capability units, pick Genes by
  Arena F(g), compose a Rotifer Genome, create the Agent and test it.
  Use when the user is working with Rotifer specifically: "Rotifer Agent", "compose Genes",
  "Rotifer Genome", "Gene composition", "rotifer agent create".
  Do NOT use for general agent frameworks, or when the words Seq / Par / Cond / Try appear as
  ordinary programming terms — in Rotifer those name Genome composition strategies, and this
  Skill applies only when the user is composing Rotifer Genes.
---

# Rotifer Agent — From Genes to Agents

Decompose user intent into capability units, select Genes from the ecosystem, compose a Genome, create and validate an Agent.

## Prerequisites

This Skill requires the Rotifer CLI:

```bash
npx @rotifer/playground --version
rotifer doctor
```

`rotifer doctor` checks the TypeScript→WASM toolchain. Composing an Agent from
Native Genes means compiling them, and without esbuild and javy that step fails
with an error that reads like a code problem.

Or use the MCP Server for IDE integration:

```json
{
  "mcpServers": {
    "rotifer": {
      "command": "npx",
      "args": ["@rotifer/mcp-server"]
    }
  }
}
```

---

**Hierarchy**: Gene (atomic logic) → Genome (composition) → Agent (runnable entity)

---

## Phase 1: Intent Decomposition

Break the user's goal into independent capability units (each maps to a Gene).

**Steps**:

1. Confirm the Agent's input and expected output with the user
2. Decompose the task into 2–6 capability units, each satisfying the Gene three axioms (functional cohesion, self-sufficient interface, independently evaluable)
3. Label each unit with a domain (e.g. `content.grammar`, `security.audit`)
4. Confirm the decomposition with the user before proceeding to Phase 2

**Output format**:

| # | Capability unit | Domain | Input | Output |
|---|----------------|--------|-------|--------|
| 1 | Grammar check | content.grammar | text | issues[], score |
| 2 | Readability analysis | content.readability | text | grade, suggestions[] |

---

## Phase 2: Gene Selection

Match existing Genes to each capability unit.

```bash
rotifer list                                  # what is already in this workspace
rotifer arena list --domain <domain>          # ranked by F(g) within one domain
rotifer search <capability> --domain <domain> # the Cloud registry — everyone else's Genes
```

The three answer different questions, and skipping the third is how a Genome
ends up built only from what happened to be installed already.

**Selection priority**:

| Priority | Source | Command |
|----------|--------|---------|
| 1 | Local Gene with highest Arena rank | `rotifer arena list --domain <d>` |
| 2 | Cloud Registry | `rotifer search <capability>` → `rotifer info <ref>` → `rotifer install <ref>` |
| 3 | Doesn't exist, needs creation | Proceed to Phase 3 |

Before committing a candidate to the Genome, run it on its own — a Gene that
fails alone will fail inside a pipeline, where the error is much harder to
locate:

```bash
rotifer run <gene-name> --input '{"...": "..."}'
```

Show the user candidate Genes' F(g) fitness and fidelity, let them confirm the selection.

---

## Phase 3: Gap Filling

If a capability unit has no existing Gene:

| Approach | When to use | Action |
|----------|------------|--------|
| Create Wrapped Gene | External API / Skill available to wrap | Route to `rotifer-gene` Skill (dev module) |
| Create Native Gene | Pure computation, no external dependencies | Route to `rotifer-gene` Skill (dev module) |
| Adjust decomposition | Capability unit granularity is wrong | Return to Phase 1 |
| Merge units | Two units are too coupled, splitting makes the interface awkward | Merge into one Gene |

After all Genes are ready, proceed to Phase 4.

---

## Phase 4: Genome Composition

Choose a composition strategy based on relationships between capability units.

### Composition Strategy Decision Table

| Strategy | Semantics | Use when | Example |
|----------|-----------|----------|---------|
| **Seq(A, B, C)** | Pipeline: A → B → C | Previous output feeds the next | Check → Fix → Format |
| **Par(A, B)** | Parallel: run simultaneously | Independent tasks, merge results | Grammar check + Readability analysis |
| **Cond(p, A, B)** | Branch: if p then A else B | Input characteristics determine path | Chinese → Chinese proofing / English → English proofing |
| **Try(A, B)** | Fallback: A fails → B | Primary path unreliable | Main API → Backup API |
| **TryPool(A, B, C)** | Race: all try, first success wins | Multiple equivalent implementations | Multiple translation services racing |

### Par Merge Strategies

When using Par, specify `--par-merge`:

| Strategy | Behavior | Use when |
|----------|----------|----------|
| `first` | Take the first completed result | Racing scenario |
| `concat` | Concatenate all results (array) | Results are complementary |
| `merge` | Deep-merge objects | Same structure, merge fields |

### Seq Schema Compatibility Warning

> **Known limitation**: Seq composition requires the previous Gene's outputSchema to be compatible with the next Gene's inputSchema. The current version does not auto-validate — schema mismatches cause runtime errors.
>
> **Recommendation**: Before creating a Seq composition, manually compare adjacent Genes' inputSchema / outputSchema in phenotype.json to confirm field names and types match.

### Nested Composition

Strategies can be nested:

```text
Seq(
  Par(grammar-checker, readability-analyzer),
  tone-analyzer
)
```

Corresponding CLI:

```bash
rotifer agent create doc-qa \
  --genes grammar-checker readability-analyzer tone-analyzer \
  --composition Seq
```

> The current CLI only supports top-level composition strategies. Nested compositions require manual editing of `.rotifer/agents/<id>.json`.

---

## Phase 5: Agent Creation

Execute creation after confirming the composition plan.

### Manual Gene Selection

```bash
rotifer agent create <name> \
  --genes <gene1> <gene2> <gene3> \
  --composition <Seq|Par|Cond|Try|TryPool> \
  --par-merge <first|concat|merge>
```

### Auto-select Genes (by domain ranking)

```bash
rotifer agent create <name> \
  --domain <domain> \
  --top <n> \
  --composition <strategy>
```

After creation, verify the Agent configuration file `.rotifer/agents/<name>.json` is correct.

---

## Phase 6: Test Run

```bash
rotifer agent list
rotifer agent run <name> --input '{"text": "Test input content"}'
```

`rotifer agent list` shows every Agent in the workspace with its state and
genome — use it to confirm the Agent was created with the Genes you intended
before running it, and to recover the exact name when a run reports "agent not
found".

**Validation checklist**:

- Does the output structure match the expected schema?
- Were all Genes executed? (check logs)
- Is schema passing correct in Seq composition?
- Are Par merge results complete?
- Do error paths (Try/TryPool) degrade correctly?

If results are unsatisfactory, proceed to Phase 7.

---

## Phase 7: Iterative Optimization

| Problem | Optimization |
|---------|-------------|
| One Gene's output quality is poor | `rotifer arena list --domain <d>` for ranked local alternatives, or `rotifer search <capability>` to look beyond what is installed |
| Not sure which Gene in the pipeline is at fault | `rotifer run <gene-name> --input '{...}'` on each one in isolation |
| Seq intermediate results missing fields | Check schema compatibility, consider inserting an adapter Gene |
| Par merge results are messy | Switch `--par-merge` strategy |
| Latency too high | Seq → Par (if Genes are independent) |
| Overall below expectations | Route to `rotifer-arena` Skill for head-to-head Gene evaluation |

---

## Scenario Examples

### Scenario 1: Document Quality Agent

**Goal**: Input text, output grammar issues + readability score + tone analysis.

**Decomposition**:

| # | Capability | Gene | Domain |
|---|-----------|------|--------|
| 1 | Grammar check | grammar-checker | content.grammar |
| 2 | Readability analysis | readability-analyzer | content.readability |
| 3 | Tone analysis | tone-analyzer | content.tone |

**Composition**: All three accept `text` input, no dependencies → Par + concat.

```bash
rotifer agent create doc-quality \
  --genes grammar-checker readability-analyzer tone-analyzer \
  --composition Par \
  --par-merge concat

rotifer agent run doc-quality --input '{"text": "Document content to check..."}'
```

### Scenario 2: Code Review Agent

**Goal**: Input code file, output security vulnerabilities + complexity report + documentation suggestions.

| # | Capability | Gene | Domain |
|---|-----------|------|--------|
| 1 | Security audit | security-auditor | security.audit |
| 2 | Complexity analysis | code-complexity | code.analysis |
| 3 | Documentation generation | docs-writer | content.docs |

**Composition**: Security audit and complexity analysis can run in parallel, documentation depends on both → Seq(Par(1,2), 3).

```bash
rotifer agent create code-review \
  --genes security-auditor code-complexity docs-writer \
  --composition Seq

rotifer agent run code-review --input '{"code": "...", "language": "typescript"}'
```

> Note: The Par(security-auditor, code-complexity) merged output must be compatible with docs-writer's inputSchema. Manual verification required.

### Scenario 3: Search & Summarize Agent

**Goal**: Input a search query, search → summarize → format output.

| # | Capability | Gene | Domain |
|---|-----------|------|--------|
| 1 | Web search | genesis-web-search | search.web |
| 2 | Text summarization | text-summarizer | content.summarize |
| 3 | Markdown formatting | markdown-formatter | content.format |

**Composition**: Strict serial pipeline → Seq.

```bash
rotifer agent create search-digest \
  --genes genesis-web-search text-summarizer markdown-formatter \
  --composition Seq

rotifer agent run search-digest --input '{"query": "Rotifer Protocol agent framework"}'
```

> Note the Seq schema chain: genesis-web-search output field names must match text-summarizer's inputSchema. Run `cat genes/*/phenotype.json | jq '.inputSchema, .outputSchema'` to verify before creating.

---

## What this Skill does on your machine

It has no code of its own — it tells your assistant which `rotifer` commands to
run. That is why its manifest declares process execution, filesystem read/write
and outbound network access: every one of those is the CLI acting, not this
Skill.

| | |
|---|---|
| **Runs** | The `rotifer` CLI (`@rotifer/playground`), fetched from npm if not installed. |
| **Reads** | Genes and Agent definitions in the current project workspace. |
| **Writes** | Only what the commands below write — Genes into the project's `genes/`, Agent definitions into `.rotifer/agents/`. Nothing outside the project. |
| **Sends** | Cloud registry and Arena queries, to the public Rotifer API. Your code is not uploaded unless you run `rotifer publish` yourself. |

Commands that install, publish or overwrite are proposed for your approval
first, never run silently.

---

## Related Skills

| Skill | Relationship | When to route |
|-------|-------------|---------------|
| `rotifer-gene` (dev module) | Gene creation/development | Phase 3 gap filling |
| `rotifer-arena` | Gene comparison & evaluation | Phase 7 when replacing underperforming Genes |
| `rotifer-genome` | Genome quality analysis | After Agent creation for overall assessment |

---

## Constraints

- Agent configuration files are stored in `.rotifer/agents/<id>.json` and should not be committed to Git
- A single Agent should contain 2–6 Genes; more than 6 suggests splitting into multiple Agents
- Seq schema compatibility is a known limitation — always verify manually before creating
- Nested compositions require manual JSON editing; the CLI only supports top-level strategies
