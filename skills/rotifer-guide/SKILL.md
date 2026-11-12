---
name: rotifer-guide
description: >-
  Entry point for Rotifer Protocol. Onboards a user to Rotifer Genes, scaffolds a Gene from a
  description, diagnoses a Gene's F(g) score or compile failure, searches the Rotifer Gene
  registry, upgrades a Gene's fidelity from Wrapped to Native, and submits a Gene to the Arena
  and follows its ranking. It works by proposing `rotifer` CLI commands; the ones that install
  software, send work to Rotifer's servers, publish a Gene or overwrite files wait for the
  user's approval. Meant to be invoked explicitly when working with Rotifer, or when unsure
  which Rotifer capability fits. Its scope is Rotifer Genes and the Rotifer CLI; onboarding,
  tutorials, troubleshooting or search for anything else are outside it.
---

# Rotifer Guide — User Entry Point

> This Skill handles intent recognition and workflow routing. Deep technical details are delegated to specialized Skills.

## Prerequisites

Before using this Skill, ensure the Rotifer CLI is available:

```bash
npx --yes @rotifer/playground@0.36.1 --version
```

If you prefer MCP integration instead of CLI, add this to your MCP config:

```json
{
  "mcpServers": {
    "rotifer": {
      "command": "npx",
      "args": ["@rotifer/mcp-server@0.20.0"]
    }
  }
}
```

Both commands name an exact version on purpose. An unversioned `npx` resolves to whatever the
registry serves at that moment, so the code you run would not be the code that was reviewed. The
`@rotifer/mcp-server` pin is the one this repository agrees on everywhere; move it in one deliberate
step, not per file. Stronger than pinning the `npx` call: install the CLI into the project and run
the local binary.

```bash
npm install --save-dev --save-exact @rotifer/playground@0.36.1
npm exec -- rotifer --version
```

