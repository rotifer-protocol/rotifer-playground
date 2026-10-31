/**
 * `@rotifer/playground/memory` is importable (package.json "exports"): by
 * require, by import(), and by TypeScript for its types — the way a gene
 * author reaches GeneMemoryAccess, MemoryError and MemoryEntry. The JSON test
 * double and the CLI's host side (src/memory/host.ts, whose signatures carry
 * the native binding's Node-typed API) are not part of it.
 *
 * Resolved through the package's own name from inside the repository
 * (Node and TypeScript both resolve a package's self-reference through
 * "exports"), so it checks the same map an installed copy uses.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(__dirname, "..", "..");
const BUILT = existsSync(join(ROOT, "dist", "memory", "index.js"));
const node = (args: string[]) => execFileSync(process.execPath, args, { cwd: ROOT, encoding: "utf-8" }).trim();

describe("@rotifer/playground/memory", () => {
  it("dist is built (the e2e suites below need it; CI builds before testing)", () => {
    expect(BUILT).toBe(true);
  });

  it("resolves by require()", () => {
    const out = node(["-e", "const m = require('@rotifer/playground/memory'); console.log(JSON.stringify(Object.keys(m).sort()))"]);
    const names: string[] = JSON.parse(out);
    for (const name of ["MemoryError", "MEMORY_CATEGORIES", "noAgentMemory", "createGeneMemoryAccess", "NapiMemoryBackend"]) {
      expect(names, name).toContain(name);
    }
    for (const name of ["JsonFileMemoryBackend", "openAgentMemory", "scratchGeneMemory", "projectNativeMemory"]) {
      expect(names, name).not.toContain(name);
    }
  });

  it("resolves by import()", () => {
    const out = node([
      "--input-type=module",
      "-e",
      "const m = await import('@rotifer/playground/memory'); const e = new m.MemoryError('MEMORY_NOT_FOUND', 'x'); console.log(e.code, typeof m.noAgentMemory)",
    ]);
    expect(out).toBe("MEMORY_NOT_FOUND function");
  });

  it("gives TypeScript its types", () => {
    const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
    const project = join(ROOT, "tests", "fixtures", "memory", "subpath", "tsconfig.json");
    const result = (() => {
      try {
        node([tsc, "-p", project]);
        return "";
      } catch (err) {
        return String((err as { stdout?: string }).stdout ?? err);
      }
    })();
    expect(result).toBe("");
  }, 60_000);
});
