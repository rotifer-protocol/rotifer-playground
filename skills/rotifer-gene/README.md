# Rotifer Gene

The reference for building, auditing and upgrading a Gene in
[Rotifer Protocol](https://rotifer.dev).

## What It Does

Three manuals, loaded on demand rather than all at once:

| Manual | Covers |
|--------|--------|
| [`modules/dev.md`](modules/dev.md) | The three axioms, fidelity levels, `express`, phenotype schemas, testing, IR compilation, publishing, Arena admission, domain naming, and what goes wrong |
| [`modules/audit.md`](modules/audit.md) | A four-layer security audit: local file scan, publish pipeline, Cloud-side check, build artifact hygiene — with the patterns, the commands, and how to read a hit |
| [`modules/migration.md`](modules/migration.md) | Wrapped → Hybrid → Native: when to move, how to rewrite a generic schema into a real one, schema compatibility, and how to prove the new implementation is not worse |

## Quick Start

```bash
npx @rotifer/playground init my-gene --domain content.grammar --fidelity Native
# write express() in genes/my-gene/index.ts
npx @rotifer/playground test my-gene --verbose
npx @rotifer/playground compile my-gene
npx @rotifer/playground test my-gene --compliance
```

Read `modules/audit.md` before your first `publish`. It is the difference between
finding a leaked credential on your own disk and finding it in a public registry.

## Core Ideas

**Fidelity is declared honestly.** Native means the logic runs in WASM with no
external calls. Hybrid means WASM plus calls to a declared allowlist. Wrapped
means a thin shell around someone else's API. Labelling a Wrapped Gene Native is
a broken promise, and the compiler will catch it anyway.

**F(g) is multiplicative.** Success rate, coverage and robustness over latency
and cost. Any factor at zero eliminates the Gene — strength elsewhere does not
average it out.

**A published version is immutable.** Bump; do not overwrite.

## What this Skill does on your machine

It has no code of its own — it tells your assistant which `rotifer` commands to
run. That is what its manifest's process-execution, filesystem and network
permissions are for: the CLI acting, not this Skill.

| | |
|---|---|
| **Runs** | The `rotifer` CLI (`@rotifer/playground`), fetched from npm if not installed. |
| **Reads** | Genes in the current project — source, `phenotype.json`, and the local manifests. |
| **Writes** | Genes into the project's `genes/`, compiled IR beside them. Nothing outside the project. |
| **Sends** | Nothing, until you publish. `publish`, `arena submit --cloud` and `login` reach the network; `init`, `test` and `compile` are local. |

Commands that publish or overwrite are proposed for your approval first, never
run silently.

## Related Skills

- [`rotifer-guide`](https://clawhub.ai/skill/rotifer-guide) — where to start if you are new to Rotifer
- [`rotifer-arena`](https://clawhub.ai/skill/rotifer-arena) — benchmark a Gene against the field
- [`rotifer-agent`](https://clawhub.ai/skill/rotifer-agent) — compose several Genes into an Agent

## Links

- [Rotifer Protocol](https://rotifer.dev)
- [Documentation](https://rotifer.dev/docs)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)

## License

Apache-2.0
