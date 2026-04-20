#!/usr/bin/env node
// Generate minimal WASM fixtures for polyglot BYO-WASM e2e tests.
//
// These hand-rolled byte arrays produce two valid WASM modules that match
// the two ABI contracts accepted by `rotifer compile --wasm`:
//
//   1. Rust / AssemblyScript style:  exports `express(i32, i32) -> i32` + `memory`
//   2. WASI style:                   exports `_start` (no args / no return) + `memory`
//
// Run once locally to regenerate the .wasm files (checked into the repo):
//   node tests/fixtures/polyglot/build-fixtures.mjs
//
// See: https://rotifer.dev/docs/guides/polyglot-genes/ for the full ABI contract.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── helpers ──────────────────────────────────────────────────────────────
const u8 = (...bytes) => Uint8Array.from(bytes);
const concat = (...chunks) => {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

// LEB128 unsigned (used for sizes and counts)
const leb = (n) => {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    bytes.push(b);
  } while (n !== 0);
  return u8(...bytes);
};

const section = (id, ...bodyChunks) => {
  const body = concat(...bodyChunks);
  return concat(u8(id), leb(body.length), body);
};

const name = (s) => {
  const bytes = new TextEncoder().encode(s);
  return concat(leb(bytes.length), bytes);
};

const MAGIC = u8(0x00, 0x61, 0x73, 0x6d);
const VERSION = u8(0x01, 0x00, 0x00, 0x00);

// ── Module 1: Rust / AssemblyScript style ───────────────────────────────
// type:    (i32, i32) -> i32          (matches `express(input_ptr, input_len) -> output_packed`)
// func 0:  body returns i32.const 0
// memory:  min 1 page
// exports: "express" → func 0, "memory" → memory 0
const rustStyle = concat(
  MAGIC,
  VERSION,
  // Type section (id=1): 1 type, (i32, i32) -> i32
  section(0x01, leb(1), u8(0x60), leb(2), u8(0x7f, 0x7f), leb(1), u8(0x7f)),
  // Function section (id=3): 1 function using type 0
  section(0x03, leb(1), leb(0)),
  // Memory section (id=5): 1 memory, min=1, no max
  section(0x05, leb(1), u8(0x00), leb(1)),
  // Export section (id=7): 2 exports
  section(
    0x07,
    leb(2),
    name("express"), u8(0x00), leb(0),  // function 0
    name("memory"),  u8(0x02), leb(0),  // memory 0
  ),
  // Code section (id=10): 1 body — `i32.const 0; end`
  section(0x0a, leb(1), leb(4), leb(0), u8(0x41, 0x00, 0x0b)),
);

// ── Module 2: WASI style ────────────────────────────────────────────────
// type:    () -> ()
// func 0:  empty body
// memory:  min 1 page
// exports: "_start" → func 0, "memory" → memory 0
const wasiStyle = concat(
  MAGIC,
  VERSION,
  section(0x01, leb(1), u8(0x60), leb(0), leb(0)),
  section(0x03, leb(1), leb(0)),
  section(0x05, leb(1), u8(0x00), leb(1)),
  section(
    0x07,
    leb(2),
    name("_start"), u8(0x00), leb(0),
    name("memory"), u8(0x02), leb(0),
  ),
  section(0x0a, leb(1), leb(2), leb(0), u8(0x0b)),
);

// ── Validate both modules with the host's WASM runtime ──────────────────
async function validate(label, bytes) {
  try {
    await WebAssembly.compile(bytes);
    console.log(`✓ ${label}: ${bytes.length} bytes — valid WASM`);
  } catch (err) {
    console.error(`✗ ${label}: invalid — ${err.message}`);
    process.exit(1);
  }
}

await validate("rust-style/gene.wasm", rustStyle);
await validate("as-style/gene.wasm", wasiStyle);

// ── Write fixtures ──────────────────────────────────────────────────────
writeFileSync(join(__dirname, "rust-style", "gene.wasm"), rustStyle);
writeFileSync(join(__dirname, "as-style", "gene.wasm"), wasiStyle);

console.log("\nFixtures written:");
console.log("  tests/fixtures/polyglot/rust-style/gene.wasm");
console.log("  tests/fixtures/polyglot/as-style/gene.wasm");
