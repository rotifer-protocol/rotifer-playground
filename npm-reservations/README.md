# npm name reservations

Packages published here exist to hold an npm name that would otherwise be free
for anyone to take. **They are not part of the product.** Deleting one would
release its name back to the registry.

## Why this exists

Rotifer ships its packages under the `@rotifer/*` scope, which the `rotifer`
npm **organisation** owns. Owning that organisation does **not** reserve the
matching unscoped names — `rotifer`, `rotifer-cli` and so on are a separate
namespace, and every one of them was unregistered.

That mattered because shipped code referenced one of them. Until v0.9.2 the
VS Code extension ran `npx rotifer <args>` in the user's terminal, and the MCP
server fell back to `npx rotifer` when no CLI was on `PATH`. On a machine with
the CLI installed those resolve to the local binary and never touch the
registry — which is why the gap survived so long: no developer could reproduce
it. On a machine *without* the CLI they go to npm, and whoever holds the name
gets their code executed in the user's own workspace.

Both call sites now pin `@rotifer/playground`. The reservation covers the users
still running the older builds, who cannot be force-updated.

## What a reservation package must be

npm's policy forbids holding names you do not intend to use, so a reservation
here is a **working pointer**, never an empty shell:

- its binary prints where the real package is — translating the arguments it
  was given into the correct command — and exits non-zero;
- it never pretends to be the tool it is standing in for;
- it is published from this repository with provenance, so anyone can verify
  the package came from `rotifer-protocol`.

## Adding one

Only reserve a name that is **actually referenced or genuinely likely to be
typed**. Reserving speculatively is the squatting npm's policy is aimed at, and
each package is a permanent maintenance surface.

1. Copy `rotifer/` to `npm-reservations/<name>/`, adjust `name` and the pointer
   text.
2. Run `.github/workflows/publish-npm-reservation.yml` manually with that name.

## Current reservations

| Name | Reserved because |
|---|---|
| [`rotifer`](./rotifer) | Referenced by `npx rotifer` in the VS Code extension ≤ 0.9.1 and the MCP server ≤ 0.10.0 |

Still unregistered, deliberately not reserved: `rotifer-cli`,
`rotifer-playground`, `rotifer-protocol`, `rotifer-gene`, `rotifer-mcp`,
`rotifer-mcp-server`. Reserve one only if it becomes referenced or if
impersonation is observed.
