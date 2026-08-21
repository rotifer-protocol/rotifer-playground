# Gene Security Audit

## 1. When to Audit

| Trigger | Scope |
|---------|-------|
| After a batch of `rotifer publish` | Every uploaded Gene |
| After a major change to Skill content | The Wrapped Gene built from it |
| Security incident (leaked credential, repository visibility change) | Every Gene |
| Periodic review | Every Gene |
| A new Gene type or a change to the file layout | Affected Genes |
> Add a row when you find another trigger.

## 2. Four Layers

```
Layer 1: local file scan       → §3
Layer 2: publish pipeline      → §4
Layer 3: Cloud-side check      → §5
Layer 4: build artifact hygiene → §6
```

Each layer runs on its own. Run them in order for a full audit.

---

## 3. Layer 1 — Local File Scan

### 3.1 Files to scan

A Gene directory may hold any of these. Scan all of them:

| File | Kind | What it is |
|------|------|------------|
| `SKILL.md` | Wrapped Gene body | The content a Skill-to-Gene conversion carries |
| `index.ts` | Native / Hybrid Gene body | TypeScript logic |
| `phenotype.json` | Gene metadata | domain, schema, version |
| `README.md` | Documentation | Optional; uploaded to Cloud |
| `.gene-manifest.json` | Build artifact | Local only, never uploaded |
| `.cloud-manifest.json` | Publish record | cloud_id, owner, published_at |
> Add a row when a Gene gains another file type.

### 3.2 Sensitive patterns

Run these as a full-text regex sweep. A match is a suspected leak until you have
looked at it.

```
# Credentials
/Users/\w+                    → local user path (leaks a username)
glpat-[A-Za-z0-9_-]+          → GitLab personal access token
ghp_[A-Za-z0-9]+              → GitHub personal access token
sk-[A-Za-z0-9]{20,}           → OpenAI / Stripe style API key
eyJhbG[A-Za-z0-9+/=]{50,}     → base64 JWT (could be a service_role key)

# Infrastructure
[a-z]{20}\.supabase\.co       → a real Supabase project ref
<PAGES_PROJECT>\.pages\.dev   → a real Cloudflare Pages project name
192\.168\.\d+\.\d+            → private network address
10\.\d+\.\d+\.\d+             → private network address

# Project identifiers
a real GitLab/GitHub numeric project ID, in a GitLab API context
<USERNAME> | <HOSTNAME>       → PII

# Structural
fromSkill.*absolute path      → an absolute path inside .gene-manifest.json
```

> Add a pattern when you find one that got past this list.

**Not a finding:**

- Teaching placeholders (`sk-...`, `glpat-xxx`) — confirm the surrounding text is an example
- Variable names (`SUPABASE_ANON_KEY`) — a name is not a value
- The `*.supabase.co` wildcard — a domain allowlist entry, not a reference to one project
- Generic example hosts: `example.com`, `localhost`
- A public project address such as a published contact email

### 3.3 Scan commands

```bash
GENES_DIR="<PROJECT_ROOT>/rotifer-playground/genes"

# 1. leaked local paths
grep -r '/Users/' "$GENES_DIR" --include='*.{json,md,ts}'

# 2. credential shapes
grep -rE 'glpat-[A-Za-z0-9_-]+|ghp_[A-Za-z0-9]+' "$GENES_DIR"

# 3. a real Supabase ref (substitute your own)
grep -r '<SUPABASE_REF>' "$GENES_DIR"

# 4. a real Cloudflare project name
grep -rE '<PAGES_PROJECT>\.pages\.dev' "$GENES_DIR"

# 5. private network addresses
grep -rE '192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+' "$GENES_DIR"

# 6. JWTs
grep -rE 'eyJhbG[A-Za-z0-9+/=]{50,}' "$GENES_DIR"

# 7. a real GitLab project ID (substitute your own)
grep -rE '<GITLAB_PROJECT_ID>' "$GENES_DIR"

# 8. PII
grep -rE '<USERNAME>|<HOSTNAME>' "$GENES_DIR"
```

> Substitute `<SUPABASE_REF>`, `<GITLAB_PROJECT_ID>` and the rest before running.
> Keep the real values wherever your deployment records them; they do not travel
> with this Skill.

### 3.4 Reading the results

| What matched | Verdict | What to do |
|--------------|---------|------------|
| A real credential in code or config | **CRITICAL** | Fix now, then rotate the credential |
| An absolute path in `.gene-manifest.json` | **WARNING** | Rewrite to a relative path (§6.2) |
| A pattern inside a teaching example | **FALSE POSITIVE** | Note the exception, change nothing |
| A private network host in `phenotype.json` | **CRITICAL** | Remove it from `allowedDomains` |

---

## 4. Layer 2 — Publish Pipeline

### 4.1 What the upload actually carries

Confirm which fields `rotifer publish` sends to Cloud:

```
Uploaded (review each for content safety):
  ✅ name          → Gene name
  ✅ domain        → capability domain
  ✅ version
  ✅ fidelity      → Wrapped / Native / Hybrid
  ✅ description
  ✅ phenotype     → the whole phenotype.json (JSON column)
  ✅ wasmBytes     → compiled WASM binary
  ✅ readme        → README.md text

Not uploaded (local artifacts):
  🔒 .gene-manifest.json   → local only; holds the fromSkill path
  🔒 .cloud-manifest.json  → local only; written after a publish
  🔒 the original SKILL.md → copied into the gene directory, not uploaded on its own
```

> **The check that matters**: when the publish path changes — a new uploaded
> field, say — review whether that field can carry sensitive data. Read the
> `publishGene()` call in `src/commands/publish.ts` rather than trusting this list.

### 4.2 WASM contents

