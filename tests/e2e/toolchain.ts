/**
 * What the TS→WASM tests need, decided once at import so `it.skipIf` can read it.
 *
 * A test whose precondition is missing must show as skipped, not as a pass
 * that checked nothing: an early `return` reports "passed" (T-93/95
 * acceptance). The Regression Guard refuses `.skip(` but allows `skipIf`,
 * a skip tied to a runtime precondition, so the precondition has to be known
 * before the tests are collected.
 */
import { execSync } from "node:child_process";
import { preflightToolchain } from "../../src/utils/javy-compiler.js";
import { tryLoadBinding } from "../../src/utils/binding.js";

// javy-cli downloads its ~32 MB binary on first run, which can outlast the
// CLI's own 10 s probe. Let that happen here first; the probe below decides.
try {
  execSync("npx --no-install javy-cli --version", { stdio: "pipe", timeout: 45_000 });
} catch {
  // not installed or not downloadable: preflightToolchain() says so
}

const toolchain = preflightToolchain();

/** esbuild and javy both resolve exactly as `rotifer compile` resolves them. */
export const hasJavyToolchain = toolchain.esbuild !== null && toolchain.javy !== null;

/** The napi sandbox loads on this platform. */
export const hasSandbox = tryLoadBinding() !== null;
