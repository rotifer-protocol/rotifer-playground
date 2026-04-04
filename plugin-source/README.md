# Plugin Source of Truth

`plugin-source/` is the canonical source area for Rotifer plugin and extension metadata.

## Release Families

- `root`: the root Cursor + CodeBuddy plugin surfaces in this repository.
- `vscode`: the `rotifer-vscode` extension plus its bundled marketplace manifests.

The main npm package in `package.json` is intentionally separate from both families.

## Ownership Rules

- Edit canonical metadata under `plugin-source/families/`.
- Edit canonical skills and rules under `plugin-source/content/`.
- Edit the shared brand asset under `plugin-source/assets/`.
- Do not hand-edit generated outputs after cutover. Run `npm run sync:plugins` instead.
- Root `.cursor-plugin/` and `.codebuddy-plugin/` stay only as marketplace entrypoints; the actual root-family plugin now lives under `plugins/rotifer/`.

## Generated Outputs

The sync pipeline writes to these existing platform-facing paths:

- `.cursor-plugin/marketplace.json`
- `.codebuddy-plugin/marketplace.json`
- `plugins/rotifer/.cursor-plugin/`
- `plugins/rotifer/.codebuddy-plugin/`
- `plugins/rotifer/skills/`
- `plugins/rotifer/rules/`
- `plugins/rotifer/assets/`
- `rotifer-vscode/package.json`
- `rotifer-vscode/skills/`
- `rotifer-vscode/rules/`
- `rotifer-vscode/assets/`
- `rotifer-vscode/.cursor-plugin/`
- `rotifer-vscode/.codebuddy-plugin/`

## Commands

- `npm run sync:plugins`: regenerate all plugin outputs from `plugin-source/`
- `npm run check:plugins`: fail if generated outputs drift from `plugin-source/`
- `npm run verify:plugins`: verify referenced packaging assets and manifest paths
- `npm run bump:plugin-family -- <root|vscode> <version>`: update one family version and fan it out to generated outputs

## Reference Docs

- `plugin-source/OWNERSHIP.md`: exact source-to-output mapping and preserved hand-authored fields
- `plugin-source/VERSIONING.md`: family lockstep rules and tag conventions
- `plugin-source/CUTOVER.md`: rollout, CI gate, and rollback model

## Cutover Status

Phase C moves the repo to a generated-output model in three steps:

1. Canonical source lives under `plugin-source/`.
2. Existing platform directories stay in place, but become generated outputs.
3. CI blocks drift before any publish automation is enabled.

Release packaging can be automated per family without forcing lockstep with the main npm package.
