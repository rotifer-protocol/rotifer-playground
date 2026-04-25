# Getting Started

This guide walks you through the full Rotifer gene lifecycle in about 10 minutes — from Agent workspace setup to running a multi-gene Agent pipeline.

## Prerequisites

- **Node.js** >= 20.0.0
- **npm** >= 9
- (Optional) **Rust toolchain** — only needed for building the NAPI bridge from source

> **v0.3 New:** `rotifer compile` now auto-compiles TypeScript genes to Native WASM via [Javy](https://github.com/bytecodealliance/javy). No separate Rust/WASM toolchain required!

## 1. Initialize an Agent Workspace

```bash
npx -y @rotifer/playground@latest init my-agent
cd my-agent
```

Expected output:

```
  Rotifer Protocol - Agent Workspace Initialization
  ───────────────────────────────────────────
✓ Agent workspace scaffolding created
ℹ Installing Genesis genes...
✓ 5 Genesis genes installed

  Arena Rankings
  ────────────────
  #   Name                        Domain        F(g)    Fidelity
  ────────────────────────────────────────────────────────────────
  1   genesis-web-search          search        0.87    Native
  2   genesis-code-format         tooling       0.81    Native
  3   genesis-l0-constraint       safety        0.79    Native
  4   genesis-web-search-lite     search        0.77    Native
  5   genesis-file-read           filesystem    0.74    Native

✓ Agent workspace ready: my-agent
```

Your project now contains:

```
my-agent/
├── rotifer.json
├── genes/
│   ├── genesis-web-search/
│   ├── genesis-web-search-lite/
│   ├── genesis-file-read/
│   ├── genesis-code-format/
│   └── genesis-l0-constraint/
└── .rotifer/
    └── arena.db
```

## 2. Scan for Candidate Functions

Point `rotifer scan` at any directory containing TypeScript or Rust source files to discover functions that can become genes.

```bash
rotifer scan genes/
```

The scanner detects exported functions and reports their compatibility:

```
  Source Scan Results
  ────────────────────
  File                            Functions Found
  genes/genesis-web-search/index.ts    1 (express)
  genes/genesis-code-format/index.ts   1 (express)
  ...

✓ Scan complete: 5 candidate functions found
```

## 3. Wrap a Function as a Gene

Create a simple function and wrap it:

```bash
mkdir -p genes/hello-world
```

Create `genes/hello-world/index.ts`:

```typescript
interface Input {
  name: string;
}

interface Output {
  greeting: string;
}

export async function express(input: Input): Promise<Output> {
  return {
    greeting: `Hello, ${input.name}! Welcome to the Rotifer Protocol.`,
  };
}
```

Now wrap it:

```bash
rotifer wrap hello-world
```

This generates `genes/hello-world/phenotype.json` — the gene's metadata describing its domain, input/output schemas, fidelity, and semantic requirements.

## 4. Test in the L2 Sandbox

```bash
rotifer test hello-world
```

Expected output:

```
  Gene Test: hello-world
  ────────────────────────
✓ Phenotype loaded
✓ Input schema valid
✓ Output schema valid
✓ express() returned result
✓ Output conforms to schema
✓ Execution time: 2ms

  Result: 6/6 checks passed
```

The test runner executes the gene — compiled genes run through the **WASM sandbox** with fuel metering, memory isolation, and L0 gate checks; uncompiled genes fall back to Node.js `import()` with a warning. It generates input from the schema, validates the output, and verifies IR integrity. Use `--compliance` for structural compliance checks (sandbox verification, fuel metering, L0 gate, phenotype completeness, F(g) computability, IR integrity).

Use `--verbose` for detailed output:

```bash
rotifer test hello-world --verbose
```

## 5. Compile to Rotifer IR

```bash
rotifer compile hello-world
```

**v0.3: Auto TS→WASM compilation.** If the gene has an `index.ts` or `index.js` file and no pre-compiled `gene.wasm`, the compiler automatically runs the Javy pipeline:

```
index.ts → esbuild (strip types) → Javy (QuickJS→WASM) → Rotifer IR (custom sections)
```

This produces a Native-fidelity gene without any manual WASM toolchain setup.

You can also provide pre-compiled WASM directly:

```bash
rotifer compile hello-world --wasm path/to/hello.wasm
```

The IR compiler injects Rotifer custom sections (version, phenotype, constraints, metering) into the WASM binary, producing a portable `.wasm` file under `genes/hello-world/gene.ir.wasm`.

## 6. Submit to the Arena

```bash
rotifer arena submit hello-world
```

The Arena runs an admission gate: it tests the gene in the L2 sandbox, computes the fitness score F(g) and safety score V(g), and registers the gene if both pass the threshold.

```
  Arena Submission: hello-world
  ──────────────────────────────
✓ Gene loaded
✓ Admission tests passed
✓ Fitness: F(g) = 0.57
✓ Safety:  V(g) = 1.00
✓ Registered in Arena

ℹ Fidelity: Wrapped
ℹ Domain:   general
```

## 7. View Arena Rankings

```bash
rotifer arena list
```

All genes are ranked by fitness within their domain:

```
  Arena Rankings
  ────────────────
  #   Name                        Domain        F(g)    Fidelity
  ────────────────────────────────────────────────────────────────
  1   genesis-web-search          search        0.87    Native
  2   genesis-code-format         tooling       0.81    Native
  3   genesis-l0-constraint       safety        0.79    Native
  4   genesis-web-search-lite     search        0.77    Native
  5   genesis-file-read           filesystem    0.74    Native
  6   hello-world                 general       0.57    Wrapped
```

Filter by domain:

```bash
rotifer arena list --domain search
```

## 8. Create an Agent

An Agent assembles a **genome** — a composition of genes selected from the Arena.

```bash
rotifer agent create greeter-bot --genes hello-world genesis-code-format
```

Or auto-select the top genes from a domain:

```bash
rotifer agent create search-agent --domain search --top 2
```

```
  Agent Created: search-agent
  ─────────────────────────────
  Genome (Seq):
    1. genesis-web-search
    2. genesis-web-search-lite

✓ Agent saved to .rotifer/agents/search-agent.json
```

## 9. Run the Agent

Execute the agent's genome as a sequential pipeline. Each gene's output feeds as input to the next gene.

```bash
rotifer agent run greeter-bot --input '{"name":"World"}'
```

```
  Agent Run: greeter-bot
  ────────────────────────
  Pipeline: hello-world → genesis-code-format

  Step 1/2: hello-world
  ✓ Result: {"greeting":"Hello, World! Welcome to the Rotifer Protocol."}

  Step 2/2: genesis-code-format
  ✓ Result: {"formatted":"...","changed":true,"language":"json"}

  Final Output:
  {"formatted":"...","changed":true,"language":"json"}

✓ Pipeline complete (2 genes, 15ms)
```

Use `--verbose` to see intermediate inputs and outputs at each step.

---

## What's Next?

- **Write a Native gene**: Write in TypeScript and `rotifer compile` will auto-compile to WASM via Javy — or use Rust/AssemblyScript for hand-optimized WASM
- **Explore composition**: Use `Seq`, `Par`, `Cond`, `Try`, and `Transform` operators to build complex gene pipelines (see `templates/composition/`)
- **Read the spec**: [Rotifer Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)

## Troubleshooting

### `rotifer: command not found`

Install globally: `npm install -g @rotifer/playground`, or use `npx @rotifer/playground` as a prefix.

### `rotifer test` fails with "no express() export"

Your gene's `index.ts` must export an `express` function as its default entry point. Check the function signature matches the template.

### Fitness score is low

Wrapped genes have an inherent fidelity penalty. Use `rotifer compile` to auto-compile TypeScript to Native WASM for higher fitness potential. Ensure your gene's `express()` function runs quickly and returns well-structured output.

### NAPI binding not found

The NAPI bridge is optional. Without it, the CLI falls back to TypeScript-only mode. To enable Native IR compilation, build the Rust core: `cd crates/rotifer-napi && napi build --release`.
