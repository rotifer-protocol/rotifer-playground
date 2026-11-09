/**
 * A gene made with `rotifer wrap` must run in the WASM sandbox.
 *
 * `wrap` writes `createdAt` as an ISO 8601 string; rotifer-core reads it as
 * epoch milliseconds. `compile` converts it (toRustPhenotype), but `test`,
 * `arena submit` and `run` handed the raw phenotype to `executeGene`, so the
 * sandbox answered `invalid phenotype JSON: invalid type: string "...",
 * expected u64` and every wrapped gene scored 0/3 and was refused admission.
 * That is the README's own custom-gene walk-through (wrap -> compile -> arena
 * submit), found when a clean install was run end to end on 0.35.0.
 *
 * This runs the real CLI against the real sandbox. Needs `npm run build`, the
 * native module, and esbuild + javy-cli on PATH (a missing precondition shows
 * as skipped, not passed: see toolchain.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { hasJavyToolchain, hasSandbox } from "./toolchain.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const GENE = "iso-search";
const ready = hasJavyToolchain && hasSandbox && existsSync(CLI);

describe.runIf(ready)("wrapped gene runs in the sandbox (ISO createdAt in phenotype.json)", () => {
  let project = "";

  const run = (args: string[], timeout = 120_000): { code: number; out: string } => {
    const r = spawnSync("node", [CLI, ...args], {
      cwd: project,
      encoding: "utf-8",
      timeout,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        ROTIFER_TELEMETRY: "off",
        ROTIFER_NO_UPDATE_CHECK: "1",
      },
    });
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "rotifer-wrap-sandbox-"));
    mkdirSync(join(project, "genes", GENE), { recursive: true });
    writeFileSync(
      join(project, "rotifer.json"),
      JSON.stringify({ name: "wrap-sandbox", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
    );
    // The README's example gene.
    writeFileSync(
      join(project, "genes", GENE, "index.ts"),
      "export function express(input: { query: string }) {\n  return { results: [`Found: ${input.query}`], total: 1 };\n}\n",
    );
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("`rotifer test` and `rotifer arena submit` execute a freshly wrapped, compiled gene", () => {
    const wrapped = run(["wrap", GENE, "--domain", "search"]);
    expect(wrapped.code, wrapped.out).toBe(0);
    const phenotype = JSON.parse(readFileSync(join(project, "genes", GENE, "phenotype.json"), "utf-8"));
    // The premise of the bug: wrap really does write a string timestamp.
    expect(typeof phenotype.createdAt).toBe("string");

    const compiled = run(["compile", GENE], 240_000);
    expect(compiled.code, compiled.out).toBe(0);

    const tested = run(["test", GENE]);
    expect(tested.out).not.toMatch(/invalid phenotype JSON/);
    expect(tested.out).toMatch(/executeGene\(\) succeeded/);

    const submitted = run(["arena", "submit", GENE]);
    expect(submitted.out).not.toMatch(/invalid phenotype JSON/);
    expect(submitted.out).toMatch(/Sandbox execution: 3\/3 passed/);
    expect(submitted.out).not.toMatch(/does not meet admission threshold/);
  }, 400_000);
});
