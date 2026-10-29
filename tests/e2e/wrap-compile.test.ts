/**
 * wrap → compile → run, on a gene `wrap` scaffolded itself (#448).
 *
 * `wrap` writes `createdAt` as an ISO 8601 string; rotifer-core's Phenotype
 * reads it as u64 epoch ms. compile handed phenotype.json to the native IR
 * compiler as written, so every freshly wrapped synchronous gene passed
 * `rotifer test` and then failed at the last compile step with
 * `invalid type: string "…", expected u64`, under a hint about WASM exports.
 *
 * The gene starts without a phenotype on purpose: a copied bundled phenotype
 * already has a numeric timestamp and hides the failure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { hasJavyToolchain, hasSandbox } from "./toolchain.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, cwd: string, timeout = 120_000): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout,
      env: { ...process.env, FORCE_COLOR: "0", ROTIFER_AUTO_PUBLISH: "0", ROTIFER_TELEMETRY: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

const SYNC_SOURCE = `export function express(input: { name: string }): { greeting: string } {
  return { greeting: "Hello, " + input.name };
}
`;

describe("wrap → compile (#448)", { timeout: 300_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), "rotifer-wrap-compile-" + randomUUID());
    mkdirSync(join(dir, "genes", "qa-sync"), { recursive: true });
    mkdirSync(join(dir, ".rotifer"), { recursive: true });
    writeFileSync(
      join(dir, "rotifer.json"),
      JSON.stringify({ name: "wrap-compile", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
    );
    writeFileSync(join(dir, "genes", "qa-sync", "index.ts"), SYNC_SOURCE);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasJavyToolchain || !hasSandbox)(
    "compiles a gene wrap scaffolded, and the IR runs",
    () => {
      const wrapped = run("wrap qa-sync --domain test.greeting", dir);
      expect(wrapped.exitCode, wrapped.stdout).toBe(0);
      const phenotype = JSON.parse(readFileSync(join(dir, "genes", "qa-sync", "phenotype.json"), "utf-8"));
      // The precondition the bug needs: wrap's own ISO timestamp.
      expect(typeof phenotype.createdAt).toBe("string");

      const compiled = run("compile qa-sync", dir);
      expect(compiled.stdout).not.toContain("expected u64");
      expect(compiled.exitCode, compiled.stdout).toBe(0);
      expect(existsSync(join(dir, "genes", "qa-sync", "gene.ir.wasm"))).toBe(true);

      // phenotype.json keeps the timestamp as wrap wrote it.
      const after = JSON.parse(readFileSync(join(dir, "genes", "qa-sync", "phenotype.json"), "utf-8"));
      expect(after.createdAt).toBe(phenotype.createdAt);

      const ran = run(`run qa-sync --input '{"name":"wrap"}'`, dir);
      expect(ran.exitCode, ran.stdout).toBe(0);
      expect(ran.stdout).toContain("Hello, wrap");
    },
  );

  it("names createdAt when it is not a date, instead of pointing at WASM exports", () => {
    writeFileSync(
      join(dir, "genes", "qa-sync", "phenotype.json"),
      JSON.stringify({
        domain: "test.greeting",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
        outputSchema: { type: "object", properties: { greeting: { type: "string" } } },
        version: "0.1.0",
        fidelity: "Native",
        createdAt: "last tuesday",
      }),
    );
    const compiled = run("compile qa-sync", dir);
    expect(compiled.exitCode).toBe(1);
    expect(compiled.stdout).toContain("createdAt");
    expect(compiled.stdout).not.toContain("exports `express(i32,i32)->i32`");
  });
});
