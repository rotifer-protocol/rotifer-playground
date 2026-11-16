import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import ts from "typescript";
import {
  detectAsyncExpress,
  findGeneSource,
  isNodeBuiltin,
  resolveEsbuild,
  scanNodeBuiltins,
  type NodeBuiltinScan,
} from "../../src/utils/javy-compiler.js";

/**
 * The genes in `genes/` are what `rotifer init` hands a new user and what this
 * project publishes to the Arena. Before ADR-319's stage 2.10, **33 of the 50
 * the compiler can see were provably uncompilable**: 29 exported an async
 * `express()` the Javy guard rejects (E0025), and 13 carried a
 * `failureSemantics` literal ADR-297 moved to a different enum (E0023).
 *
 * That is upstream of the Arena's integrity problem, not beside it. A gene that
 * cannot compile still gets published — either with no artifact, or with one
 * built before the guard existed — and both yield a score nobody can reproduce.
 * Invalidating those rows without fixing the corpus refills the board from the
 * same source.
 *
 * These checks read the files the compiler reads and apply the guards it
 * applies. The Node built-in check runs esbuild, exactly as `rotifer compile`
 * does before bundling for Javy; nothing is compiled to WASM.
 */

const GENES_DIR = join(__dirname, "..", "..", "genes");
const RUST_GENE_TYPES = join(
  __dirname,
  "..",
  "..",
  "crates",
  "rotifer-core",
  "src",
  "types",
  "gene.rs"
);

/**
 * The async `express()` guard applies to the Javy path, and only Native genes
 * take it: `compile` now branches on declared fidelity, and a Hybrid gene runs
 * under Node.js with the network gateway, where `async` is the normal shape.
 * So the check below covers Native genes only, and the six Hybrid genes that
 * used to sit in an exemption list here are simply not in scope any more.
 *
 * What remains exempt is narrower and should stay narrow: a *Wrapped* gene that
 * carries an async `index.ts`. Wrapped promises no artifact, so it never goes
 * through Javy either; it is listed rather than skipped so that a second one
 * appearing is a visible event, not a silent addition.
 *
 * This list may shrink; it must never grow.
 */
const WRAPPED_WITH_ASYNC_SOURCE = [
  "clawhub-web-search",
] as const;

/** Fidelities the Javy guard applies to. */
function fidelityOf(name: string): string {
  const phenotype = JSON.parse(readFileSync(join(GENES_DIR, name, "phenotype.json"), "utf-8"));
  return phenotype?.fidelity ?? "Wrapped";
}

/** Gene directories the compiler can see a source in — the ones it would build. */
function compilableGenes(): string[] {
  return readdirSync(GENES_DIR).filter((name) => {
    const dir = join(GENES_DIR, name);
    return existsSync(join(dir, "phenotype.json")) && findGeneSource(dir) !== null;
  });
}

/**
 * Every `failureSemantics` literal the deserialiser accepts, read from the Rust
 * enum rather than restated here — the same anti-drift approach the async-express
 * markers use.
 *
 * Both the canonical SCREAMING_SNAKE_CASE names and the `#[serde(alias = "…")]`
 * legacy spellings count, because both compile today. The aliases are scheduled
 * for removal at the v0.9.2 hard cut (ADR-297 D3 phase 4), at which point the
 * genes still using them break — so `legacyAliasUsers` below keeps that visible
 * instead of letting it arrive as a surprise.
 */
function acceptedFailureSemantics(): { canonical: string[]; aliases: string[] } {
  const src = readFileSync(RUST_GENE_TYPES, "utf-8");
  const block = src.match(/pub enum EventualFailureSemantics \{([\s\S]*?)\n\}/);
  if (!block) {
    throw new Error(
      `EventualFailureSemantics not found in ${RUST_GENE_TYPES}. If it moved, update this test — do not delete it.`
    );
  }
  const canonical = [...block[1].matchAll(/^\s{4}([A-Z][A-Za-z]*),\s*$/gm)].map(([, v]) =>
    v.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase()
  );
  const aliases = [...block[1].matchAll(/alias\s*=\s*"([^"]+)"/g)].map(([, v]) => v);
  return { canonical, aliases };
}

