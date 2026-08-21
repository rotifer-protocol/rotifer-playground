---
name: rotifer-arena
description: >-
  Benchmark Rotifer Genes against each other in the Arena — import from ClawHub / local /
  scratch, compile, match opponents, run Arena evaluation, and produce a Markdown report with
  F(g) fitness and V(g) security grades.
  Invoke explicitly to compare or benchmark Rotifer Genes.
  Do NOT use for general benchmarking, load testing, or comparing anything that is not a
  Rotifer Gene or Agent.
---

# Rotifer Arena — Gene Comparison & Evaluation

> One Skill covering Gene/Genome/Agent comparison across all scenarios.

## Prerequisites

This Skill requires the Rotifer CLI:

```bash
npx @rotifer/playground --version
```

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

## Overview

This Skill wraps Rotifer Protocol's core value — **objective, quantifiable capability evaluation** — into a one-click workflow. Users don't need to understand Gene, Arena, or F(g) concepts upfront; the Skill introduces them naturally during execution.

**Cross-platform**: This SKILL.md runs in any AI development environment that supports Skills/Agents.

---

## Workflow

### Phase 1: Identify Evaluation Target

Understand user intent through conversation and determine the evaluation mode:

| User signal | Mode | Action |
|-------------|------|--------|
| "Evaluate the X skill from ClawHub" | **ClawHub migration evaluation** | `rotifer wrap <name> --from-clawhub <slug>` |
| "Compare my two implementations" | **Local comparison** | Confirm both Gene names, skip to Phase 3 |
| "I have a Skill I want to test" | **Skill import evaluation** | `rotifer wrap <name> --from-skill <path>` |
| "Help me build a XX scenario" | **Scenario scaffolding** | Guide Gene creation (`rotifer init` or manual phenotype) |

**If the user doesn't specify a domain**: auto-read from phenotype.json, or guide the user to choose.

### Phase 2: Compile & Verify

```bash
rotifer compile <gene-name>
```

Output guidance based on fidelity result:
- **Wrapped**: Verification passed, deterministic evaluation mode
- **Hybrid/Native**: WASM compilation, real sandbox execution mode (requires NAPI binding)

### Phase 3: Automatic Opponent Matching

**Priority order**:

1. **User-specified**: If the user says "compare X and Y", use those directly
2. **Same-domain local search**: Highest-ranked Gene from `rotifer arena list --domain <domain>`
3. **Same-fidelity preferred**: If target is Wrapped, prefer Wrapped opponents (avoid cross-fidelity blowouts)
4. **No opponent found**: Inform the user, show current cross-domain Arena rankings for reference

**Opponent selection requires user confirmation** — show candidate F(g) and fidelity.

### Phase 4: Arena Submit & Compare

```bash
rotifer vg <path-to-gene-a>
rotifer vg <path-to-gene-b>
rotifer arena submit <gene-a>
rotifer arena submit <gene-b>
rotifer arena list --domain <domain>
```

`rotifer vg` is where the report's **V(g)** column comes from — it scans a Gene's
code and returns a grade of A–D, or `?` when there is no `src/` to read (a
pure-prompt Skill earns `?`, which is not a failing grade and should be
reported as "no code to scan"). Without this step there is no V(g) to put in
the table, and a guessed one is worse than an absent one.

To watch the ranking settle after both submissions rather than re-running
`arena list`:

```bash
rotifer arena watch <domain>          # live; Ctrl+C to stop
rotifer arena watch all --interval 10000
```

It marks each change as new / improved / dropped / eliminated, which is what
the report's "← new entry" markers are describing.

**If both Genes are already published to Cloud**, two further commands add
adoption data the Arena does not measure:

```bash
rotifer compare <gene-a> <gene-b>     # 2–5 published Genes, by reputation and downloads
rotifer stats <gene-ref>              # download history: 7d / 30d / 90d / all time
```

Keep the two kinds of comparison apart in the report. `rotifer compare` ranks
by **reputation and downloads** — how much the ecosystem uses something. The
Arena run measures **F(g)** — how well it performs. A Gene can lead on one and
trail on the other, and saying which is which is the point of the report.

Collect evaluation results for both Genes.

### Phase 5: Generate Evaluation Report

**Output the full report in the conversation** (rendered Markdown).
Append at the end: `> Reply "save" to write the report to arena-reports/`.
When the user replies "save", write to `<project>/arena-reports/<date>-<gene-a>-vs-<gene-b>.md`.

