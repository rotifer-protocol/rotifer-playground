# Gene Fidelity Migration

## 1. Deciding to Migrate

### 1.1 Signals

| What you see | What it suggests |
|--------------|------------------|
| The Gene has a SKILL.md and no `index.ts` | Migrate to Native or Hybrid |
| The schema is a generic `{prompt} → {result}` | Rewrite the schema in domain terms |
| The capability is pure computation, no API needed | Migrate to **Native** |
| The capability needs an external API — translation, search | Migrate to **Hybrid** |
| A Native Gene in the same domain is beating it in the Arena | Migrate to raise F(g) |
| It has to run sandboxed | Migrate to Native — zero external calls |

### 1.2 Paths

```
Wrapped ──→ Native    pure computation: formatting, validation, parsing, conversion
Wrapped ──→ Hybrid    needs an external API: translation, search, an LLM call
Hybrid  ──→ Native    internalize the dependency: replace the API call with a local algorithm
```

**Not allowed:**

- Native → Wrapped. There is nothing to gain by going backwards.
- Declaring a fidelity you do not have. Labelling a Wrapped Gene Native is a
  breach of the protocol's central promise, not a shortcut.

### 1.3 Before you start

```
□ Can this run entirely locally?
  → yes: target Native
  → no:  target Hybrid

□ Does the SKILL.md contain enough to implement the whole algorithm?
  → yes: write index.ts from it
  → no:  you need research or a reference implementation first

□ Is there a Native Gene in the same domain to learn from?
  → rotifer arena list --domain <domain>

□ Will the migration break anyone already depending on this Gene?
  → if so, keep the phenotype schema backward compatible (§4)
```

---

## 2. Wrapped → Native

For a capability that can run entirely inside the WASM sandbox.

### 2.1 Steps

```
Step 1: read the current Gene
  extract the algorithm from SKILL.md
  note the existing phenotype.json schema

Step 2: design a domain schema
  replace the generic {prompt → result} with the domain's own vocabulary
  write precise inputSchema and outputSchema

Step 3: implement express
  create index.ts exporting express(input) → output
  encode what SKILL.md described as actual logic

Step 4: update phenotype.json
  fidelity: "Native"
  new schema, version bumped (major)
  drop source: "skill" if present

Step 5: prove behavioural equivalence
  run the checks in §5

Step 6: compile and publish
  rotifer compile <gene>
  rotifer publish <gene>
  run the four-layer audit in modules/audit.md
```

### 2.2 Schema, before and after

Before — generic:

```json
{
  "fidelity": "Wrapped",
  "source": "skill",
  "inputSchema": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string" }
    },
    "required": []
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "result": { "type": "string" }
    }
  }
}
```

After — the domain's own:

```json
{
  "fidelity": "Native",
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
            "rule": { "type": "string" },
            "message": { "type": "string" },
            "position": { "type": "number" },
            "suggestion": { "type": "string" }
          },
          "required": ["rule", "message", "position", "suggestion"]
        }
      },
      "score": { "type": "number", "minimum": 0, "maximum": 100 },
      "summary": { "type": "string" }
    },
    "required": ["issues", "score", "summary"]
  }
}
```

What changed: `prompt` became the fields the domain actually has; `result` became
a structured output; `required` now constrains both; and every `description` is
in English.

### 2.3 Writing `express`

```typescript
// ❌ the Wrapped shape — leaning on an external model to interpret SKILL.md
export async function express(input: { prompt: string }): Promise<{ result: string }> {
  return { result: "AI generated response" };
}

// ✅ the Native shape — the logic is here
export async function express(input: {
  text: string;
  strict?: boolean;
}): Promise<{
  issues: Array<{ rule: string; message: string; position: number; suggestion: string }>;
  score: number;
  summary: string;
}> {
  const issues = [];

  // real detection: regex, a state machine, an AST walk — whatever the domain needs
  const rules = [
    { id: "double-space", pattern: /  +/g, message: "Multiple consecutive spaces" },
    // ... more rules
  ];

  for (const rule of rules) {
    let match;
    while ((match = rule.pattern.exec(input.text)) !== null) {
      issues.push({
        rule: rule.id,
        message: rule.message,
        position: match.index,
        suggestion: "...",
      });
    }
  }

  const score = Math.max(0, 100 - issues.length * 5);
  return { issues, score, summary: `Found ${issues.length} issue(s)` };
}
```

**What Native forbids:**

- `fetch`, `XMLHttpRequest`, any network call
- `fs`, `path`, any filesystem access
- `process`, `os`, any system call

What is left — computation, string handling, regex, arithmetic, data structures —
is enough for more capabilities than it first appears.

---

## 3. Wrapped → Hybrid

For a capability that genuinely needs an external service.

