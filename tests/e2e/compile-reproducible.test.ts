/**
 * Compiling the same source twice gives the same bytes and the same v2 gene ID
 * (T-95), through the built CLI with the real esbuild + javy toolchain.
 *
 * javy 3.0.1 bakes the compile-time clock into the Data section, and the v2
 * gene ID digests every standard section (ADR-340 D1) — so before this, every
 * compile of an unchanged Native gene announced a new identity.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { hasJavyToolchain, hasSandbox } from "./toolchain.js";

const ROOT = join(__dirname, "..", "..");
const CLI = join(ROOT, "dist", "index.js");
const GENE = "genesis-code-format";

function run(args: string, cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 90_000,
      env: { ...process.env, FORCE_COLOR: "0", ROTIFER_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe.runIf(existsSync(CLI))("compile is reproducible", () => {
  let projectDir: string;
  let geneDir: string;

  beforeEach(() => {
    projectDir = join(tmpdir(), "rotifer-reproducible-" + randomUUID());
    geneDir = join(projectDir, "genes", GENE);
    mkdirSync(join(projectDir, "genes"), { recursive: true });
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "repro", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "tooling" }),
    );
    cpSync(join(ROOT, "genes", GENE), geneDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it.skipIf(!hasJavyToolchain)("two compiles of one source: identical gene.wasm, gene.ir.wasm and v2 gene ID, and it still runs", async () => {

    const first = run(`compile ${GENE}`, projectDir);
    expect(first.exitCode, first.stdout).toBe(0);
    expect(first.stdout).not.toContain("not reproducible");
    const wasm1 = sha(join(geneDir, "gene.wasm"));
    const ir1 = sha(join(geneDir, "gene.ir.wasm"));
    const { geneIdV2 } = await import("../../src/utils/binding.js");
    const id1 = geneIdV2(join(projectDir, "genes"), GENE);
    // Where the native addon is present, the ID must be a real one, not an
    // error string that happens to repeat.
    if (!("reason" in id1 && id1.reason === "native module not available")) {
      expect(id1, JSON.stringify(id1)).toHaveProperty("id");
    }

    // The clock moves between the two; on main this is what made them differ.
    await new Promise((r) => setTimeout(r, 1100));

    const second = run(`compile ${GENE}`, projectDir);
    expect(second.exitCode, second.stdout).toBe(0);
    expect(sha(join(geneDir, "gene.wasm"))).toBe(wasm1);
    expect(sha(join(geneDir, "gene.ir.wasm"))).toBe(ir1);
    expect(geneIdV2(join(projectDir, "genes"), GENE)).toEqual(id1);

    const ran = run(`run ${GENE} --input '{"code":"{\\"a\\":1}","language":"json"}'`, projectDir);
    expect(ran.exitCode, ran.stdout).toBe(0);
    if (hasSandbox) {
      expect(ran.stdout).toContain("Running via WASM sandbox");
    }
    expect(ran.stdout).toContain('"changed": true');
  }, 240_000);
});
