# Cutover Plan

This repository uses a staged cutover so marketplace-facing paths stay stable while the source of truth moves to `plugin-source/`.

## Stage 1: Canonical Source Introduced

Status: complete in Phase C.

- `plugin-source/` now owns family metadata, shared content, and brand assets.
- Existing plugin and extension directories remain in place.
- Root marketplace entrypoints stay at `.cursor-plugin/` and `.codebuddy-plugin/`, while the actual root-family plugin content now lives under `plugins/rotifer/`.

## Stage 2: Generated Outputs Enforced

Status: complete in Phase C.

- `npm run sync:plugins` rewrites all generated outputs.
- `npm run check:plugins` fails on drift.
- `npm run verify:plugins` validates family versions, manifest references, and packaging assets.

## Stage 3: CI and Release Gates

Status: complete in Phase C.

- CI verifies sync drift before merge.
- Release flows split by family:
  - main npm package release
  - root plugin family release
  - VSCode family release
- Packaging verification happens before publish steps.

## Rollout Rule

During migration, generated files remain committed so existing marketplace paths do not change. After cutover:

- humans edit `plugin-source/*`
- CI blocks direct drift
- releases read versions from `plugin-source/families.json`
- obsolete pre-cutover root outputs are removed automatically during sync

## Rollback

If the generator contract breaks:

1. revert the `plugin-source/` change that introduced the break
2. rerun `npm run sync:plugins`
3. confirm `npm run check:plugins` and `npm run verify:plugins` pass

No marketplace path changes are required for rollback.
