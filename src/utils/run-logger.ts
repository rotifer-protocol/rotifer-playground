import { appendFileSync, existsSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { ensurePrivateDir, tightenPrivateFile } from "./private-fs.js";
import { recordGeneInvocation } from "../cloud/invocation.js";

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB rotation
const LOG_DIR = join(homedir(), ".rotifer", "run-logs");

interface GeneExecutionMeta {
  geneName: string;
  /**
   * Directory of the Gene that ran. When given, the execution is also reported
   * to Rotifer Cloud as an invocation — only for Cloud-installed Genes, only
   * when signed in, never when ROTIFER_TELEMETRY is off (see cloud/invocation).
   * The local log line above is written regardless and stays local.
   */
  geneDir?: string;
  success: boolean;
  durationMs: number;
  inputSize: number;
  outputSize: number;
  error?: string;
  resourceCost?: number;
}

export function logGeneExecution(meta: GeneExecutionMeta): void {
  try {
    ensurePrivateDir(LOG_DIR);

    const logFile = join(LOG_DIR, `${meta.geneName}.jsonl`);

    if (existsSync(logFile)) {
      const stats = statSync(logFile);
      if (stats.size > MAX_LOG_SIZE) {
        const rotated = logFile + ".old";
        try { renameSync(logFile, rotated); } catch { /* best-effort */ }
      }
    }

    const entry = {
      geneId: meta.geneName,
      timestamp: new Date().toISOString(),
      success: meta.success,
      durationMs: Math.round(meta.durationMs),
      inputSize: meta.inputSize,
      outputSize: meta.outputSize,
      error: meta.error || undefined,
      resourceCost: meta.resourceCost || undefined,
    };

    appendFileSync(logFile, JSON.stringify(entry) + "\n", { mode: 0o600 });
    tightenPrivateFile(logFile);
  } catch {
    // Zero-disruption: never throw from logging
  }

  if (meta.geneDir) {
    try {
      recordGeneInvocation(meta.geneDir);
    } catch {
      // Same rule: reporting must never affect a run.
    }
  }
}

export function getLogDir(): string {
  return LOG_DIR;
}

export interface RunLogEntry {
  geneId: string;
  timestamp: string;
  success: boolean;
  durationMs: number;
  inputSize: number;
  outputSize: number;
  error?: string;
  resourceCost?: number;
}

export function readRunLogs(geneName: string): RunLogEntry[] {
  const logFile = join(LOG_DIR, `${geneName}.jsonl`);
  if (!existsSync(logFile)) return [];

  try {
    const { readFileSync } = require("node:fs");
    const content = readFileSync(logFile, "utf-8");
    return content
      .split("\n")
      .filter((line: string) => line.trim())
      .map((line: string) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean) as RunLogEntry[];
  } catch {
    return [];
  }
}
