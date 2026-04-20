// Minimal Rust gene that targets the Rotifer IR `express(i32, i32) -> i32` ABI.
//
// Build:
//   rustup target add wasm32-unknown-unknown
//   cargo build --release --target wasm32-unknown-unknown
//   wasm-strip target/wasm32-unknown-unknown/release/rotifer_gene_rust_example.wasm
//
// Then point the Rotifer CLI at the produced .wasm:
//   rotifer compile my-rust-gene --wasm path/to/rotifer_gene_rust_example.wasm
//
// The packed return value layout (high 32 bits = ptr, low 32 bits = len) and the
// memory allocation strategy are abi details — replace with your real gene logic.

#[no_mangle]
pub extern "C" fn express(_input_ptr: i32, _input_len: i32) -> i32 {
    // Real genes would:
    //   1. Read JSON input from linear memory at [input_ptr .. input_ptr + input_len].
    //   2. Compute the result.
    //   3. Allocate output buffer in linear memory and return its (ptr, len).
    //
    // This example just returns 0 (no output) so the host treats the call as a
    // smoke-test — replace with real logic before submitting to Arena.
    0
}
