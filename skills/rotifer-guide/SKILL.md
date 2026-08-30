---
name: rotifer-guide
description: >-
  Entry point for Rotifer Protocol — onboarding to Rotifer Genes, scaffolding a Gene from a
  description, diagnosing a Gene's F(g) or compile failure, searching the Rotifer Gene registry,
  and upgrading a Gene's fidelity from Wrapped to Native.
  Invoke explicitly when starting with Rotifer, or when unsure which Rotifer capability to use.
  Do NOT use for general onboarding, tutorials, troubleshooting, or search — every capability
  here operates on Rotifer Genes and the Rotifer CLI, and nothing else.
---

# Rotifer Guide — User Entry Point

> This Skill handles intent recognition and workflow routing. Deep technical details are delegated to specialized Skills.

## Prerequisites

Before using this Skill, ensure the Rotifer CLI is available:

```bash
npx @rotifer/playground --version
```

If you prefer MCP integration instead of CLI, add this to your MCP config:

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

No version pinning needed — both packages resolve to the latest release automatically.

---

## Intent Router

**Every row assumes the user is already asking about Rotifer.** The signals below
route *within* this Skill; they are not reasons to invoke it. A user asking "how
do I get started" or "why is my score 0" without Rotifer in view is asking
someone else.

| User signal (in a Rotifer context) | Sub-capability | Action |
|-------------|---------------|--------|
| What is a Gene / how does Rotifer work / new to Rotifer | **onboarding** | Interactive walkthrough, or `rotifer hello` |
| Create a Gene / scaffold a Gene / wrap this as a Gene | **scaffold** | Natural-language scaffolding |
| F(g) is 0 / `rotifer compile` fails / `rotifer publish` fails | **doctor** | `rotifer doctor` first, then the Gene |
| Find a Gene that / any Gene for / search the registry | **explorer** | `rotifer search` |
| Wrapped to Native / upgrade fidelity / rewrite this Gene | **upgrade** | Fidelity evolution |

When the request is about Rotifer but the sub-capability is unclear, list all
five and let the user choose. When the request is **not** about Rotifer, say so
and stop — do not map it onto the nearest row.

## Related Skills

| Skill | Relationship | When to route |
|-------|-------------|---------------|
| `rotifer-gene` → `modules/dev.md` | Deep technical manual for scaffold / onboarding | User needs full development workflow details |
| `rotifer-gene` → `modules/migration.md` | Deep migration manual for upgrade | After user confirms migration plan |
| `rotifer-arena/SKILL.md` | Comparison & evaluation entry | User wants to compare Genes / run Arena |
| `rotifer-genome/SKILL.md` | Gene composition | User wants to combine multiple Genes into an Agent |

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

## 1. onboarding — Interactive Walkthrough

### Phase 1: Environment Check

```bash
npx @rotifer/playground --version
rotifer doctor
rotifer list
```

If the CLI is missing: `npm i -g @rotifer/playground`, which installs the `rotifer` binary.

`rotifer doctor` checks the TypeScript→WASM toolchain (esbuild / javy). Run it
first: without that toolchain `rotifer compile` fails at the WASM step, and the
error looks like a code problem rather than a missing tool. It exits non-zero
and prints the install line when something is absent.

### Phase 2: Core Concepts

| Concept | One-liner | Analogy |
|---------|-----------|---------|
| Gene | Self-contained logic unit: `express(input) → output` | Function |
| Fidelity | Native > Hybrid > Wrapped — higher = more secure | Compiler optimization level |
| Arena | Genes compete for ranking via F(g) fitness score | Leaderboard |
| Domain | Two-level category like `content.grammar` | Namespace |
| phenotype.json | Gene metadata | package.json |
| R(g) / V(g) | Reputation score / Security score | Credit rating |

### Phase 3: Hands-on Experience

Two paths — pick by what the user wants first, a result or an understanding.

**Fastest result — `rotifer hello`:**

```bash
rotifer hello
```

An interactive builder: pick one of six templates (quality-advisor,
uiux-diagnosis, content-analysis, code-security, doc-qa, web3-toolkit), and it
selects Genes, composes them, creates the Agent and runs it. Use this when the
user wants to *see* Rotifer work before learning what a Gene is.
`rotifer hello --list-templates` shows what is on offer; `--template <id>`,
`--input <json>`, `--file <path>` and `--dir <path>` skip the prompts.

**Full lifecycle — one command per concept:**

