import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import * as display from "./display.js";

/** Gene source declares an async/Promise-returning express() — incompatible with Javy/QuickJS (#57). */
export class AsyncExpressError extends Error {
  override name = "AsyncExpressError";
}

/** TS→WASM toolchain (esbuild / javy) unavailable; message carries the full diagnosis (#58). */
export class ToolchainError extends Error {
  override name = "ToolchainError";
}

// High-confidence shapes only — the runtime guard in WASI_SHIM_FOOTER backstops
// anything the static patterns miss (e.g. a sync express() returning a Promise value).
const ASYNC_EXPRESS_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\basync\s+function\s+express\b/, "async function express"],
  [/\bexpress\s*=\s*async\b/, "express = async (…)"],
  [/\bfunction\s+express\s*\([^)]*\)\s*:\s*Promise\s*</, "express() declared to return Promise<…>"],
];

/**
 * Detect an async/Promise-returning express() in gene source.
 * Returns a human-readable description of the offending shape, or null if clean.
 */
export function detectAsyncExpress(source: string): string | null {
  for (const [pattern, label] of ASYNC_EXPRESS_PATTERNS) {
    if (pattern.test(source)) return label;
  }
  return null;
}

type Command = string[];

// Bare binaries first: a PATH lookup is instant (covers global installs and
// node_modules/.bin when invoked via npm scripts). `npx --no-install` is the
// fallback for project-local installs — it never touches the npm registry, so a
// missing tool fails fast instead of hanging on a blocked proxy (#58:
// `spawnSync npx ETIMEDOUT`). javy-cli@3 installs its binary as `javy`.
const ESBUILD_CANDIDATES: Command[] = [["esbuild"], ["npx", "--no-install", "esbuild"]];
const JAVY_CANDIDATES: Command[] = [
  ["javy"],
  ["npx", "--no-install", "javy-cli"],
  ["npx", "--no-install", "javy"],
];

