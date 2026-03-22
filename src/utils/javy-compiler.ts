import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import * as display from "./display.js";

const WASI_SHIM_HEADER = `\
function __readStdin(){var s=1024,c=[],t=0;while(1){var b=new Uint8Array(s);var r=Javy.IO.readSync(0,b);t+=r;if(r===0)break;c.push(b.subarray(0,r))}var o=new Uint8Array(t);var p=0;for(var i=0;i<c.length;i++){o.set(c[i],p);p+=c[i].length}return JSON.parse(new TextDecoder().decode(o))}
function __writeStdout(v){var b=new TextEncoder().encode(JSON.stringify(v));Javy.IO.writeSync(1,b)}
`;

const WASI_SHIM_FOOTER = `\
var __input=__readStdin();
var __result=__gene.express(__input);
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
  const tmpDir = join(dirname(outputWasmPath), ".rotifer-build");
  mkdirSync(tmpDir, { recursive: true });

  const bundlePath = join(tmpDir, "bundle.js");
  const shimPath = join(tmpDir, "gene-shim.js");

  try {
    display.info("  Step 1/3: TypeScript → JavaScript (esbuild)");
    execSync(
      `npx esbuild ${JSON.stringify(geneSrcPath)} --bundle --format=iife --global-name=__gene --outfile=${JSON.stringify(bundlePath)} --log-level=warning`,
      { stdio: "pipe", timeout: 30_000 },
    );

    const bundleCode = readFileSync(bundlePath, "utf-8");
    const bundleSize = Buffer.byteLength(bundleCode);
    display.info(`    Bundle: ${(bundleSize / 1024).toFixed(1)} KB`);

    display.info("  Step 2/3: Generating WASI shim");
    const shimCode = WASI_SHIM_HEADER + bundleCode + "\n" + WASI_SHIM_FOOTER;
    writeFileSync(shimPath, shimCode);

    display.info("  Step 3/3: JavaScript → WASM (Javy / QuickJS)");
    execSync(
      `npx javy-cli compile ${JSON.stringify(shimPath)} -o ${JSON.stringify(outputWasmPath)}`,
      { stdio: "pipe", timeout: 60_000 },
    );

    const wasmSize = readFileSync(outputWasmPath).length;
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
 * Check whether the Javy CLI is available.
 */
export function isJavyAvailable(): boolean {
  try {
    execSync("npx javy-cli --version", { stdio: "pipe", timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
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
