# Versioning Model

Rotifer Playground uses `family_lockstep` for plugin and extension surfaces.

## Families

### Root family

Owned by `plugin-source/families.json -> root.version`

Applies to:

- `.cursor-plugin/marketplace.json`
- `.codebuddy-plugin/marketplace.json`
- `plugins/rotifer/.cursor-plugin/plugin.json`
- `plugins/rotifer/.codebuddy-plugin/plugin.json`
- `plugins/rotifer/skills/evolve/SKILL.md`

### VSCode family

Owned by `plugin-source/families.json -> vscode.version`

Applies to:

- `rotifer-vscode/package.json`
- `rotifer-vscode/.cursor-plugin/plugin.json`
- `rotifer-vscode/.codebuddy-plugin/marketplace.json`
- `rotifer-vscode/.codebuddy-plugin/plugin.json`

## Non-goal

The main npm package version in `package.json` is not automatically tied to either family.

## Bump Flow

Use one command per family:

```bash
npm run bump:plugin-family -- root 0.8.5
npm run bump:plugin-family -- vscode 0.8.5
```

That command:

1. updates `plugin-source/families.json`
2. regenerates all dependent outputs
3. keeps the rest of the repo untouched

## Tag Conventions

- main npm package: `vX.Y.Z`
- root plugin family: `root-plugin-vX.Y.Z`
- VSCode family: `vscode-vX.Y.Z`
