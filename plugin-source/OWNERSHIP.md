# Ownership Map

This file defines which plugin-facing files are canonical sources and which files are generated outputs.

## Canonical Source Inputs

| Canonical file | Purpose |
|---|---|
| `plugin-source/families.json` | Family versions and release tags |
| `plugin-source/families/root.json` | Root Cursor + CodeBuddy manifest metadata |
| `plugin-source/families/vscode.json` | VSCode-family manifest metadata and package sync fields |
| `plugin-source/content/root/evolve/SKILL.md` | Root family `evolve` skill |
| `plugin-source/content/shared/rotifer-gene-dev.mdc` | Shared gene development rule |
| `plugin-source/content/root/rotifer.md` | Root family generic Rotifer skill |
| `plugin-source/content/vscode/rotifer.md` | VSCode family Rotifer skill |
| `plugin-source/content/vscode/rotifer-conventions.mdc` | VSCode family rule |
| `plugin-source/assets/brandmark.svg` | Canonical brand art source |

## Generated Outputs

| Generated output | Source |
|---|---|
| `.cursor-plugin/marketplace.json` | `plugin-source/families/root.json` |
| `.codebuddy-plugin/marketplace.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/.cursor-plugin/plugin.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/.codebuddy-plugin/plugin.json` | `plugin-source/families/root.json` + `plugin-source/families.json` |
| `plugins/rotifer/skills/evolve/SKILL.md` | `plugin-source/content/root/evolve/SKILL.md` |
| `plugins/rotifer/rules/rotifer-gene-dev.mdc` | `plugin-source/content/shared/rotifer-gene-dev.mdc` |
| `plugins/rotifer/skills/rotifer.md` | `plugin-source/content/root/rotifer.md` |
| `plugins/rotifer/assets/icon.png` | Generated brand PNG |
| `rotifer-vscode/.cursor-plugin/plugin.json` | `plugin-source/families/vscode.json` + `plugin-source/families.json` |
| `rotifer-vscode/.codebuddy-plugin/marketplace.json` | `plugin-source/families/vscode.json` + `plugin-source/families.json` |
| `rotifer-vscode/.codebuddy-plugin/plugin.json` | `plugin-source/families/vscode.json` + `plugin-source/families.json` |
| `rotifer-vscode/skills/rotifer.md` | `plugin-source/content/vscode/rotifer.md` |
| `rotifer-vscode/rules/rotifer-conventions.mdc` | `plugin-source/content/vscode/rotifer-conventions.mdc` |
| `rotifer-vscode/icon.png` | Generated brand PNG |
| `rotifer-vscode/assets/logo.png` | Generated brand PNG |

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