function canRun(command: Command): boolean {
  try {
    execFileSync(command[0], [...command.slice(1), "--version"], { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function resolveCommand(candidates: Command[]): Command | null {
  for (const candidate of candidates) {
    if (canRun(candidate)) return candidate;
  }
  return null;
}

export interface ToolchainStatus {
  esbuild: Command | null;
  javy: Command | null;
}

/** Resolve the TS→WASM toolchain without ever hitting the network. */
export function preflightToolchain(): ToolchainStatus {
  return {
    esbuild: resolveCommand(ESBUILD_CANDIDATES),
    javy: resolveCommand(JAVY_CANDIDATES),
  };
}

/** Full diagnosis for a failed preflight: per-tool status, environment, exact fixes. */
/** Resolve the active `npx` path (impure: PATH lookup). Returns "not found" if absent. */
export function resolveActiveNpxPath(): string {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", ["npx"], {
      stdio: "pipe", timeout: 5_000,
    }).toString().trim().split("\n")[0];
  } catch {
    return "not found";
  }
}

/** True when both tools resolved. */
export function toolchainOk(status: ToolchainStatus): boolean {
  return status.esbuild !== null && status.javy !== null;
}

/** Per-tool status + environment, as report lines. Pure (no I/O — pass npxPath in). */
export function formatToolchainReport(status: ToolchainStatus, npxPath: string): string[] {
  return [
    `  esbuild: ${status.esbuild ? "ok (" + status.esbuild.join(" ") + ")" : "missing (tried: esbuild on PATH, npx --no-install esbuild)"}`,
    `  javy:    ${status.javy ? "ok (" + status.javy.join(" ") + ")" : "missing (tried: javy on PATH, npx --no-install javy-cli / javy)"}`,
    `  active npx: ${npxPath}`,
    `  node: ${process.execPath}`,
  ];
}

export function buildToolchainErrorMessage(status: ToolchainStatus): string {
  return [
    "TypeScript → WASM toolchain unavailable:",
    ...formatToolchainReport(status, resolveActiveNpxPath()),
    "",
    "Install: npm i -g esbuild javy-cli   (javy-cli installs a binary named `javy` — both are detected)",
    "If already installed: make sure the Node prefix that owns `rotifer` is first in PATH;",
    "an `npx` from another Node installation may try the npm registry and time out behind a proxy.",
  ].join("\n");
}

/** True when the gene source has been edited after the WASM was last compiled (#58). */
export function isWasmStale(wasmPath: string, sourcePath: string): boolean {
  if (!existsSync(wasmPath) || !existsSync(sourcePath)) return false;
  try {
    return statSync(sourcePath).mtimeMs > statSync(wasmPath).mtimeMs;
  } catch {
    return false;
  }
}

/** Outcome of normalizeJavyClockSeed(); the module is unchanged unless "normalized". */
export interface ClockSeedResult {
  wasm: Buffer;
  status: "normalized" | "absent" | "ambiguous";
}

const WASM_SECTION_DATA = 11;

function readLeb128(buf: Buffer, offset: number): [value: number, next: number] {
  let value = 0;
  let shift = 0;
  let at = offset;
  for (;;) {
    const byte = buf[at++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) return [value, at];
  }
}

/** Byte range of the Data section's contents, or null if the module has none. */
function dataSectionRange(wasm: Buffer): [start: number, end: number] | null {
  let at = 8; // magic + version
  while (at < wasm.length) {
    const id = wasm[at];
    const [size, bodyStart] = readLeb128(wasm, at + 1);
    if (id === WASM_SECTION_DATA) return [bodyStart, bodyStart + size];
    at = bodyStart + size;
  }
  return null;
}

/**
 * Replace the compile-time clock javy bakes into a module with a fixed seed.
 *
 * javy 3.0.1 pre-initialises QuickJS and snapshots its heap; QuickJS seeds
 * Math.random from gettimeofday() while doing so, and that 8-byte microsecond
 * value lands in the Data section. It was the only difference between two
 * compiles of the same source, and the v2 gene ID digests every standard
 * section (ADR-340 D1), so every compile announced a new identity.
 *
 * The field is found by value, not by offset: the one little-endian u64 in the
 * Data section that falls inside `windowUs`, the span javy was running. Exactly
 * one match is required. None means this javy build does not do it (or does it
 * differently); two means the guess is not safe. Either way the module is
 * returned untouched and the caller says so — a wrong overwrite would corrupt
 * the heap, an unnormalized module only loses reproducibility.
 *
 * Math.random was already fixed per artifact (the snapshot holds its state);
 * this makes it fixed per source as well.
 */
export function normalizeJavyClockSeed(
  wasm: Buffer,
  windowUs: [from: number, to: number],
  seed: Buffer,
): ClockSeedResult {
  const range = dataSectionRange(wasm);
  if (!range) return { wasm, status: "absent" };
  const [from, to] = [BigInt(Math.floor(windowUs[0])), BigInt(Math.ceil(windowUs[1]))];
  const hits: number[] = [];
  for (let at = range[0]; at + 8 <= range[1]; at++) {
    const value = wasm.readBigUInt64LE(at);
    if (value >= from && value <= to) hits.push(at);
  }
  if (hits.length === 0) return { wasm, status: "absent" };
  if (hits.length > 1) return { wasm, status: "ambiguous" };
  const out = Buffer.from(wasm);
  seed.copy(out, hits[0], 0, 8);
  return { wasm: out, status: "normalized" };
}

/** A non-zero 8-byte seed derived from the compiled source (xorshift state must not be 0). */
function seedFromSource(source: string): Buffer {
  const seed = createHash("sha256").update(source).digest().subarray(0, 8);
  if (seed.every((b) => b === 0)) seed[0] = 1;
  return seed;
}

const WASI_SHIM_HEADER = `\
function __readStdin(){var s=1024,c=[],t=0;while(1){var b=new Uint8Array(s);var r=Javy.IO.readSync(0,b);t+=r;if(r===0)break;c.push(b.subarray(0,r))}var o=new Uint8Array(t);var p=0;for(var i=0;i<c.length;i++){o.set(c[i],p);p+=c[i].length}return JSON.parse(new TextDecoder().decode(o))}
function __writeStdout(v){var b=new TextEncoder().encode(JSON.stringify(v));Javy.IO.writeSync(1,b)}
`;

const WASI_SHIM_FOOTER = `\
var __input=__readStdin();
var __result=__gene.express(__input);
if(__result&&typeof __result.then==="function"){throw new Error("Async express() is not supported in Javy/WASM runtime; use a synchronous gene or run without sandbox")}
__writeStdout(__result);
`;

export interface JavyCompileResult {
  wasmPath: string;
  bundleSize: number;
  wasmSize: number;
  durationMs: number;
}

/**
 * Compile a TypeScript gene to WASM via esbuild (strip types) + Javy (JS→WASM).
 *
 * Pipeline: index.ts → esbuild (IIFE bundle) → WASI shim wrapper → Javy → gene.wasm
 */
export function compileTypeScriptToWasm(
  geneSrcPath: string,
  outputWasmPath: string,
): JavyCompileResult {
  const startTime = Date.now();

  // #57: fail at compile time with an actionable message — the runtime guard's
  // error is thrown inside QuickJS and surfaces as an opaque WASM backtrace.
  const asyncShape = detectAsyncExpress(readFileSync(geneSrcPath, "utf-8"));
  if (asyncShape) {
    throw new AsyncExpressError(
      `Native (Javy/QuickJS) WASM Genes must export a synchronous express(input) — ` +
      `found ${asyncShape} in ${geneSrcPath}. Make express() synchronous, or keep it ` +
      `async and run via Node (--no-sandbox) / a Hybrid Gene for async I/O.`,
    );
  }

  // #58: preflight the toolchain offline; a missing tool gets a diagnosis instead
  // of `spawnSync npx ETIMEDOUT` from npx hitting the registry through a proxy.
  const toolchain = preflightToolchain();
  if (!toolchain.esbuild || !toolchain.javy) {
    throw new ToolchainError(buildToolchainErrorMessage(toolchain));
  }

  const tmpDir = join(dirname(outputWasmPath), ".rotifer-build");
  mkdirSync(tmpDir, { recursive: true });

  const bundlePath = join(tmpDir, "bundle.js");
  const shimPath = join(tmpDir, "gene-shim.js");

  try {
    display.info("  Step 1/3: TypeScript → JavaScript (esbuild)");
    execFileSync(toolchain.esbuild[0], [
      ...toolchain.esbuild.slice(1), geneSrcPath,
      "--bundle", "--format=iife", "--global-name=__gene",
      `--outfile=${bundlePath}`, "--log-level=warning",
    ], { stdio: "pipe", timeout: 30_000 });

    const bundleCode = readFileSync(bundlePath, "utf-8");
    const bundleSize = Buffer.byteLength(bundleCode);
    display.info(`    Bundle: ${(bundleSize / 1024).toFixed(1)} KB`);

    display.info("  Step 2/3: Generating WASI shim");
    const shimCode = WASI_SHIM_HEADER + bundleCode + "\n" + WASI_SHIM_FOOTER;
    writeFileSync(shimPath, shimCode);

    display.info("  Step 3/3: JavaScript → WASM (Javy / QuickJS)");
    const javyStartedMs = Date.now();
    execFileSync(toolchain.javy[0], [
      ...toolchain.javy.slice(1), "compile", shimPath, "-o", outputWasmPath,
    ], { stdio: "pipe", timeout: 60_000 });
    const javyEndedMs = Date.now();

    // Same source, same bytes: take javy's compile-time clock out (T-95).
    const seeded = normalizeJavyClockSeed(
      readFileSync(outputWasmPath),
      [(javyStartedMs - 1_000) * 1_000, (javyEndedMs + 1_000) * 1_000],
      seedFromSource(shimCode),
    );
    if (seeded.status === "normalized") {
      writeFileSync(outputWasmPath, seeded.wasm);
    } else {
      display.warn(
        `    This javy build's output is not reproducible (${seeded.status === "ambiguous" ? "more than one" : "no"} ` +
        "compile-time clock value found): compiling this gene again will give different bytes and a different v2 gene ID.",
      );
    }

    const wasmSize = seeded.wasm.length;
    const durationMs = Date.now() - startTime;

    display.success(
      `  WASM compiled: ${(wasmSize / 1024).toFixed(0)} KB (${durationMs}ms)`,
    );

    return { wasmPath: outputWasmPath, bundleSize, wasmSize, durationMs };
  } finally {
    try { unlinkSync(bundlePath); } catch { /* ignore */ }
    try { unlinkSync(shimPath); } catch { /* ignore */ }
    try { require("node:fs").rmdirSync(tmpDir); } catch { /* ignore */ }
  }
}

/**
 * Check whether the Javy CLI is available (offline check; never hits the registry).
 */
export function isJavyAvailable(): boolean {
  return resolveCommand(JAVY_CANDIDATES) !== null;
}

/**
 * Detect the gene source file in a gene directory.
 * Returns the path to `index.ts` or `index.js` if found.
 */
export function findGeneSource(geneDir: string): string | null {
  for (const name of ["index.ts", "index.js"]) {
    const p = join(geneDir, name);
    if (existsSync(p)) return p;
  }
  return null;
}
