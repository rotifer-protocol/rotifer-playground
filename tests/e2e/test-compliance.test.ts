/**
 * `rotifer test --compliance` on a compiled gene (#449).
 *
 * compile writes irHash into phenotype.json as 64-char hex; rotifer-core's
 * Phenotype reads it as 32 bytes. C3 handed phenotype.json to l0Check as is,
 * so every compiled gene passed C1 and C2 and then crashed C3 with
 * `expected an array of length 32` and an uncaught stack.
 *
 * The phenotype uses a numeric createdAt, so this is not #448's timestamp.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { hasJavyToolchain, hasSandbox } from "./toolchain.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");

function run(args: string, cwd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI} ${args}`, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, FORCE_COLOR: "0", ROTIFER_AUTO_PUBLISH: "0", ROTIFER_TELEMETRY: "0" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || "") + (err.stderr || ""), exitCode: err.status ?? 1 };
  }
}

const NUMBER_OBJECT = {
  type: "object",
  properties: { value: { type: "number" } },
  required: ["value"],
};

describe("test --compliance on a compiled gene (#449)", { timeout: 300_000 }, () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), "rotifer-compliance-" + randomUUID());
    const gene = join(dir, "genes", "qa-add");
    mkdirSync(gene, { recursive: true });
    mkdirSync(join(dir, ".rotifer"), { recursive: true });
    writeFileSync(
      join(dir, "rotifer.json"),
      JSON.stringify({ name: "compliance", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
    );
    writeFileSync(join(gene, "index.ts"), "export function express(input) { return { value: input.value + 1 }; }\n");
    writeFileSync(
      join(gene, "phenotype.json"),
      JSON.stringify({
        domain: "test.arithmetic",
        version: "0.1.0",
        fidelity: "Wrapped",
        transparency: "Open",
        createdAt: 0,
        inputSchema: NUMBER_OBJECT,
        outputSchema: NUMBER_OBJECT,
      }),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasJavyToolchain || !hasSandbox)("C3 runs the L0 gate on the compiled phenotype", () => {
    const compiled = run("compile qa-add", dir);
    expect(compiled.exitCode, compiled.stdout).toBe(0);
    const phenotype = JSON.parse(readFileSync(join(dir, "genes", "qa-add", "phenotype.json"), "utf-8"));
    // The precondition the bug needs: compile's own hex irHash.
    expect(phenotype.irHash).toMatch(/^[0-9a-f]{64}$/);

    const tested = run("test qa-add --compliance --verbose", dir);
    expect(tested.stdout).not.toContain("expected an array of length 32");
    expect(tested.stdout).toContain("L0Gate: PASS");
    expect(tested.exitCode, tested.stdout).toBe(0);
  });
});
