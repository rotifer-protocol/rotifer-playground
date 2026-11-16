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
# install the CLI once, at the pinned version; this downloads it from npm
npm i -g @rotifer/playground@0.37.0
# an Agent workspace: genesis Genes plus an example hello-world Gene
rotifer init my-workspace
cd my-workspace
mkdir -p genes/my-gene
# write express() in genes/my-gene/index.ts
rotifer wrap my-gene --domain content.grammar --fidelity Native
# replace the empty inputSchema and outputSchema that wrap wrote to genes/my-gene/phenotype.json
rotifer test my-gene --verbose
rotifer compile my-gene
rotifer test my-gene --compliance
```

Without installing, each `rotifer` command also runs as `npx --yes @rotifer/playground@0.37.0 <command>`,
which downloads the package into npm's cache on first use; `--yes` only skips npx's own prompt.

The install names an exact CLI version on purpose: an unversioned install resolves to whatever the
registry serves at that moment, so what you run would not be what was reviewed. Stronger still,
install the CLI into the project and run the local binary:

```bash
npm install --save-dev --save-exact @rotifer/playground@0.37.0
npm exec -- rotifer test my-gene --verbose
```

Commit the lockfile and use `npm ci` in automation. Before moving the pin to a newer release, review
what changed and record what you are accepting: `npm view @rotifer/playground@<version> dist.integrity`.

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
| **Runs** | The `rotifer` CLI, pinned to `@rotifer/playground@0.37.0`. You install it from npm at that exact version (Quick Start), or `npx` fetches it into npm's cache if you run it that way. |
| **Reads** | Genes in the current project — source, `phenotype.json`, and the local manifests. |
| **Writes** | Genes into the project's `genes/`, compiled IR beside them. Outside the project: the CLI's own state in your home directory (`~/.rotifer/`, `~/.config/rotifer/`); when `rotifer compile` runs, the javy toolchain it calls writes its own caches in your user cache folder; and npm's cache or global prefix when the CLI is installed. |
| **Sends** | From the installed CLI, one version check per day to `registry.npmjs.org` (skipped under `npx`, in CI, or with `ROTIFER_NO_UPDATE_CHECK` set), whatever the command; and an anonymous heartbeat each time `run` or `agent run` runs a Gene: a random machine id, the channel it ran from and the CLI version, nothing about the Gene or your files. `rotifer telemetry off`, `ROTIFER_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off. When you are signed in, running a Gene installed from Cloud also records that invocation (the Gene id and your Agent) against your account. Your Gene's source leaves only through `publish`; `arena submit --cloud` sends a published Gene's scores and the runs they were measured on; `login` signs in. A Hybrid or Wrapped Gene's own code, when `test` or `run` executes it, makes its own requests, held to the hosts in its `network.allowedDomains`. Registry and Arena queries go to the public Rotifer API: `arena list --cloud` and `arena watch --cloud` read from it (without `--cloud` they read only the local `genes/`); `install` fetches the Gene and its WASM from it and also records one download (the Gene id and `cli`); and a local `arena submit` (without `--cloud`) asks it for the season's reference scale, sending the Gene's domain and fidelity. When you are signed in, these queries also carry your access token; the WASM download does not. Nothing else is sent. |

Commands that install, publish or overwrite are proposed for your approval first,
never run silently.

## Related Skills

- [`rotifer-guide`](https://clawhub.ai/skill/rotifer-guide) — where to start if you are new to Rotifer
- [`rotifer-arena`](https://clawhub.ai/skill/rotifer-arena) — benchmark a Gene against the field
- [`rotifer-agent`](https://clawhub.ai/skill/rotifer-agent) — compose several Genes into an Agent
- [`rotifer-self-evolving-agent`](https://clawhub.ai/skill/rotifer-self-evolving-agent) — `/evolve`: swap weak Genes for Arena-ranked stronger ones

## Links

- [Rotifer Protocol](https://rotifer.dev)
- [Documentation](https://rotifer.dev/docs)
- [Protocol Specification](https://github.com/rotifer-protocol/rotifer-spec)

## License

Apache-2.0
