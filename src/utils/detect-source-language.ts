import { existsSync } from "node:fs";
import { join } from "node:path";

export type SourceLanguage =
  | "typescript"
  | "rust"
  | "assemblyscript"
  | "go"
  | "c"
  | "external"
  | "unknown";

const VALID_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "rust",
  "assemblyscript",
  "go",
  "c",
  "external",
  "unknown",
]);

export function isValidSourceLanguage(value: string): value is SourceLanguage {
  return VALID_LANGUAGES.has(value);
}

/**
 * Detect the source language of a gene by inspecting its directory.
 *
 * Detection rules (in priority order):
 *   1. `index.ts` or `index.js`           → "typescript"
 *   2. `Cargo.toml`                       → "rust"
 *   3. `assembly/index.ts` or
 *      `asconfig.json` (without index.ts) → "assemblyscript"
 *   4. `go.mod`                           → "go"
 *   5. Any `.c`/`.cpp`/`.cc`/`.h` at root → "c"
 *   6. `gene.wasm` exists but no source   → "external"
 *   7. Nothing matches                    → "unknown"
 *
 * The detection is best-effort and intentionally conservative — when ambiguous,
 * callers should let the user override with the `--lang` flag.
 */
export function detectSourceLanguage(geneDir: string): SourceLanguage {
  if (
    existsSync(join(geneDir, "index.ts")) ||
    existsSync(join(geneDir, "index.js"))
  ) {
    return "typescript";
  }
  if (existsSync(join(geneDir, "Cargo.toml"))) {
    return "rust";
  }
  if (
    existsSync(join(geneDir, "assembly", "index.ts")) ||
    existsSync(join(geneDir, "asconfig.json"))
  ) {
    return "assemblyscript";
  }
  if (existsSync(join(geneDir, "go.mod"))) {
    return "go";
  }
  if (hasCSourceAtRoot(geneDir)) {
    return "c";
  }
  if (
    existsSync(join(geneDir, "gene.wasm")) ||
    existsSync(join(geneDir, "gene.ir.wasm"))
  ) {
    return "external";
  }
  return "unknown";
}

function hasCSourceAtRoot(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const lower = entry.name.toLowerCase();
      if (
        lower.endsWith(".c") ||
        lower.endsWith(".cpp") ||
        lower.endsWith(".cc") ||
        lower.endsWith(".h") ||
        lower.endsWith(".hpp")
      ) {
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}
