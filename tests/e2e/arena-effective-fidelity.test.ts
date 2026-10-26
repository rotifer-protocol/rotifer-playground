/**
 * `arena submit` discounts by the tier the Gene earned on this run (T-95),
 * end to end through the built CLI.
 *
 * A Gene that declares Native but has no compiled artifact ran nothing: its
 * score comes off the content hash. It used to take the Native ×1.00 anyway.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { hasJavyToolchain, hasSandbox } from "./toolchain.js";
import { FIDELITY_DISCOUNT } from "../../src/types/phenotype.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const NOT_RUN_NOTE = "Declared Native, not run in the sandbox this time (counted as Wrapped)";

function run(args: string, cwd: string, home: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 60000,
      env: { ...process.env, HOME: home, FORCE_COLOR: "0", ROTIFER_TELEMETRY: "0", DO_NOT_TRACK: "1" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

describe.runIf(existsSync(CLI))("arena submit discounts by the tier that actually ran", () => {
  let projectDir: string;
  let home: string;

  const writeGene = (name: string, fidelity: string) => {
    mkdirSync(join(projectDir, "genes", name), { recursive: true });
    writeFileSync(
      join(projectDir, "genes", name, "phenotype.json"),
      JSON.stringify({
        domain: "general",
        inputSchema: { type: "object", properties: { name: { type: "string" } } },
        outputSchema: { type: "object", properties: { greeting: { type: "string" } } },
        version: "0.1.0",
        fidelity,
      }, null, 2),
    );
  };
  const cache = (name: string) =>
    JSON.parse(readFileSync(join(projectDir, "genes", name, ".arena-cache.json"), "utf-8"));

  beforeEach(() => {
    projectDir = join(tmpdir(), "rotifer-effective-fidelity-" + randomUUID());
    home = join(projectDir, ".home");
    mkdirSync(home, { recursive: true });
    mkdirSync(join(projectDir, "genes"), { recursive: true });
    writeFileSync(
      join(projectDir, "rotifer.json"),
      JSON.stringify({ name: "fx", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
    );
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("a declared Native with no compiled artifact takes the Wrapped discount and says so", () => {
    writeGene("native-uncompiled", "Native");
    const { stdout, exitCode } = run("arena submit native-uncompiled", projectDir, home);
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain(NOT_RUN_NOTE);
    expect(stdout).toContain("wrapped discount");

    const c = cache("native-uncompiled");
    expect(c.fidelity_discount).toBe(FIDELITY_DISCOUNT.wrapped);
    expect(c.fitness).toBeCloseTo(c.base_fitness * FIDELITY_DISCOUNT.wrapped, 12);
    expect(c.declared_fidelity).toBe("Native");
    expect(c.effective_fidelity).toBe("Wrapped");
  });

  it("Wrapped and Hybrid are scored as declared, with no note", () => {
    writeGene("wrapped-gene", "Wrapped");
    writeGene("hybrid-gene", "Hybrid");
    for (const [name, tier, discount] of [
      ["wrapped-gene", "Wrapped", FIDELITY_DISCOUNT.wrapped],
      ["hybrid-gene", "Hybrid", FIDELITY_DISCOUNT.hybrid],
    ] as const) {
      const { stdout, exitCode } = run(`arena submit ${name}`, projectDir, home);
      expect(exitCode, stdout).toBe(0);
      expect(stdout).not.toContain(NOT_RUN_NOTE);
      const c = cache(name);
      expect(c.fidelity_discount).toBe(discount);
      expect(c.declared_fidelity).toBe(tier);
      expect(c.effective_fidelity).toBe(tier);
    }
  });

  // Needs the TS→WASM toolchain and the napi sandbox; skipped where either is
  // missing, so a run without them reads as skipped rather than passed.
  it.skipIf(!hasJavyToolchain || !hasSandbox)("a declared Native that ran in the sandbox keeps the Native discount", () => {
    const src = join(__dirname, "..", "..", "genes", "genesis-code-format");
    const dest = join(projectDir, "genes", "genesis-code-format");
    execSync(`cp -R "${src}" "${dest}"`);
    const compiled = run("compile genesis-code-format", projectDir, process.env.HOME ?? home);
    expect(compiled.exitCode, compiled.stdout).toBe(0);
    expect(existsSync(join(dest, "gene.ir.wasm"))).toBe(true);

    const { stdout, exitCode } = run("arena submit genesis-code-format", projectDir, home);
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("Sandbox verified");
    expect(stdout).not.toContain(NOT_RUN_NOTE);
    const c = cache("genesis-code-format");
    expect(c.fidelity_discount).toBe(FIDELITY_DISCOUNT.native);
    expect(c.effective_fidelity).toBe("Native");
  }, 120_000);

  it("--cloud does not send a Native score that ran nothing, and says why before asking for a login", () => {
    writeGene("native-uncompiled", "Native");
    const { stdout, exitCode } = run("arena submit native-uncompiled --cloud", projectDir, home);
    expect(exitCode, stdout).toBe(0);
    expect(stdout).toContain("Not sent to the cloud Arena");
    expect(stdout).toContain("rotifer compile native-uncompiled");
    expect(stdout).not.toContain("Submitting to cloud Arena");
    expect(stdout).not.toMatch(/not logged in|rotifer login/i);
  });
});
