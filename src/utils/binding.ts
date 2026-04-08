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

/**
 * Try to load the napi native addon.
 * Returns null if the addon is not available (fallback to pure-TS path).
 */
export function tryLoadBinding(): NativeBinding | null {
  if (_hasLoadAttempted) return _binding;
  _hasLoadAttempted = true;

  const candidates = [
    join(__dirname, "..", "..", "index.darwin-arm64.node"),
    join(__dirname, "..", "..", "index.darwin-x64.node"),
    join(__dirname, "..", "..", "index.linux-x64-gnu.node"),
    join(__dirname, "..", "..", "index.win32-x64-msvc.node"),
    join(__dirname, "..", "..", `rotifer-napi.${process.platform}-${process.arch}.node`),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const mod = require(candidate);
        if (mod.PlaygroundBinding) {
          const tmpDir = join(
            process.env.HOME || process.env.USERPROFILE || "/tmp",
            ".rotifer",
            "napi-binding"
          );
          ensurePrivateDir(tmpDir);
          const instance = new mod.PlaygroundBinding(tmpDir);
          _binding = instance as NativeBinding;
          return _binding;
        }
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