/**
 * esbuild, resolved the way `rotifer compile` resolves it. It is a
 * devDependency, so it is always present in this repo and in CI: a missing one
 * fails the check below instead of skipping it.
 */
const ESBUILD = resolveEsbuild();

const scans = new Map<string, NodeBuiltinScan>();

/** `compile`'s own Node built-in scan of a gene's source, once per gene. */
function scanOf(name: string): NodeBuiltinScan {
  if (!scans.has(name)) scans.set(name, scanNodeBuiltins(findGeneSource(join(GENES_DIR, name))!, ESBUILD!));
  return scans.get(name)!;
}

/** What `runtimeOnlyLoads` reports for `require(x)` / `import(x)` with a non-literal argument. */
const COMPUTED = "<computed specifier>";

/** Names a gene could reach the host's `require` through. */
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window", "self"]);

/**
 * Loads that are not imports, so neither esbuild nor `compile` can see them,
 * and under Javy they fail only when the gene runs: `globalThis.require(...)`
 * (or `global` / `window` / `self`, dotted or bracketed), and `require(x)` /
 * `import(x)` with a computed `x`.
 *
 * Read from the TypeScript syntax tree rather than the text: a gene that
 * *talks about* `require(` in a string (vuln-detector's Solidity advice does)
 * loads nothing.
 */
