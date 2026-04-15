import { join } from "node:path";
import { existsSync } from "node:fs";
import { ensurePrivateDir } from "./private-fs.js";

export interface CompileResultView {
  irHash: string;
  totalSize: number;
  codeSectionSize: number;
  wasmAvailable: boolean;
}

export interface ExecutionResultView {
  success: boolean;
  output: unknown;
  errorMessage: string | null;
  fuelConsumed: number;
  memoryPeakKb: number;
  durationMs: number;
  sandboxType: string;
}

export interface L0CheckResultView {
  passed: boolean;
  violations: string[];
  checksPerformed: number;
}

export interface AlgebraResultView {
  success: boolean;
  output: unknown;
  errorMessage: string | null;
  stepsExecuted: number;
  totalFuelConsumed: number;
  totalDurationMs: number;
}

export interface NativeBinding {
  compileGeneToFile(
    wasmBytes: Buffer,
    phenotypeJson: string,
    outputPath: string
  ): CompileResultView;
  verifyIrModule(wasmBytes: Buffer): string;
  buildEchoGeneWasm(): Buffer;
  buildSearchGeneWasm(): Buffer;
  buildSummarizeGeneWasm(): Buffer;
  buildTranslateGeneWasm(): Buffer;
  executeGene(
    wasmBytes: Buffer,
    inputJson: string,
    phenotypeJson: string,
    constraintsJson?: string
  ): ExecutionResultView;
  l0Check(
    phenotypeJson: string,
    permissionsJson?: string,
    constraintsJson?: string
  ): L0CheckResultView;
  executeAlgebra(
    algebraJson: string,
    geneEntriesJson: string,
    inputJson: string
  ): AlgebraResultView;
}

let _binding: NativeBinding | null = null;
let _hasLoadAttempted = false;

const PLATFORM_PACKAGE_MAP: Record<string, string> = {
  "darwin-arm64": "@rotifer/playground-darwin-arm64",
  "darwin-x64": "@rotifer/playground-darwin-x64",
  "linux-x64": "@rotifer/playground-linux-x64-gnu",
  "win32-x64": "@rotifer/playground-win32-x64-msvc",
};

function initBinding(mod: Record<string, unknown>): NativeBinding | null {
  if (!mod.PlaygroundBinding) return null;
  const tmpDir = join(
    process.env.HOME || process.env.USERPROFILE || "/tmp",
    ".rotifer",
    "napi-binding"
  );
  ensurePrivateDir(tmpDir);
  return new (mod.PlaygroundBinding as new (dir: string) => NativeBinding)(tmpDir);
}

/**
 * Try to load the napi native addon.
 * Strategy: platform npm package first, then local .node file fallback.
 * Returns null if the addon is not available (fallback to pure-TS path).
 */
export function tryLoadBinding(): NativeBinding | null {
  if (_hasLoadAttempted) return _binding;
  _hasLoadAttempted = true;

  const platformKey = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PACKAGE_MAP[platformKey];
  if (pkgName) {
    try {
      const mod = require(pkgName);
      _binding = initBinding(mod);
      if (_binding) return _binding;
    } catch {
      // platform package not installed — fall through to local search
    }
  }

  const localCandidates = [
    join(__dirname, "..", "..", `index.${platformKey}.node`),
    join(__dirname, "..", "..", `index.${process.platform}-${process.arch}.node`),
    join(__dirname, "..", "..", `rotifer-napi.${process.platform}-${process.arch}.node`),
  ];

  for (const candidate of localCandidates) {
    if (existsSync(candidate)) {
      try {
        const mod = require(candidate);
        _binding = initBinding(mod);
        if (_binding) return _binding;
      } catch {
        // addon exists but failed to load — continue
      }
    }
  }

  return null;
}

export function isNativeAvailable(): boolean {
  return tryLoadBinding() !== null;
}
