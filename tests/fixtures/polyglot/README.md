# Polyglot Gene Fixtures

Minimal WASM fixtures used by `tests/e2e/polyglot-byo-wasm.test.ts` to verify the
**Bring-Your-Own-WASM** path of `rotifer compile --wasm <path>`.

> **Why this matters:** the Rotifer IR layer is *language-agnostic by spec
> design* — see [Rotifer IR Specification](https://github.com/rotifer-protocol/rotifer-spec/blob/main/rotifer-ir-specification.md)
> §1.2 *Positioning of Rotifer IR*. The CLI today only auto-compiles TypeScript
> via Javy, but any language that can emit a WASM module exporting one of two
> ABIs can already be turned into a Native gene through `rotifer compile --wasm`.
> These fixtures lock that contract into CI.

## ABI contracts

The IR compiler accepts a WASM module exporting either:

| Style | Required exports | Used by |
|-------|------------------|---------|
| Rotifer | `express(i32, i32) -> i32` + `memory` | Rust (`#[no_mangle] extern "C"`), AssemblyScript, Zig, hand-rolled WAT |
| WASI    | `_start` + `memory` | Anything that defaults to a WASI entry point |

Linear `memory` carries JSON input/output. A packed `i32` return (high 32 bits =
output pointer, low 32 bits = output length) is the simplest convention; real
genes should follow the host's allocator protocol.

## Files

```
polyglot/
├── README.md                             ← this file
├── build-fixtures.mjs                    ← regenerates the .wasm files
├── rust-style/
│   ├── gene.wasm                         ← 56 bytes, exports express + memory
│   └── source/
│       ├── Cargo.toml
│       └── src/lib.rs                    ← equivalent Rust source
└── as-style/
    ├── gene.wasm                         ← 50 bytes, exports _start + memory (WASI)
    └── source/
        ├── index.ts                      ← equivalent AssemblyScript source
        └── asconfig.json
```

The two `.wasm` files are hand-rolled byte arrays (see `build-fixtures.mjs`)
that cover both ABIs. They are intentionally minimal — `i32.const 0; end` for
Rust style and an empty body for WASI style — so CI does not depend on
`wasm-pack` or `asc` being installed. The `source/` directories show the
**real** Rust and AssemblyScript code you would write to produce equivalent
modules with `cargo build --target wasm32-unknown-unknown` and `npx asc`.

## Regenerate

If the ABI ever changes:

```bash
node tests/fixtures/polyglot/build-fixtures.mjs
```

The script also runs `WebAssembly.compile()` on each module to fail fast if the
hand-rolled bytes are malformed.

## Reference

- [Polyglot Genes guide](https://rotifer.dev/docs/guides/polyglot-genes/) — full Rust / AssemblyScript / Go / C recipes and ABI contract
- [Rotifer IR Specification](https://github.com/rotifer-protocol/rotifer-spec/blob/main/rotifer-ir-specification.md) §1.2 *Positioning of Rotifer IR*