### 3.1 Steps

```
Steps 1-3: as in §2.1

Step 4: declare the network allowlist
  add the network block to phenotype.json
  list only the hosts actually called
  set a timeout and a rate limit you would be comfortable defending

Step 5: implement the call
  fetch only allowlisted hosts
  authenticate from the runtime environment
  handle timeout and retry

Steps 6-7: as §2.1 steps 5-6
```

### 3.2 The network block

```json
{
  "fidelity": "Hybrid",
  "network": {
    "allowedDomains": ["api.example.com"],
    "maxTimeoutMs": 5000,
    "maxResponseBytes": 1048576,
    "maxRequestsPerMin": 60
  }
}
```

```
✅ allowed:
  "api.openai.com"           a public service
  "*.supabase.co"            a wildcard for one provider
  "api.deepl.com"

❌ refused at publish time:
  "localhost"
  "127.0.0.1"
  "10.0.0.1"
  "192.168.1.100"
  "0.0.0.0"
  "[::1]"
```

### 3.3 A Hybrid `express`

```typescript
export async function express(input: {
  text: string;
  targetLang: string;
}): Promise<{
  translated: string;
  sourceLang: string;
  confidence: number;
}> {
  const apiKey = process.env.TRANSLATION_API_KEY;
  if (!apiKey) {
    return { translated: input.text, sourceLang: "unknown", confidence: 0 };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch("https://api.example.com/translate", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: input.text, target: input.targetLang }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return { translated: input.text, sourceLang: "unknown", confidence: 0 };
    }

    const data = await res.json();
    return {
      translated: data.translated_text,
      sourceLang: data.detected_source,
      confidence: data.confidence ?? 1.0,
    };
  } catch {
    return { translated: input.text, sourceLang: "unknown", confidence: 0 };
  } finally {
    clearTimeout(timeout);
  }
}
```

**What Hybrid requires:**

- Every `fetch` target appears in `allowedDomains`.
- The API key comes from the environment. A key in the source is a key in the registry.
- A timeout, via `AbortController`.
- Graceful degradation on failure — return something sensible rather than throwing.
  A Gene that throws scores zero on robustness, and F(g) is multiplicative.

---

## 4. Schema Compatibility

### 4.1 What counts as breaking

| Change | Breaking? | Bump |
|--------|-----------|------|
| `inputSchema` gains an optional field | no | minor |
| `inputSchema` gains a required field | **yes** | **major** |
| `inputSchema` loses a field | **yes** | **major** |
| `outputSchema` gains a field | no | minor |
| `outputSchema` loses a field | **yes** | **major** |
| `outputSchema` changes a field's type | **yes** | **major** |
| `fidelity` changes | no, but declare it | minor |
| `domain` changes | **yes** — it moves Arena brackets | **major** |

### 4.2 Two ways to land it

Going from `{prompt → result}` to a domain schema is breaking by definition.

```
Option A — replace it (simplest while few people depend on the Gene)
  1. change the schema
  2. 0.1.0 → 1.0.0
  3. republish

Option B — run both (worth it once people depend on it)
  1. leave the old Gene at 0.x
  2. publish the new one at 1.0.0 in the same domain
  3. let the Arena decide between them
  4. unpublish the old one once it has stopped winning
```

### 4.3 Version bumps

```
0.1.0 → 1.0.0    Wrapped → Native/Hybrid, schema rewritten
1.0.0 → 1.1.0    a new optional input field
1.1.0 → 2.0.0    a field removed or changed
```

---

## 5. Proving Equivalence

A migration is not done when it compiles. It is done when the new implementation
does at least what the old one did.

### 5.1 Four levels

```
Level 1 — schema conformance
  rotifer test <gene> --compliance

Level 2 — behaviour
  at least 10 cases covering:
    the happy path
    edges: empty string, very long text, unusual characters
    malformed input: missing fields, wrong types
  compare the outputs against the Wrapped version

Level 3 — performance
  latency (Native under 100ms, Hybrid under 2000ms)
  success rate, which must not fall
  output coverage — how much of outputSchema is actually populated

Level 4 — the Arena
  rotifer arena submit <gene>
  compare F(g) before and after; it must clear the 0.3 floor and ideally beat
  the old value
```

### 5.2 A test table

```typescript
const TEST_CASES = [
  { name: "normal input", input: { text: "Hello wrold" }, expectIssues: true },
  { name: "clean input", input: { text: "Hello world." }, expectIssues: false },
  { name: "empty input", input: { text: "" }, expectScore: 100 },
  { name: "long input", input: { text: "A".repeat(10000) }, shouldNotThrow: true },
  { name: "unicode", input: { text: "こんにちは world" }, shouldNotThrow: true },
  { name: "special chars", input: { text: "<script>alert('x')</script>" }, shouldNotThrow: true },
];

for (const tc of TEST_CASES) {
  const result = await express(tc.input);
  // conforms to the schema
  assert(typeof result.score === "number");
  assert(Array.isArray(result.issues));
  assert(typeof result.summary === "string");
  // and does the right thing
  if (tc.expectIssues !== undefined) {
    assert((result.issues.length > 0) === tc.expectIssues);
  }
}
```

