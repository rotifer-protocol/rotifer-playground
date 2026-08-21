# Gene Development

## 1. The Three Axioms

Every Gene has to satisfy all three:

| Axiom | What it means | How it is checked |
|-------|---------------|-------------------|
| **Cohesive** | One Gene does one thing | `domain` goes to the second level (`content.grammar`) |
| **Self-describing** | `inputSchema` + `outputSchema` fully state the capability's boundary | `rotifer test` validates both as JSON Schema |
| **Independently scorable** | Given an input, F(g) is computable without external state | Arena computes fitness on submission |

---

## 2. Fidelity

> Add a row when a level is added.

| Level | What it means | Where it runs | Typical use |
|-------|---------------|---------------|-------------|
| **Native** | All logic lives in WASM | Sandboxed, zero external calls | Pure computation: formatting, validation, conversion |
| **Hybrid** | WASM plus controlled external calls | Sandbox + an `allowedDomains` list | Anything needing an API: translation, search |
| **Wrapped** | A thin shell around an external API | Node.js, directly | Fast prototypes, migrating existing logic |

**Upgrade path:** Wrapped → Hybrid → Native, internalizing external dependencies
as you go.

**Hard rules:**

- A Wrapped Gene must not be labelled Native. Fidelity is declared honestly or not at all.
- Hybrid has to declare `network.allowedDomains`, and localhost and private addresses are refused.
- A Native Gene contains no network call of any kind.

---

## 3. The Workflow

### 3.1 Start one

```bash
# a new Gene
rotifer init my-gene --domain content.grammar --fidelity Native

# or convert a SKILL.md
rotifer scan --skills --skills-path ./my-skills
rotifer wrap grammar-checker --domain content.grammar --from-skill ./SKILL.md
```

What you get:

```
genes/my-gene/
├── phenotype.json    # Gene metadata (required)
├── index.ts          # entry point (exports express)
├── SKILL.md          # optional: capability description
└── README.md         # optional: shown when published
```

### 3.2 Write `express`

A Gene is an `express(input) → output` function:

```typescript
export async function express(input: {
  text: string;
  strict?: boolean;
}): Promise<{
  issues: Array<{ line: number; message: string; severity: string }>;
  score: number;
  summary: string;
}> {
  // Gene logic
  return { issues: [], score: 100, summary: "No issues found" };
}
```

**Requirements:**

- The function is named `express` and is exported.
- Its parameter and return types match the schemas in `phenotype.json`.
- Native: no `fetch`, no `fs`, no `net` — no I/O at all.
- Hybrid: calls go only to hosts in `allowedDomains`.
- Idempotent: the same input produces the same output, or as close as the domain allows.
- **Everything a reader sees is in English** — description, comments, README, error messages, SKILL.md.

### 3.3 Fill in `phenotype.json`

```json
{
  "domain": "content.grammar",
  "description": "Check grammar and spelling issues in text",
  "version": "0.1.0",
  "fidelity": "Native",
  "transparency": "Open",
  "author": "your-name",
  "inputSchema": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "Text to check" },
      "strict": { "type": "boolean", "description": "Enable strict mode" }
    },
    "required": ["text"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "issues": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "line": { "type": "number" },
            "message": { "type": "string" },
            "severity": { "type": "string", "enum": ["error", "warning", "info"] }
          }
        }
      },
      "score": { "type": "number", "minimum": 0, "maximum": 100 },
      "summary": { "type": "string" }
    },
    "required": ["issues", "score", "summary"]
  },
  "dependencies": []
}
```

**Required:** `domain`, `inputSchema`, `outputSchema`, `version`

**Language:** `description`, every `description` inside a schema, and anything else
a reader sees is English. Genes go to a global developer market.

**Hybrid also requires:**

```json
{
  "network": {
    "allowedDomains": ["api.example.com"],
    "maxTimeoutMs": 5000,
    "maxResponseBytes": 1048576,
    "maxRequestsPerMin": 60
  }
}
```

### 3.4 Test it

```bash
# schema validation, execution, output check
rotifer test my-gene

rotifer test my-gene --verbose

# L0 constraint checks
rotifer test my-gene --compliance
```

What `test` covers:

| Check | Note |
|-------|------|
| Phenotype completeness | every required field present |
| Input schema | valid JSON Schema |
| Output schema | valid JSON Schema |
| Generated input | test input derived from the schema |
| Source present | index.ts or index.js exists |
| Execution | the WASM sandbox when an IR exists, otherwise `express()` on Node.js |
| Output conforms | validated with Ajv |
| IR integrity | custom sections verified, when an IR exists |

What `--compliance` adds:

| ID | Check |
|----|-------|
| C1 | Runs in the sandbox |
| C2 | Fuel stays within budget |
| C3 | L0Gate constraints hold |
| C4 | Phenotype is complete |
| C5 | F(g) is computable |
| C6 | IR sections are intact |