A Wrapped Gene usually has no WASM at all, only metadata. For Native and Hybrid
Genes: source compiles to bytecode, which does not normally carry a credential in
the clear. What is worth confirming is that the IR compiler injects no extra path
information into a custom section alongside the phenotype data.

---

## 5. Layer 3 — Cloud-Side Check

### 5.1 Read back what was published

```bash
# every published Gene, with the fields worth scanning
curl -s "${SUPABASE_URL}/rest/v1/genes?published=eq.true&select=id,name,phenotype,description,readme" \
  -H "apikey: ${SUPABASE_ANON_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_ANON_KEY}"
```

### 5.2 What to scan in each record

| Field | Patterns | Note |
|-------|----------|------|
| `phenotype` (JSON) | all of §3.2 | serialize the whole object first |
| `description` (text) | PII, internal URLs | this is what a reader sees |
| `readme` (text) | all of §3.2 | optional, and often the longest field |

### 5.3 Count them against each other

```
Genes with a local .cloud-manifest.json = N
Cloud records with published=true       = M

Expected: N ≤ M (Cloud also holds other people's Genes)
Suspicious: N > M → something is marked published locally but is not on Cloud,
                    which usually means it was unpublished
```

### 5.4 Reading the results

| What matched | Verdict | What to do |
|--------------|---------|------------|
| A real credential in a Cloud `phenotype` | **CRITICAL** | Unpublish now, then rotate |
| An internal URL in a Cloud `readme` | **WARNING** | Republish over it |
| PII in a Cloud `description` | **WARNING** | Fix the description, republish |
| The counts disagree | **INFO** | Find out why; it is often benign |

---

## 6. Layer 4 — Build Artifact Hygiene

### 6.1 `.gitignore`

A public repository has to exclude the local build artifact:

```gitignore
# Gene build artifacts (contain local paths, not for VCS)
.gene-manifest.json
```

```bash
grep -q '.gene-manifest.json' <PROJECT_ROOT>/.gitignore && echo "OK" || echo "MISSING"
```

### 6.2 The `fromSkill` path

`fromSkill` in `.gene-manifest.json` has to be **relative**:

```
❌ "/Users/<USERNAME>/.cursor/skills/translator/SKILL.md"   absolute — leaks a username
✅ "../.cursor/skills/translator/SKILL.md"                  relative
```

```bash
grep -r '/Users/' genes/*/.gene-manifest.json
# expected: no output
```

Rewrite them in bulk:

```python
import json, os

for root, dirs, files in os.walk("genes"):
    manifest = os.path.join(root, ".gene-manifest.json")
    if not os.path.exists(manifest):
        continue
    with open(manifest) as f:
        data = json.load(f)
    if "fromSkill" in data and data["fromSkill"].startswith("/Users/"):
        parts = data["fromSkill"].split("/.cursor/skills/")
        if len(parts) == 2:
            data["fromSkill"] = "../.cursor/skills/" + parts[1]
            with open(manifest, "w") as f:
                json.dump(data, f, indent=2)
                f.write("\n")
```

### 6.3 The domain allowlist

A Hybrid Gene's `network.allowedDomains` must not name a private address:

```
❌ "localhost", "127.0.0.1", "192.168.1.100", "10.0.0.1"
✅ "api.openai.com", "*.supabase.co"
```

> `rotifer publish` already enforces this (the `forbidden` regex in `publish.ts`).
> Wrapping a Gene locally does not, which is why the audit checks it again.

---

## 7. The Report

### 7.1 One audit

```
## Gene Security Audit

Date:    YYYY-MM-DD
Scope:   N local Genes + M Cloud records
Trigger: [batch publish / security incident / periodic review]

### Local scan (Layer 1)

| Check | Hits |
|-------|------|
| leaked local paths | 0 |
| credentials | 0 |
| Supabase project refs | 0 |
| ... | ... |

### Publish pipeline (Layer 2)

Uploaded fields: [as expected / new field found: xxx]

### Cloud side (Layer 3)

| Field | Records scanned | Hits |
|-------|-----------------|------|
| phenotype | M | 0 |
| description | M | 0 |
| readme | M | 0 |

### Build artifacts (Layer 4)

| Check | Status |
|-------|--------|
| .gitignore excludes .gene-manifest.json | ✅ |
| every fromSkill is relative | ✅ |
| no private address in allowedDomains | ✅ |

### Verdict

[clean / N findings, fixed / N findings, outstanding]
```

### 7.2 After a fix

Re-run the layer that found it and confirm the hit count is zero. A fix you did
not re-scan is a fix you are guessing at.

---

## 8. Where This Sits

| Related | How it connects |
|---------|-----------------|
| `modules/dev.md` | The development lifecycle; its pre-publish checklist calls this audit |
| `modules/migration.md` | Fidelity migration; run this audit once a migration lands |
| `rotifer publish` | Enforces the domain allowlist itself — §6.3 covers what it does not |

If your own toolchain has a general credential scanner, run it too. This audit is
narrow on purpose: it knows the shape of a Gene directory and the fields a publish
uploads, and it does not try to be a replacement for a code-wide secret scan.

---

## 9. Extending This

### A new pattern

```
1. add the regex to §3.2
2. add a matching command to §3.3
3. decide in §5.2 whether the Cloud side needs the same check
4. if it has exceptions, list them under "Not a finding" in §3.2
```

### A new file type

```
1. add it to the table in §3.1
2. confirm in §4.1 whether a publish uploads it
3. update the --include argument in §3.3
```

### Toward automation

```
- a pre-publish hook, so the scan runs before an upload rather than after
- a CI job over genes/ on every push
- a scheduled sweep of the Cloud-side records
```
