// Minimal AssemblyScript gene targeting the Rotifer IR `express(i32, i32) -> i32` ABI.
//
// Build:
//   npm install --save-dev assemblyscript
//   npx asc index.ts --outFile gene.wasm --optimize --runtime stub
//
// Then:
//   rotifer compile my-as-gene --wasm path/to/gene.wasm
//
// AssemblyScript already exposes linear `memory` by default and respects the
// (i32, i32) -> i32 calling convention, so the entry point is a one-liner.
// Replace the body with real logic that reads input JSON from memory and
// writes output JSON back — see `tests/fixtures/polyglot/README.md` for the
// full ABI contract.

export function express(inputPtr: i32, inputLen: i32): i32 {
  // Real genes would:
  //   1. Read JSON input from memory at [inputPtr .. inputPtr + inputLen].
  //   2. Compute the result.
  //   3. Allocate output buffer and return packed (ptr, len).
  return 0;
}
