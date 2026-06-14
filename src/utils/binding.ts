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
let _rawModule: Record<string, unknown> | null = null;
let _hasModuleLoadAttempted = false;

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
function loadRawModule(): Record<string, unknown> | null {
  if (_hasModuleLoadAttempted) return _rawModule;
  _hasModuleLoadAttempted = true;

  const platformKey = `${process.platform}-${process.arch}`;
  const pkgName = PLATFORM_PACKAGE_MAP[platformKey];
  if (pkgName) {
    try {
      _rawModule = require(pkgName) as Record<string, unknown>;
      return _rawModule;
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
        _rawModule = require(candidate) as Record<string, unknown>;
        return _rawModule;
      } catch {
        // addon exists but failed to load — continue
      }
    }
  }

  return null;
}

export function tryLoadBinding(): NativeBinding | null {
  if (_hasLoadAttempted) return _binding;
  _hasLoadAttempted = true;
  const mod = loadRawModule();
  if (mod) _binding = initBinding(mod);
  return _binding;
}

/**
 * Subset of the native `P2pNode` class surfaced to the CLI. Method names are
 * camelCase (napi converts the Rust snake_case automatically).
 */
export interface P2pNodeHandle {
  start(): void;
  peerId(): string;
  listenAddrs(): string[];
  discoveredPeers(): string[];
  announceGene(
    geneId: string,
    name: string,
    domain: string,
    version: string,
    fidelity: string
  ): void;
  stop(): void;
}

/**
 * Construct a native libp2p P2P node. Returns null when the native addon is
 * unavailable (e.g. a pure-TS environment without the compiled `.node`), so
 * callers can degrade gracefully.
 */
export function loadP2pNode(
  listenPort: number,
  bootstrapPeers: string[]
): P2pNodeHandle | null {
  const mod = loadRawModule();
  // napi renders the Rust `P2pNode` as `P2PNode` (it uppercases the "p2p"
  // acronym); accept either spelling so both the raw addon and any JS wrapper work.
  const Ctor = (mod?.P2PNode ?? mod?.P2pNode) as
    | (new (port: number, peers: string[]) => P2pNodeHandle)
    | undefined;
  if (typeof Ctor !== "function") return null;
  return new Ctor(listenPort, bootstrapPeers);
}

export function isNativeAvailable(): boolean {
  return tryLoadBinding() !== null;
}