Commit the lockfile and use `npm ci` in automation. Before moving a pin to a newer release, review
what changed and record what you are accepting: `npm view @rotifer/playground@<version> dist.integrity`.

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
| [`rotifer-gene`](https://clawhub.ai/skill/rotifer-gene), development manual | Deep technical manual for scaffold / onboarding | User needs full development workflow details |
| [`rotifer-gene`](https://clawhub.ai/skill/rotifer-gene), migration manual | Deep migration manual for upgrade | After user confirms migration plan |
| [`rotifer-arena`](https://clawhub.ai/skill/rotifer-arena) | Comparison & evaluation entry | User wants to compare Genes / run Arena |
| [`rotifer-agent`](https://clawhub.ai/skill/rotifer-agent) | Gene composition | User wants to combine multiple Genes into an Agent |

Each is a separate Skill, installed on its own. When one is not installed, say
so and continue with the commands in this file.

---

## What this Skill does on your machine

It has no code of its own — it tells your assistant which `rotifer` commands to
run. That is why its manifest declares process execution, filesystem read/write
and outbound network access: every one of those is the CLI acting, not this
Skill.

| | |
|---|---|
| **Runs** | The `rotifer` CLI, pinned to `@rotifer/playground@0.36.1`. If it is not installed, `npx` fetches that exact version into npm's cache, `npm i -g` puts it in npm's global prefix, and `npm install --save-dev` keeps it inside the project. |
| **Reads** | Genes and Agent definitions in the current project workspace. |
| **Writes in the project** | Genes into `genes/` (with their compiled output and score caches), and Agent definitions into `.rotifer/agents/`. |
| **Writes outside the project** | The CLI's own state in your home directory: `~/.rotifer/` (a local database, an audit log, a run log, the telemetry setting, and your session token if you run `rotifer login`) and `~/.config/rotifer/` (a daily update-check cache), plus the WASM runtime's compile cache in your user cache folder. Installing the CLI writes to npm's cache, or to npm's global prefix with `npm i -g`. |
| **Sends** | Registry and Arena queries to the public Rotifer API, one version check per day to `registry.npmjs.org` (skipped under `npx`, in CI, or with `ROTIFER_NO_UPDATE_CHECK` set), and a package download from ClawHub for `rotifer wrap --from-clawhub`. When you are signed in, running a Gene installed from Cloud also records that invocation (the Gene id and your Agent) against your account. The CLI also sends an anonymous heartbeat each time it runs a Gene: a random machine id, the channel it ran from and the CLI version, nothing about the Gene or your files. `rotifer telemetry off`, `ROTIFER_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off, and each of the three also stops the signed-in record. Three steps send your work, and each runs only when the user asks for it: the Web Studio scaffold path sends the description and the generated source to rotifer.ai (§2, Path A); `rotifer publish` uploads a Gene's source to the Rotifer Cloud Registry and makes it public; `rotifer arena submit --cloud` sends a published Gene's scores, and the measurements from each run, to the Cloud Arena's public record. Without those, your code stays on this machine. |

Commands that install software, send work off the machine (Path A, `rotifer publish`,
`rotifer arena submit --cloud`) or overwrite files are proposed for your approval
first, never run silently.

---

## 1. onboarding — Interactive Walkthrough

### Phase 1: Environment Check

```bash
npx --yes @rotifer/playground@0.36.1 --version
rotifer doctor
rotifer list
```

If the CLI is missing, propose an install and wait for approval. `npm install
--save-dev --save-exact @rotifer/playground@0.36.1` keeps it in the project (run it
as `npm exec -- rotifer`); `npm i -g @rotifer/playground@0.36.1` installs the
`rotifer` binary at that exact version into npm's global prefix, outside the project.

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

An interactive builder: pick a template, and it selects Genes, composes them,
creates the Agent and runs it. Use this when the user wants to *see* Rotifer
work before learning what a Gene is. In a new workspace, start with
`rotifer hello --template quality-advisor`, the one template whose Genes come
with `rotifer init`. `rotifer hello --list-templates` shows which templates can
run here. The others (uiux-diagnosis, content-analysis, code-security, doc-qa,
web3-toolkit) need Genes first: running one exits 1 and says, Gene by Gene,
whether it can be installed or is not available. `hello` never installs
anything itself. `--template <id>`, `--input <json>`, `--file <path>` and
`--dir <path>` skip the prompts; `--json` puts one JSON document on stdout.

**Full lifecycle — one command per concept:**

```bash
rotifer init hello-world --domain content.greeting   # a workspace with an example hello-world Gene
cd hello-world
rotifer test hello-world
rotifer compile hello-world
rotifer arena submit hello-world                     # scored on this machine; nothing is uploaded
rotifer arena list --domain content.greeting
```

After each step, explain the output and confirm the user understands before proceeding.

### Phase 4: Next Steps

Recommend based on user background:
- Has an existing SKILL.md → scaffold (`rotifer wrap`)
- Wants to browse the ecosystem → explorer
- Wants to dive deeper → route to the `rotifer-gene` Skill (its development manual)

---

## 2. scaffold — Natural-Language Scaffolding

> This sub-capability has two paths. The local CLI path (Path B) is the default and
> needs no network. When the user chooses it, the Web Studio path (Path A) uses the
> `/api/playground/*` endpoints on rotifer.ai for LLM-assisted Gene generation, V(g)
> scanning, and Cloud publish.

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

Start with Path B. Offer Path A when the user wants LLM-assisted generation, and
use it only after they agree to send their description to rotifer.ai.

**Path A — Web Studio (sends text to rotifer.ai; only when the user chooses it):**

Use the rotifer.ai Playground API for LLM-assisted generation. `publish` is a
separate step that makes the Gene public, so ask again before calling it:

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

**Path B — CLI (local, the default):**

```bash
rotifer init <workspace>        # once: an Agent workspace, not a Gene
cd <workspace>
mkdir -p genes/<name>           # then write genes/<name>/index.ts
rotifer wrap <name> --domain <domain> --fidelity <fidelity>
```

`wrap` writes `phenotype.json` with empty schemas; fill in the real
`inputSchema` and `outputSchema` before Phase 4.

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

A Gene wrapped from a SKILL.md has no source file (one from ClawHub has one
only if the package shipped it), so `rotifer test` fails on it with `No gene
source file found`. Run `rotifer compile <name>` and `rotifer vg genes/<name>`
for it instead.

After compilation passes, offer the next step and wait for the user's choice:
`rotifer arena submit <name>` scores the Gene on this machine; `rotifer publish
<name>` uploads its source to the Rotifer Cloud Registry and makes it public.

`rotifer publish` defaults to uploading to the Rotifer Cloud Registry.
Disable with `rotifer config set default-publish false` or `ROTIFER_AUTO_PUBLISH=false`.

### Offline Fallback

If the Playground API is unreachable, display:

> Network unavailable. Use `rotifer init` for local-only Gene creation.

Then follow Path B (CLI).

For deeper development details (inputSchema design, express function implementation) → route to the `rotifer-gene` Skill (its development manual).

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
- Found a partial match → suggest fork and modify, or submit an Arena challenge (route to the `rotifer-arena` Skill)
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

After confirming the migration plan, route to the `rotifer-gene` Skill (its migration manual) for the full migration workflow.

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