function runtimeOnlyLoads(source: string, fileName = "gene.ts"): string[] {
  const found: string[] = [];
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const isGlobal = (node: ts.Node): node is ts.Identifier => ts.isIdentifier(node) && GLOBAL_OBJECTS.has(node.text);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      const arg = node.arguments[0];
      if (loads && !(arg && ts.isStringLiteralLike(arg))) found.push(COMPUTED);
    } else if (ts.isPropertyAccessExpression(node) && isGlobal(node.expression) && node.name.text === "require") {
      found.push(`${node.expression.text}.require`);
    } else if (
      ts.isElementAccessExpression(node) &&
      isGlobal(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "require"
    ) {
      found.push(`${node.expression.text}.require`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** Write a throwaway gene, run `fn` on its entry file, clean up. */
function withGene<T>(files: Record<string, string>, fn: (entry: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "rotifer-builtin-fixture-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return fn(join(dir, "index.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function failureSemanticsOf(name: string): string | null {
  const phenotype = JSON.parse(readFileSync(join(GENES_DIR, name, "phenotype.json"), "utf-8"));
  return phenotype?.semanticRequirements?.failureSemantics ?? null;
}

describe("bundled genes are compilable", () => {
  const genes = compilableGenes();

  it("finds the bundled corpus", () => {
    expect(genes.length).toBeGreaterThan(30);
  });

  /**
   * E0025. Javy/QuickJS has no event loop, so an async `express()` hands back a
   * Promise the shim serialises to `{}` — the gene reports success and produces
   * nothing. Shipping one in the starter corpus hands the user a dead end.
   */
  it("exports a synchronous express() from every Native gene", () => {
    const offenders = genes
      .filter((name) => fidelityOf(name) === "Native")
      .map((name) => {
        const src = findGeneSource(join(GENES_DIR, name))!;
        const shape = detectAsyncExpress(readFileSync(src, "utf-8"));
        return shape ? `${name}: ${shape}` : null;
      })
      .filter((x): x is string => x !== null);

    expect(offenders).toEqual([]);
  });

  /**
   * Native means the gene compiles to Rotifer IR (spec, "Fidelity"), and the
   * compiler bundles the source for Javy/QuickJS, which has no Node built-ins.
   * A Native gene that loads `node:fs` cannot be built at all, and the
   * declaration it ships with is false. Two starter genes did exactly that,
   * and `hello --template quality-advisor` then could not export its agent.
   *
   * This asks the same question `rotifer compile` now asks before bundling,
   * with the same esbuild scan, so the corpus and the command cannot disagree.
   * A source esbuild cannot bundle at all (an import that does not resolve)
   * counts against the gene rather than passing unread.
   *
   * A gene that genuinely needs the host is Wrapped (no Wasm part) or Hybrid
   * (a Wasm part plus external services) — and says so.
   */
  it("loads no Node built-in module from any Native gene", () => {
    expect(ESBUILD, "esbuild is a devDependency; without it this check cannot run").not.toBeNull();

    const offenders = genes
      .filter((name) => fidelityOf(name) === "Native")
      .flatMap((name) => {
        const scan = scanOf(name);
        if (scan.status === "failed") return [`${name}: esbuild could not bundle it: ${scan.message.split("\n")[0]}`];
        return scan.builtins.map((m) => `${name}: imports ${m}`);
      });

    expect(offenders).toEqual([]);
  }, 120_000);

  /**
   * What the scan above cannot see, because it is not an import: these would
   * compile, then fail inside the sandbox the first time the line runs.
   * Checked across every file the bundle reaches.
   */
  it("reaches for no host require that compile cannot see, in any Native gene", () => {
    expect(ESBUILD).not.toBeNull();

    const offenders = genes
      .filter((name) => fidelityOf(name) === "Native")
      .flatMap((name) => {
        const scan = scanOf(name);
        if (scan.status === "failed") return [];
        return scan.files.flatMap((file) =>
          runtimeOnlyLoads(readFileSync(file, "utf-8"), file).map((load) => `${name}: ${load} (${basename(file)})`),
        );
      });

    expect(offenders).toEqual([]);
  }, 120_000);

  /**
   * The scan is only as good as what it can see. One gene using every import
   * form, part of it behind relative imports written the TypeScript-ESM way
   * (`./helper.js` naming `helper.ts`), plus a type-only import and a string
   * that merely mentions `require(`, neither of which loads anything.
   */
  it("names every Node built-in a source loads, through its relative imports", () => {
    expect(ESBUILD).not.toBeNull();

    const scan = withGene(
      {
        "index.ts": [
          'import { homedir } from "node:os";',
          'import type { Stats } from "node:zlib";',
          'import { sep } from "./helper.js";',
          'export * from "./more";',
          'const fs = require("fs");',
          'const advice = "(bool ok, ) = target.call(...); require(ok);";',
          'export function express() { return { home: homedir(), sep, fs: !!fs, advice }; }',
          'export async function later() { return import("node:crypto"); }',
          "",
        ].join("\n"),
        "helper.ts": 'import path from "path";\nexport const sep = path.sep;\n',
        "more.ts": 'export { createServer } from "http";\n',
      },
      (entry) => scanNodeBuiltins(entry, ESBUILD!),
    );

    expect(scan.status).toBe("ok");
    if (scan.status !== "ok") return;
    expect([...scan.builtins].sort()).toEqual(["fs", "http", "node:crypto", "node:os", "path"]);
    expect(scan.files.map((f) => basename(f)).sort()).toEqual(["helper.ts", "index.ts", "more.ts"]);
  }, 60_000);

  it("treats an import that does not resolve as a failure, not as clean", () => {
    expect(ESBUILD).not.toBeNull();

    const scan = withGene(
      { "index.ts": 'import { y } from "./missing.js";\nexport function express() { return { y }; }\n' },
      (entry) => scanNodeBuiltins(entry, ESBUILD!),
    );

    expect(scan.status).toBe("failed");
    if (scan.status === "failed") expect(scan.message).toMatch(/missing/);
  }, 60_000);

  it("knows a built-in by either spelling, and nothing else", () => {
    expect(["node:fs", "path", "fs/promises", "os", "child_process", "node:crypto", "node:test"].every(isNodeBuiltin)).toBe(
      true,
    );
    expect(["./helper", "lodash", "pathe"].some(isNodeBuiltin)).toBe(false);
  });

  it("sees the host requires that compile cannot", () => {
    const src = [
      "const a = require(name);",
      "const b = await import(`./${x}`);",
      'const c = globalThis.require("fs");',
      'const d = global["require"]("os");',
      'const e = require("fs");',
      'const f = await import("node:os");',
      'const advice = "(bool ok, ) = target.call(...); globalThis.require(ok);";',
    ].join("\n");

    expect(runtimeOnlyLoads(src)).toEqual([COMPUTED, COMPUTED, "globalThis.require", "global.require"]);
  });

  /**
   * A Hybrid gene that awaits is doing I/O, and the gateway is the only
   * sanctioned way to do it — so it must say which hosts. The spec treats an
   * undeclared `network` as "no network access"; an async Hybrid gene with no
   * declaration is therefore either reaching around the gateway or about to
   * fail at runtime. A *synchronous* Hybrid gene is not held to this: the spec
   * lets a Hybrid gene declare no network at all, and three in the corpus do.
   */
  it("declares network domains on every Hybrid gene that awaits", () => {
    const missing = genes
      .filter((name) => fidelityOf(name) === "Hybrid")
      .filter((name) => {
        const src = findGeneSource(join(GENES_DIR, name))!;
        return detectAsyncExpress(readFileSync(src, "utf-8")) !== null;
      })
      .filter((name) => {
        const phenotype = JSON.parse(readFileSync(join(GENES_DIR, name, "phenotype.json"), "utf-8"));
        return !(phenotype?.network?.allowedDomains?.length > 0);
      });
    expect(missing).toEqual([]);
  });

  /** The exemption list must shrink, never grow — so its contents are pinned. */
  it("keeps the Wrapped-with-async list honest", () => {
    const wrappedAsync = genes.filter((name) => {
      if (fidelityOf(name) !== "Wrapped") return false;
      const src = findGeneSource(join(GENES_DIR, name))!;
      return detectAsyncExpress(readFileSync(src, "utf-8")) !== null;
    });
    expect(wrappedAsync.sort()).toEqual([...WRAPPED_WITH_ASYNC_SOURCE].sort());
  });

  /**
   * E0023. ADR-297 split the old 5-variant `FailureSemantics` along two
   * orthogonal axes; `Fail` and `Fallback` moved to `ExternalDependencyBehavior`
   * and stopped being valid here. A phenotype still using them fails IR
   * compilation *after* the WASM builds, which reads as a toolchain problem
   * rather than a stale literal — one reason it went unnoticed.
   */
  it("declares failureSemantics in a vocabulary the deserialiser accepts", () => {
    const { canonical, aliases } = acceptedFailureSemantics();
    const accepted = new Set([...canonical, ...aliases]);
    expect(accepted.has("FAIL_FAST")).toBe(true);

    const offenders = genes
      .map((name) => {
        const value = failureSemanticsOf(name);
        if (value == null) return null; // optional field
        return accepted.has(value) ? null : `${name}: ${value}`;
      })
      .filter((x): x is string => x !== null);

    expect(offenders).toEqual([]);
  });

  /**
   * Not a failure today — a countdown. These compile only because of the serde
   * aliases, which ADR-297 D3 phase 4 removes at v0.9.2. Asserting the count
   * rather than zero keeps the number in front of us without failing the build
   * over something that still works.
   */
  it("reports how many genes still rely on the deprecated legacy spellings", () => {
    const { aliases } = acceptedFailureSemantics();
    const legacyAliasUsers = genes.filter((name) => {
      const v = failureSemanticsOf(name);
      return v != null && aliases.includes(v);
    });
    expect(legacyAliasUsers.length).toBeLessThanOrEqual(20);
  });
});