### 3.5 Compile to IR

```bash
# TypeScript → WASM → Rotifer IR
rotifer compile my-gene

# check without writing output
rotifer compile my-gene --check

# use a WASM binary you already have
rotifer compile my-gene --wasm ./my-gene.wasm
```

The pipeline:

```
index.ts
  ↓ esbuild (bundled as an IIFE)
  ↓ WASI shim injected (stdin/stdout bridge)
  ↓ Javy (JS → WASM)
gene.wasm
  ↓ rotifer-core IR compiler (Rust)
  ↓ custom sections injected:
  │   • rotifer.version     — IR spec version
  │   • rotifer.phenotype   — metadata subset
  │   • rotifer.constraints — memory / fuel / output limits
  │   • rotifer.metering    — fuel cost per instruction, page, and host call
  ↓ IR module verified
gene.ir.wasm
```

Output:

- `gene.ir.wasm` — the Rotifer IR module
- `.compile-result.json` — geneId, fidelity, irHash, durationMs

### 3.6 Publish

```bash
# once
rotifer login

rotifer publish my-gene --description "Grammar checker for text content"
```

Before you publish:

```
1. ✅ every required phenotype.json field is filled in
2. ✅ rotifer test passes
3. ✅ rotifer compile passes (Native / Hybrid)
4. ✅ version has been bumped — a published version cannot be overwritten
5. ✅ Hybrid: no localhost or private address in allowedDomains
6. ✅ fidelity is declared honestly
7. ✅ description says what the Gene actually does
8. ✅ nothing from the surrounding project came along — no config files,
      no .env, in a directory you converted from a Skill
9. ✅ the security audit in modules/audit.md found nothing
```

What publishing does:

```
rotifer publish
  ↓ read phenotype.json
  ↓ pre-flight (schema, Hybrid network rules)
  ↓ upload gene.ir.wasm → Cloud Storage
  ↓ register metadata in the Gene Registry
  ↓ write .cloud-manifest.json (cloud_id, owner, version)
```

### 3.7 Compete in the Arena

```bash
# local
rotifer arena submit my-gene

# cloud (publish first)
rotifer arena submit my-gene --cloud

rotifer arena list --domain content.grammar

rotifer arena watch content.grammar --interval 5000
```

Admission:

| Metric | Threshold | Meaning |
|--------|-----------|---------|
| F(g) | ≥ 0.3 (τ) | fitness floor |
| V(g) | ≥ 0.7 | security floor |

Fitness is multiplicative:

```
F(g) = [S_r × ln(1 + C_util) × (1 + R_rob)] / [L × R_cost]
```

| Factor | What it measures |
|--------|------------------|
| S_r | success rate |
| C_util | coverage — how completely the output is populated |
| R_rob | robustness against malformed input |
| L | latency score, 1/(1 + avg_latency_ms/1000) |
| R_cost | resource efficiency, 1/(1 + avg_cost/10000) |

**Why multiplicative matters:** any factor at zero eliminates the Gene. There is
no averaging your way past a failure mode.

---

## 4. Naming a Domain

> Add to the reference list when a first-level domain is added.

```
<top-level>.<second-level>[.<variant>]
```

| Shape | Example | Use |
|-------|---------|-----|
| `top.second` | `content.grammar` | the normal case |
| `top.second.variant` | `search.web.google-v2` | several implementations of one domain |

Existing top-level domains:

- `content` — grammar, format, summarize
- `search` — web, local
- `code` — format, lint, review
- `translate` — en-zh, zh-en
- `data` — parse, validate

Rules: lowercase; `.` separates levels; `-` joins words. The domain decides the
Arena bracket — Genes in the same domain compete directly.

---

## 5. Recipes

### 5.1 A Native Gene from scratch

```bash
rotifer init my-gene --domain content.format --fidelity Native
# edit genes/my-gene/index.ts
# edit genes/my-gene/phenotype.json
rotifer test my-gene --verbose
rotifer compile my-gene
rotifer test my-gene --compliance
rotifer publish my-gene
rotifer arena submit my-gene --cloud
```

### 5.2 From a SKILL.md

```bash
rotifer scan --skills --skills-path ./path/to/skills
rotifer wrap my-skill --domain content.grammar --from-skill ./SKILL.md
# review the generated phenotype.json and index.ts
rotifer test my-skill
rotifer compile my-skill
```

### 5.3 A Hybrid Gene

```bash
rotifer init my-api-gene --domain search.web --fidelity Hybrid
# add to phenotype.json:
#   "network": { "allowedDomains": ["api.example.com"], "maxTimeoutMs": 5000 }
# edit index.ts and fetch only from the allowed host
rotifer test my-api-gene
rotifer compile my-api-gene
```

### 5.4 Compose an Agent

