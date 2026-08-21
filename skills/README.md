# Published Skills

Each directory here is a Skill published to ClawHub on its own, under its own
version line. They are not part of the `plugins/rotifer` bundle and are not
generated from `plugin-source/`.

| Skill | What it is for |
|---|---|
| [`rotifer-guide`](rotifer-guide/) | Entry point — onboarding, scaffolding a Gene, diagnosing F(g) or a compile failure, registry search, fidelity upgrade |
| [`rotifer-agent`](rotifer-agent/) | Composing an Agent from Genes — capability decomposition, Arena-ranked selection, Genome assembly |
| [`rotifer-arena`](rotifer-arena/) | Benchmarking Genes against each other — import, compile, match, and an F(g)/V(g) report |
| [`rotifer-gene`](rotifer-gene/) | The Gene manual — writing `express` and a phenotype schema, the four-layer security audit, and Wrapped → Hybrid → Native migration |

## How these differ from `plugins/rotifer`

|  | `plugins/rotifer/` | `skills/` (here) |
|---|---|---|
| Where the content comes from | generated from `plugin-source/` | hand-authored; these files are the source |
| Does `npm run sync:plugins` touch it? | yes, it owns those outputs | **no** |
| Ships to | five hosts, inside one bundle | ClawHub, as three separate listings |
| Version | one family version for the whole bundle | each `clawhub.json`, independently |
| Released by | `release-root-plugin-family.yml` | `publish-clawhub-skills.yml` |

The bundle's `assistant` Skill covers the same subject matter at a fraction of
the length — it is a router that gets a reader oriented, while these are the
manuals it orients them toward. Measured before this directory existed: no line
of `assistant` appears verbatim in any of the three, and each side carries
tables the other does not. They are deliberately different depths, so neither
is generated from the other.

What they *do* share is a set of facts — the composition strategies, the
fidelity levels. Those must not drift apart; see the consistency check in
`tests/unit/`.

## Editing one

The files here are the source. Edit, open a PR, and let CI check it. Publishing
is a separate, deliberate step, and it is per Skill: push a
`clawhub-<skill>-v<version>` tag — `clawhub-rotifer-gene-v1.0.0` — or run
`publish-clawhub-skills.yml` by hand and pick one. These are separate listings on
separate version lines, so a tag covering all of them could only match by
accident.

A pull request runs the publish path for every Skill under `--dry-run`, so the
command is exercised on every change instead of being discovered broken on
release day.

Bump the `version` in that Skill's `clawhub.json` in the same PR as the content
change. The tag has to match it, and CI refuses a tag that names a Skill this
repo does not have or a version its manifest does not declare.
