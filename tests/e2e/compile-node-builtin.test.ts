/**
 * `rotifer compile` on a gene whose source loads a Node built-in.
 *
 * Compiling a TypeScript gene means bundling it for Javy/QuickJS, which has
 * no Node runtime, so `node:os` or a bare `path` can never resolve. Before
 * this was checked up front, esbuild's "Could not resolve" reached the user
 * with a suggestion to install esbuild and javy-cli — the two tools that had
 * just run. A Wrapped gene that reads the disk is not broken; it just cannot
 * become Native, and compile should say that and leave it Wrapped.
 *
 * Real CLI, real esbuild. Needs `npm run build` and the toolchain on PATH (a
 * missing precondition shows as skipped, not passed: see toolchain.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { hasJavyToolchain } from "./toolchain.js";

const CLI = join(__dirname, "..", "..", "dist", "index.js");
const GENE = "disk-reader";
const TOOLCHAIN_ADVICE = /npm i -g esbuild javy-cli|Ensure esbuild/;

let project = "";
const geneDir = (): string => join(project, "genes", GENE);
const phenotype = (): Record<string, unknown> => JSON.parse(readFileSync(join(geneDir(), "phenotype.json"), "utf-8"));

const run = (args: string[], path = process.env.PATH): { code: number; out: string } => {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: project,
    encoding: "utf-8",
    timeout: 120_000,
    env: { ...process.env, PATH: path, FORCE_COLOR: "0", ROTIFER_TELEMETRY: "off", ROTIFER_NO_UPDATE_CHECK: "1" },
  });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/** A wrapped gene loading `node:os` directly and `path` through `./helper.js`. */
function makeProject(): void {
  project = mkdtempSync(join(tmpdir(), "rotifer-compile-builtin-"));
  mkdirSync(geneDir(), { recursive: true });
  writeFileSync(
    join(project, "rotifer.json"),
    JSON.stringify({ name: "compile-builtin", version: "0.1.0", author: "test", genes_dir: "genes", default_domain: "general" }),
  );
  // One built-in in the entry file, one reached through a relative import
  // written the TypeScript-ESM way (`./helper.js` naming `helper.ts`).
  writeFileSync(
    join(geneDir(), "index.ts"),
    [
      'import { homedir } from "node:os";',
      'import { sep } from "./helper.js";',
      "export function express(input: { q: string }) {",
      "  return { home: homedir(), sep, q: input.q };",
      "}",
      "",
    ].join("\n"),
  );
  writeFileSync(join(geneDir(), "helper.ts"), 'import path from "path";\nexport const sep = path.sep;\n');

  const wrapped = run(["wrap", GENE, "--domain", "tools"]);
  expect(wrapped.code, wrapped.out).toBe(0);
}

describe.runIf(hasJavyToolchain && existsSync(CLI))("compile on a gene that needs Node built-ins", () => {
  beforeEach(makeProject);
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("names the modules, keeps the gene Wrapped, and does not blame the toolchain", () => {
    expect(phenotype().fidelity).toBe("Wrapped");

    const compiled = run(["compile", GENE]);
    expect(compiled.code, compiled.out).not.toBe(0);
    expect(compiled.out).toMatch(/Node built-in/);
    expect(compiled.out).toContain("node:os");
    expect(compiled.out).toMatch(/\bpath\b/);
    expect(compiled.out).toMatch(/cannot be compiled to Native/);
    expect(compiled.out).toMatch(/stays Wrapped/);
    expect(compiled.out).not.toMatch(TOOLCHAIN_ADVICE);

    expect(phenotype().fidelity).toBe("Wrapped");
    expect(existsSync(join(geneDir(), "gene.wasm"))).toBe(false);
    expect(existsSync(join(geneDir(), "gene.ir.wasm"))).toBe(false);
  }, 180_000);

  it("tells a gene declared Native to declare Wrapped instead", () => {
    const declared = { ...phenotype(), fidelity: "Native" };
    writeFileSync(join(geneDir(), "phenotype.json"), JSON.stringify(declared, null, 2));

    const compiled = run(["compile", GENE]);
    expect(compiled.code, compiled.out).not.toBe(0);
    expect(compiled.out).toContain("node:os");
    expect(compiled.out).toMatch(/cannot be compiled to Native/);
    expect(compiled.out).toMatch(/"fidelity": "Wrapped"/);
    expect(compiled.out).not.toMatch(TOOLCHAIN_ADVICE);
    expect(existsSync(join(geneDir(), "gene.ir.wasm"))).toBe(false);
  }, 180_000);
});

/**
 * The check needs esbuild, so it cannot run without it — and must not guess.
 * With no toolchain the answer is still "install the toolchain": a missing
 * esbuild is not evidence about the gene's imports. PATH here holds `node` and
 * the system directories only, so neither `esbuild` nor `npx` resolves.
 */
describe.runIf(existsSync(CLI) && process.platform !== "win32")("compile on that gene without esbuild", () => {
  beforeEach(makeProject);
  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("reports the missing toolchain, not the Node built-ins", () => {
    const bin = join(project, "bin");
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));

    const compiled = run(["compile", GENE], `${bin}:/usr/bin:/bin`);
    expect(compiled.code, compiled.out).not.toBe(0);
    expect(compiled.out).toMatch(/toolchain unavailable/);
    expect(compiled.out).toMatch(/esbuild: missing/);
    expect(compiled.out).not.toMatch(/Node built-in/);
    expect(compiled.out).not.toMatch(/E0026/);
  }, 180_000);
});
