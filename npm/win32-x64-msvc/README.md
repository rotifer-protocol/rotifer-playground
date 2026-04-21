# @rotifer/playground-win32-x64-msvc

Native binding for [`@rotifer/playground`](https://www.npmjs.com/package/@rotifer/playground) — Windows x64 (MSVC).

This package is automatically installed as an optional dependency when you install `@rotifer/playground` on Windows x64. You do not need to install it directly.

## Platform

| Field | Value |
|-------|-------|
| OS    | Windows |
| CPU   | x64 |
| Runtime | MSVC |
| Node  | ≥ 20.0.0 |

## Usage

```bash
npm install -g @rotifer/playground
rotifer --version
```

The main package loads this native binding automatically at runtime, enabling the WASM sandboxed execution path via `wasmtime`. If the binding is unavailable, the CLI falls back to the Node.js execution path.

## Links

- [Main package](https://www.npmjs.com/package/@rotifer/playground)
- [GitHub](https://github.com/rotifer-protocol/rotifer-playground)
- [Documentation](https://rotifer.dev)
- [CHANGELOG](https://github.com/rotifer-protocol/rotifer-playground/blob/main/CHANGELOG.md)

## License

Apache-2.0
