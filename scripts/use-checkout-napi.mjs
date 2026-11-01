#!/usr/bin/env node
// Make the CLI load the napi addon built from this checkout.
//
//   cd crates/rotifer-napi && napi build --release --platform
//   npm run build
//   node scripts/use-checkout-napi.mjs [--root <dir>]
//
// The loader (src/utils/binding.ts) tries the `@rotifer/playground-<platform>`
// package first and falls back to `index.<platform>-<arch>.node` at the
// package root. So this removes that package, copies the build to the
// fallback path, and asks the built CLI's loader for the addon: it must load,
// and carry the v2 gene ID and AgentMemory functions. Anything else exits 1.
//
// CI's Test jobs run it so they test the Rust in the same commit — on main the
// platform package is the previous release, and on a release PR npm ci
// installs none (tests/unit/ci-test-jobs-checkout-napi.test.ts).

import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const PLATFORM_PACKAGES = {
  "darwin-arm64": "@rotifer/playground-darwin-arm64",
  "darwin-x64": "@rotifer/playground-darwin-x64",
  "linux-x64": "@rotifer/playground-linux-x64-gnu",
  "win32-x64": "@rotifer/playground-win32-x64-msvc",
};
const MEMORY_FUNCTIONS = [
  "memoryRead",
  "memoryWrite",
  "memoryQuery",
  "memoryDelete",
  "memoryGet",
  "memoryCreate",
  "memorySetDataPolicyRetention",
];

function fail(message) {
  console.error(`use-checkout-napi: ${message}`);
  process.exit(1);
}

const rootFlag = process.argv.indexOf("--root");
const root = resolve(rootFlag >= 0 ? process.argv[rootFlag + 1] ?? "" : process.cwd());
const platformKey = `${process.platform}-${process.arch}`;
const pkg = PLATFORM_PACKAGES[platformKey];
if (!pkg) fail(`no rotifer platform package for ${platformKey}`);

const crate = join(root, "crates", "rotifer-napi");
const built = existsSync(crate) ? readdirSync(crate).filter((f) => /^index\..+\.node$/.test(f)) : [];
if (built.length === 0) fail("no crates/rotifer-napi/index.*.node — run `napi build --release --platform` there first");
if (built.length > 1) fail(`more than one build in crates/rotifer-napi (${built.join(", ")}) — remove the stale ones`);

rmSync(join(root, "node_modules", ...pkg.split("/")), { recursive: true, force: true });
const target = `index.${platformKey}.node`;
copyFileSync(join(crate, built[0]), join(root, target));

const loaderPath = join(root, "dist", "utils", "binding.js");
if (!existsSync(loaderPath)) fail("no dist/utils/binding.js — run `npm run build` first");
const loader = createRequire(loaderPath);
try {
  loader.resolve(pkg);
  fail(`${pkg} still resolves from dist/utils, so the loader would take it first`);
} catch (err) {
  if (err?.code !== "MODULE_NOT_FOUND") throw err;
}

const { tryLoadBinding, hasNativeGeneIdV2 } = loader(loaderPath);
const binding = tryLoadBinding();
if (!binding) fail(`the CLI's loader does not load ${target} (built from ${built[0]})`);
if (!hasNativeGeneIdV2()) fail(`${built[0]} has no geneIdV2`);
const missing = MEMORY_FUNCTIONS.filter((name) => typeof binding[name] !== "function");
if (missing.length > 0) fail(`${built[0]} lacks memory functions: ${missing.join(", ")}`);

console.log(`use-checkout-napi: the CLI loads ${target} (from crates/rotifer-napi/${built[0]}); geneIdV2 and memory functions present`);