Say what "save" does when you offer it — it creates a file in their project,
under `arena-reports/`, creating that directory if it is missing. The report is
shown in full in the conversation first, so saving is a choice rather than the
only way to read it. Never write it without being asked.

**Report format requirements**:

1. **Title = conclusion**: Use scenario name + both Gene names, not a generic title
2. **Conclusion first**: Immediately below the title, a `>` blockquote with one-sentence summary of winner and key data
3. **Concise comparison table**: Only decision-relevant metrics (rank, F(g), V(g), Fidelity, success rate, latency, source), bold the winner. Every number in it must come from a command actually run — F(g) from `arena list`, V(g) from `rotifer vg`, downloads from `rotifer stats`. Leave a cell empty and say why rather than estimating it
4. **Ranking visualization**: Fixed-width ASCII table showing the full domain ranking, mark new entries with `←`
5. **Reproduction commands in a standalone bash block**: Pure commands (no comments/output) for easy copy-paste
6. **No internal references**: No ADR numbers, plan section numbers, or internal version notes
7. **Minimal metadata**: One line at the bottom with date + CLI version + evaluation mode

**Report structure** (output directly in conversation):

- **Title**: `# <scenario> Comparison: <Gene A> vs <Gene B>`
- **Conclusion blockquote**: One sentence — who won, key metric delta, core reason
- **Comparison table**: Rank, F(g), V(g), Fidelity, Success rate, Latency score, Source
- **Current ranking**: Full domain leaderboard (ASCII table, `←` marks new entries)
- **Analysis**: 2–3 paragraphs on fitness gap attribution, security comparison, same-fidelity positioning
- **Upgrade path**: Table with path / action / expected improvement / effort
- **Reproduction steps**: 4–5 pure CLI commands
- **Next steps**: 4 commands with brief descriptions
- **Footer**: `Generated on YYYY-MM-DD · @rotifer/playground@X.Y.Z · Mode: deterministic estimation`

---

## Scenario Examples

### Example 1: Evaluate a ClawHub Skill's Competitiveness

```text
User: Evaluate the web-search skill from ClawHub in the Rotifer ecosystem

Skill execution:
1. rotifer wrap clawhub-web-search --from-clawhub web-search -d search
2. rotifer compile clawhub-web-search
3. Auto-discover same-domain opponent: genesis-web-search (Native, F(g)=0.9470)
4. rotifer arena submit clawhub-web-search
5. Generate comparison report
```

### Example 2: Compare Two Custom Genes

```text
User: Compare my particle-brute and particle-spatial — which is better?

Skill execution:
1. Confirm both Genes exist with phenotype.json
2. rotifer arena submit particle-brute
3. rotifer arena submit particle-spatial
4. rotifer arena list --domain sim.particle
5. Generate comparison report
```

### Example 3: Build a Quantitative Scenario

```text
User: Help me build a quantitative strategy comparison scenario

Skill execution:
1. Guide user to define domain (e.g. quant.strategy)
2. Guide creation of two Gene phenotype.json files (Strategy A vs Strategy B)
3. If compilable source exists, compile to WASM
4. rotifer arena submit both Genes
5. Generate scenario comparison report
```

---

## Checklist Before Running

- Project has a `rotifer.json` (if not, guide `rotifer init`)
- CLI is installed: `npm i -g @rotifer/playground`, or invoke it as `npx @rotifer/playground`
- `rotifer doctor` passes — compiling to Native WASM needs esbuild and javy, and
  without them `rotifer compile` fails in a way that reads like a code error
- ClawHub imports require network connectivity

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

## Related Skills

| Skill | Relationship |
|-------|-------------|
| `rotifer-gene` (dev module) | Route here when users need to create a Gene from scratch |
| `rotifer-gene` (migration module) | Route here when the report recommends a fidelity upgrade |
| `rotifer-gene` (audit module) | Suggest running when the report shows low security scores |

## Constraints

- **No automatic Cloud publishing**: Comparison evaluation is a local operation; Cloud publishing requires explicit user confirmation
- **Cross-fidelity comparisons need a disclaimer**: The baseFitness gap between Wrapped and Native comes from the scoring model, not actual capability differences
- **Reports are Markdown format**: Ready for blogs, community sharing, or GitHub Issues