```bash
# from named Genes
rotifer agent create my-agent --genes gene-a,gene-b --composition Seq

# or let the Arena ranking choose
rotifer agent create smart-agent --domain content.grammar,content.format --top 1

rotifer agent run my-agent --input '{"text": "Hello wrold"}'
```

---

## 6. When It Goes Wrong

> Add a row when you hit one this table does not cover.

| Error | Cause | Fix |
|-------|-------|-----|
| `Missing required field: domain` | phenotype.json is incomplete | fill in the required fields |
| `No express function exported` | index.ts does not export it | `export async function express(...)` |
| `WASM compilation failed` | Javy could not compile it | check the syntax, and that no Node-only API is used |
| `Hybrid gene missing allowedDomains` | no network allowlist | add the `network` block to phenotype.json |
| `Arena admission denied: F(g) < τ` | fitness below the floor | raise the success rate, cut latency, populate more of the output |
| `localhost in allowedDomains` | a Hybrid Gene pointing at a local address | use the production host |
| `Fidelity mismatch` | declared Native, but there is a network call | declare Hybrid, or remove the call |

---

## 7. Before You Ship

```
□ express is idempotent — same input, same output
□ edge cases handled: empty string, very long text, null fields
□ errors come back through outputSchema — return an error structure, do not throw
□ latency is bounded: Native < 100ms, Hybrid < 2000ms, Wrapped < 5000ms
□ phenotype.description is accurate, not aspirational
□ version follows semver — a breaking change bumps major
□ README.md shows a worked example
□ rotifer test --compliance passes end to end
□ every reader-facing string is English
```

---

## 8. Developing Safely

### 8.1 Honest fidelity

| Rule | Note |
|------|------|
| Declare what is true | fidelity reflects the implementation; Wrapped is never labelled Native |
| The compiler checks | `rotifer compile` detects external calls in the WASM and refuses a contradictory declaration |
| Round down | when unsure, declare the lower fidelity and upgrade once you have confirmed it |

### 8.2 Input safety

```
□ trust no input — validate every field before using it
□ cap string length, so a large input cannot exhaust memory
□ cap JSON nesting depth, so a deep input cannot blow the stack
□ range-check numbers, so arithmetic cannot overflow
□ never interpolate input into a command, a query, or a URL
```

### 8.3 Hybrid network safety

| Rule | Note |
|------|------|
| Smallest allowlist | `allowedDomains` names only what is actually called |
| No private addresses | `localhost`, `127.0.0.1`, `10.*`, `192.168.*` are refused |
| Bounded wait | `maxTimeoutMs` at most 10000 |
| Bounded response | `maxResponseBytes` at most 10MB |
| Bounded rate | set `maxRequestsPerMin` to something the upstream API would accept |

### 8.4 Supply chain

| Situation | What to do |
|-----------|------------|
| Installing someone else's Gene | `rotifer install`, then `rotifer test --compliance` before you use it |
| A Gene with dependencies | verify each one in `dependencies` |
| Version locking | a published version is immutable |
| IR hash | every compile emits `irHash`; use it to verify integrity |

### 8.5 Credentials

```
□ no API key, token, or password anywhere in index.ts
□ a Hybrid Gene authenticates from the runtime environment, never from a literal
□ .cloud-manifest.json carries owner information — keep it out of a public repository
□ rotifer login writes to ~/.rotifer/, which belongs in .gitignore
□ converting a Skill: confirm the directory holds no project configuration
```

---

## 9. Extending This

### A new fidelity level

When the protocol grows one — an Edge or TEE level, say:

```
1. add the variant to the Fidelity enum in rotifer-core/src/types/gene.rs
2. add a row to §2
3. update the fidelity argument validation in the compile command
4. add compliance test cases for it
5. revisit Arena admission — the fitness baseline may differ
```

### A new phenotype field

```
1. add it to the Phenotype struct in rotifer-core/src/types/gene.rs
2. document it in the §3.3 example
3. update phenotype validation in the test command
4. if it reaches the IR, update the custom section the compiler writes
5. keep it optional — already-published Genes must stay valid
```

### A new domain

```
1. add it to the list in §4
2. keep to <top-level>.<second-level>
3. seed it with at least one reference Gene
4. update any search index that filters by domain
```

### A new CLI command

```
1. add the command file under src/commands/
2. register it in src/index.ts
3. add the step to §3
4. add a usage example to §5
5. write its tests
```

---

## 10. Where This Sits

| Related | How it connects |
|---------|-----------------|
| `modules/migration.md` | The upgrade path — Wrapped → Hybrid → Native |
| `modules/audit.md` | The four-layer security audit, before and after a publish |
| `rotifer-arena` (Skill) | Benchmarking a Gene against the field once it compiles |
| `rotifer-agent` (Skill) | Composing several Genes into an Agent |