```bash
rotifer init hello-world --domain content.greeting --fidelity Wrapped
rotifer test hello-world
rotifer compile hello-world
rotifer arena submit hello-world
rotifer arena list --domain content.greeting
```

After each step, explain the output and confirm the user understands before proceeding.

### Phase 4: Next Steps

Recommend based on user background:
- Has an existing SKILL.md → scaffold (`rotifer wrap`)
- Wants to browse the ecosystem → explorer
- Wants to dive deeper → route to `rotifer-gene` skill (`modules/dev.md`)

---

## 2. scaffold — Natural-Language Scaffolding

> This sub-capability is **backend-backed**. When network is available, scaffold uses
> the `/api/playground/*` endpoints on rotifer.ai for LLM-assisted Gene generation, V(g) scanning,
> and one-click Cloud publish. The CLI path remains as fallback.

### Phase 1: Intent Extraction

Extract from the user's natural-language description:

| Parameter | Extraction method | Default |
|-----------|------------------|---------|
| name | Generate kebab-case from description | Must confirm |
| domain | Infer two-level domain from functionality | Must confirm |
| fidelity | Needs external API → Hybrid, pure computation → Native, quick prototype → Wrapped | Wrapped |

### Phase 2: Confirm Parameters

Present inferred results to the user, wait for confirmation before executing.

### Phase 3: Scaffold Generation

**Path A — Web Studio (backend-backed, preferred when online):**

Use the rotifer.ai Playground API for LLM-assisted generation:

```
1. POST /api/playground/generate  { prompt, domain }  → { source, phenotype }
2. POST /api/playground/scan      { source }           → { grade, findings }
3. POST /api/playground/publish   { source, phenotype } → { published, grade }
```

The Web Studio UI at `https://rotifer.ai/studio/` provides a visual 3-step flow
(Describe → Create → Publish) that calls these same endpoints.

> **This path sends the user's text to rotifer.ai.** `generate` transmits the
> description they wrote; `scan` transmits the generated source; `publish`
> transmits source and phenotype and makes the Gene public. Say so before
> using it, and offer Path B when the description contains anything the user
> would not post publicly — Path B is entirely local and produces the same
> scaffold without a network call.

**Path B — CLI (local, always available):**

```bash
rotifer init <name> --domain <domain> --fidelity <fidelity>
```

**From an existing SKILL.md:**

```bash
rotifer scan --skills
rotifer wrap <name> --from-skill <path>
```

**From ClawHub:**

```bash
rotifer wrap <name> --from-clawhub <slug>
```

### Phase 4: Verification

```bash
rotifer test <name>
rotifer compile <name>
```

After compilation passes, prompt: publish to Cloud (`rotifer publish`) or submit to Arena (`rotifer arena submit`).

`rotifer publish` defaults to uploading to the Rotifer Cloud Registry.
Disable with `rotifer config set default-publish false` or `ROTIFER_AUTO_PUBLISH=false`.

### Offline Fallback

If the Playground API is unreachable, display:

> Network unavailable. Use `rotifer init` for local-only Gene creation.

Then follow Path B (CLI).

For deeper development details (inputSchema design, express function implementation) → route to `rotifer-gene` skill (`modules/dev.md`).

---

## 3. doctor — Diagnostics & Repair

### Decision Tree

```text
User reports a problem
 |
 +-- F(g) = 0 or abnormally low score
 |   +-- Does rotifer test <name> pass?
 |   |   +-- Fails → Check if express() return value matches outputSchema
 |   |   +-- Passes → Check if phenotype.json domain is reasonable
 |   +-- Are there competitors in the same domain?
 |       +-- Yes → Analyze competitor strengths, suggest optimizations
 |
 +-- Publish failed
 |   +-- Does rotifer compile <name> succeed?
 |   |   +-- Fails → rotifer doctor first, then syntax errors / missing dependencies
 |   |   +-- Succeeds → rotifer whoami — signed in at all, and as whom?
 |   |                  Then check network connectivity
 |   +-- Is phenotype.json format valid?
 |
 +-- Compilation failed
 |   +-- FIRST: rotifer doctor — is the TS→WASM toolchain even installed?
 |   |   +-- Reports esbuild / javy missing → install those; the code is not the problem
 |   +-- Check the exported express function signature in index.ts
 |   +-- Check inputSchema / outputSchema in phenotype.json
 |   +-- Check if fidelity declaration matches actual code
 |       +-- Declared Native but has fetch calls → Change to Hybrid or remove network calls
 |
 +-- Runtime error
     +-- rotifer test <name> --verbose
     +-- Check if input conforms to inputSchema
     +-- Check if express() handles edge cases correctly
```

