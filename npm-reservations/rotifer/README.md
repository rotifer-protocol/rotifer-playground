# rotifer

**This is not the Rotifer Protocol CLI.** The CLI is published as
**[`@rotifer/playground`](https://www.npmjs.com/package/@rotifer/playground)**.

```sh
npm install -g @rotifer/playground
# or
npx -y @rotifer/playground --help
```

## Why this package exists

The unscoped name `rotifer` was previously unregistered, while some Rotifer
tooling invoked the CLI as `npx rotifer`. Anyone publishing under this name
could have had their code fetched and executed on those users' machines.

The [Rotifer Protocol](https://rotifer.dev) project reserves the name so it
cannot be used to impersonate the toolchain. Running its binary prints a
pointer to the real package and exits non-zero — it never pretends to be the
CLI.

If you reached this package by running `npx rotifer`, you are on an old version
of a Rotifer tool. Update it, or call `@rotifer/playground` directly.

- Docs: <https://rotifer.dev>
- Source: <https://github.com/rotifer-protocol/rotifer-playground>

## License

Apache-2.0
