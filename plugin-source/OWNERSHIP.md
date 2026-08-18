# Ownership Map

This file defines which plugin-facing files are canonical sources and which files are generated outputs.

## Canonical Source Inputs

| Canonical file | Purpose |
|---|---|
| `plugin-source/families.json` | Family versions and release tags |
| `plugin-source/families/root.json` | Root Cursor + CodeBuddy + OpenClaw/ClawHub manifest metadata |
| `plugin-source/families/vscode.json` | VSCode-family manifest metadata and package sync fields |
| `plugin-source/content/root/dsh/cordis.patch.yml` | Root family DeepSeek Harness bundle patch (template) |
| `plugin-source/content/root/evolve/SKILL.md` | Root family `evolve` skill |
| `plugin-source/content/root/hello/SKILL.md` | Root family `hello` skill |
| `plugin-source/content/root/assistant/SKILL.md` | Root family `assistant` skill |
| `plugin-source/content/shared/rotifer-gene-dev.mdc` | Shared gene development rule |
| `plugin-source/content/root/rotifer.md` | Root family generic Rotifer skill |
| `plugin-source/content/vscode/rotifer.md` | VSCode family Rotifer skill |
| `plugin-source/content/vscode/rotifer-conventions.mdc` | VSCode family rule |
| `plugin-source/assets/brandmark.svg` | Canonical brand vector source |
| `plugin-source/assets/brandmark.png` | Canonical 128x128 marketplace icon raster |

## Generated Outputs

| Generated output | Source |
|---|---|
| `.cursor-plugin/marketplace.json` | `plugin-source/families/root.json` |
| `.codebuddy-plugin/marketplace.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/.cursor-plugin/plugin.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/.codebuddy-plugin/plugin.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/openclaw.plugin.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/.claude-plugin/plugin.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/package.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/cordis.patch.yml` | `plugin-source/content/root/dsh/cordis.patch.yml` + `plugin-source/families/root.json` |
| `plugins/rotifer/skills/evolve/SKILL.md` | `plugin-source/content/root/evolve/SKILL.md` |
| `plugins/rotifer/rules/rotifer-gene-dev.mdc` | `plugin-source/content/shared/rotifer-gene-dev.mdc` |
| `plugins/rotifer/skills/rotifer.md` | `plugin-source/content/root/rotifer.md` |
| `plugins/rotifer/assets/icon.png` | `plugin-source/assets/brandmark.png` |
| `rotifer-vscode/.cursor-plugin/plugin.json` | `plugin-source/families/vscode.json` + `plugin-source/families.json` |
| `rotifer-vscode/.codebuddy-plugin/marketplace.json` | `plugin-source/families/vscode.json` + `plugin-source/families.json` |
| `rotifer-vscode/.codebuddy-plugin/plugin.json` | `plugin-source/families/vscode.json` + `plugin-source/families.json` |
| `rotifer-vscode/skills/rotifer.md` | `plugin-source/content/vscode/rotifer.md` |
| `rotifer-vscode/rules/rotifer-conventions.mdc` | `plugin-source/content/vscode/rotifer-conventions.mdc` |
| `rotifer-vscode/icon.png` | `plugin-source/assets/brandmark.png` |
| `rotifer-vscode/assets/logo.png` | `plugin-source/assets/brandmark.png` |

## Hand-Authored Files Inside a Generated Folder

`plugins/rotifer/` holds two files the sync step does not own and does not
overwrite:

- `README.md` — the plugin's marketplace page
- `index.js` — the entry point the OpenClaw manifest's `extensions` field names

Both are hand-authored on purpose. Everything else in that folder is generated;
edit the source under `plugin-source/` and run `npm run sync:plugins`.

## One Folder, Five Hosts

`plugins/rotifer/` carries a marker directory per host — `.cursor-plugin/`,
`.codebuddy-plugin/`, `.claude-plugin/` — plus `openclaw.plugin.json` and
`package.json` for OpenClaw and ClawHub, and `package.json#dsh` plus
`cordis.patch.yml` for DeepSeek Harness. They share one version and one set of
skills, because a second copy of the same skills maintained beside the first is
how the two drift apart without anyone noticing.

The DSH patch does not restate the MCP launch line. `renderDshPatch` reads it
from the same `openclawPackage.openclaw.mcpServers` object OpenClaw ships, so the
pin and the `--tools=evolve` narrowing cannot diverge between the two hosts —
that divergence, across marketplaces, is the defect PR #188 closed.

`plugin-source/families/root.json -> dshBundle` holds only what DSH alone needs:
the measured schema cost of the mounted tool set and the dsh version it was
measured on. Re-measure and update it when the tool set changes.

## Hand-Authored VSCode Fields

`rotifer-vscode/package.json` is only partially generated. The sync step preserves the file and only updates the fields owned by `plugin-source/families/vscode.json` plus the family version.

The following sections remain hand-authored in `rotifer-vscode/package.json`:

- `main`
- `contributes`
- `scripts`
- `devDependencies`
- test/runtime-specific metadata not declared in `plugin-source/families/vscode.json`

## Workflow Rule

- Change canonical files in `plugin-source/`.
- Regenerate outputs with `npm run sync:plugins`.
- Never manually patch a generated output unless you are deliberately changing the generator contract.
- Legacy root outputs from the pre-Phase-C layout are considered obsolete drift and are removed by `npm run sync:plugins`.