### Common Diagnostic Commands

```bash
rotifer doctor                       # TS→WASM toolchain — run this before blaming the code
rotifer test <name>
rotifer vg <path>                    # V(g) security scan — grade A–D, or ? for a code-free Skill
rotifer list
rotifer arena list --domain <domain>
rotifer arena watch <domain>         # live ranking movement (Ctrl+C to stop)
```

`rotifer doctor` takes no arguments and checks one thing: whether esbuild and
javy are present and reachable on `PATH`. A missing toolchain surfaces as a
compile failure that reads like a code error, so it is the cheapest first move
on any "compilation failed" report.

### Quick Reference

| Symptom | Root cause | Fix |
|---------|-----------|-----|
| F(g) = 0 | express() returns empty or format mismatch | Fix return value to match outputSchema |
| Compilation failed | TypeScript type error | Check express function signature |
| Publish timeout | Cloud credentials expired | `rotifer whoami` to check, then `rotifer login` |
| Arena ranking dropped | Stronger competitor appeared in same domain | `rotifer arena watch <domain>` to see who moved, then optimize or upgrade fidelity |
| Fidelity mismatch | Native declared but has fetch calls | Remove network calls or change declaration to Hybrid |
| `compile` fails but the code looks fine | esbuild / javy missing from the toolchain | `rotifer doctor`, then install what it names |

---

## 4. explorer — Ecosystem Search

### Phase 1: Understand the Need

Extract from user description: functionality keywords, target domain, fidelity preference.

### Phase 2: Search

`rotifer search` is the ecosystem search — it queries the Cloud registry, which
is where Genes published by other people live. `arena list` ranks what is
already in the Arena and `list` shows what is on this machine; all three answer
different questions, so pick by what the user asked for.

```bash
rotifer search <query>                        # the ecosystem — Cloud registry
rotifer search <query> --domain <domain> --fidelity Native --sort downloads
rotifer arena list --domain <domain>          # ranked competitors in one domain
rotifer list                                  # what is already installed here
```

Follow up on a specific result:

```bash
rotifer info <gene-ref>               # full details, local or Cloud
rotifer reputation <gene-ref>         # R(g) — the reputation column below
rotifer stats <gene-ref>              # downloads: 7d / 30d / 90d / all time
rotifer versions @owner/<name>        # version history chain
rotifer compare <ref-a> <ref-b>       # 2–5 published Genes, side by side
```

`rotifer reputation @username` scores a creator instead of a Gene, and
`--leaderboard` ranks creators.

### Phase 3: Result Analysis

Display search results in a table:

| Field | Description |
|-------|-------------|
| name | Gene name |
| domain | Category |
| fidelity | Native / Hybrid / Wrapped |
| F(g) | Fitness score |
| R(g) | Reputation score |

### Phase 4: Recommendation

- Found a matching Gene → suggest install: `rotifer install <name>`
- Found a partial match → suggest fork and modify, or submit an Arena challenge (route to `rotifer-arena/SKILL.md`)
- Nothing found → suggest creating a new Gene (route to scaffold)

---

## 5. upgrade — Fidelity Evolution

### Phase 1: Assess Current State

```bash
rotifer list
```

Check the target Gene's phenotype.json — confirm current fidelity and express() implementation.

### Phase 2: Migration Path Decision

| Current | Target | Condition | Path |
|---------|--------|-----------|------|
| Wrapped | Native | Functionality can be implemented as pure computation | Rewrite express(), remove all external calls |
| Wrapped | Hybrid | Must call external APIs | Add WASM shell + allowedDomains whitelist |
| Hybrid | Native | Can internalize API dependencies | Replace API calls with local algorithms |

### Phase 3: Execute Migration

After confirming the migration plan, route to `rotifer-gene` skill (`modules/migration.md`) for the full migration workflow.

### Phase 4: Verification

```bash
rotifer test <name>
rotifer vg <path-to-gene>
rotifer compile <name>
rotifer arena submit <name>
rotifer arena watch <domain>
```

A fidelity upgrade rewrites the Gene's code, so the V(g) security grade it
earned before the rewrite no longer describes it — `rotifer vg` re-scans and
returns A–D (or `?` when there is no `src/`). Compare F(g) before and after to
confirm ranking continuity; `arena watch` shows the move happening rather than
requiring a second `arena list`.