---

## 6. Keeping Your Arena Standing

### 6.1 What a fidelity change does

| Situation | What the Arena does |
|-----------|---------------------|
| Republishing under the same name | the registry upserts; Arena history stays attached |
| Wrapped → Native | F(g) usually rises — lower latency, higher success rate |
| Generic schema → domain schema | resubmit; the earlier evaluation is superseded |
| Domain changed | a different bracket, and the old record no longer applies |

### 6.2 If F(g) drops

```
1. submit as soon as the migration lands
2. compare the new F(g) against the old
3. if it fell, find which factor fell with it:
   success rate down  → there is a bug in express
   latency up         → an inefficient path; profile it
   coverage down      → some outputSchema field is coming back null or undefined
```

---

## 7. Migrating Several

### 7.1 Order them

```
First:
  Genes already competing in the Arena — they are under pressure now
  Simple, well-defined algorithms: formatting, validation
  Anything with a Native Gene in the same domain to copy from

Next:
  Genes with an external API dependency — they need a Hybrid design
  Middling complexity: several rules, or a state machine

Later:
  Genes whose value is the knowledge in the SKILL.md itself, where WASM adds little
  Anything depending on a service that is not stable yet
```

### 7.2 One at a time

```
Phase 1 — inventory
  list every Gene at fidelity=Wrapped
  sort by §7.1
  estimate each

Phase 2 — migrate, serially
  follow §2 or §3 per Gene
  test, publish and submit each one before starting the next

Phase 3 — verify
  run the audit in modules/audit.md across all of them
```

Serially, not in parallel: a batch migration that breaks is far harder to
attribute than one that breaks on Gene number three.

### 7.3 Taking inventory

```bash
# Wrapped Genes have a SKILL.md and no index.ts
for d in genes/*/; do
  name=$(basename "$d")
  if [ -f "$d/SKILL.md" ] && [ ! -f "$d/index.ts" ]; then
    echo "WRAPPED (needs migration): $name"
  elif [ -f "$d/index.ts" ]; then
    fidelity=$(python3 -c "import json; print(json.load(open('${d}phenotype.json'))['fidelity'])" 2>/dev/null || echo "unknown")
    echo "HAS CODE ($fidelity): $name"
  fi
done
```

---

## 8. When It Goes Wrong

| Error | Cause | Fix |
|-------|-------|-----|
| `Fidelity mismatch: declared Native but found fetch()` | a network call in express | declare Hybrid, or remove the call |
| `WASM compilation failed: Cannot resolve module 'fs'` | a Node-only module | use plain JS instead |
| F(g) fell after migrating | the new implementation is less complete | handle the edges, populate the whole output |
| `Schema validation failed` | the return value does not match outputSchema | check that every required field is returned |
| Version conflict on publish | the version was not bumped | semver major bump |
| `allowedDomains` refused a call | fetching a host that was never declared | add it to phenotype.json |
| SKILL.md and index.ts disagree | the document describes the old behaviour | update it or remove it |
> Add a row when you hit one this table does not cover.

---

## 9. What to Do With the SKILL.md

After a migration a Gene directory may hold both `SKILL.md` and `index.ts`:

| Situation | What to do |
|-----------|------------|
| They agree | keep it as documentation |
| They disagree | update it, or delete it — a stale document is worse than none |
| It holds things code cannot: design intent, when to use this | keep it, as a README supplement |
| It is a generic template with nothing specific in it | delete it; it only misleads |

---

## 10. Where This Sits

| Related | How it connects |
|---------|-----------------|
| `modules/dev.md` | The groundwork — express, phenotype schemas, testing, compilation |
| `modules/audit.md` | The four-layer audit a migration has to pass before it is done |
| `rotifer-arena` (Skill) | Comparing F(g) before and after |
| `rotifer-agent` (Skill) | Recomposing an Agent once a member Gene changes fidelity |

---

## 11. Extending This

### A new path

When the protocol adds a fidelity level:

```
1. add the direction to the diagram in §1.2
2. write the steps for it
3. add its performance baseline to §5
4. add its failure modes to §8
```

### Toward automation

```
- rotifer migrate <gene> --target Native     a guided migration
- a pre-publish hook that checks the declared fidelity against the code
- a view of what has migrated, what has not, and what failed
```
