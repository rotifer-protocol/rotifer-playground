import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { detectAsyncExpress, findGeneSource } from "../../src/utils/javy-compiler.js";

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
 * These checks are static: they read the files the compiler reads and apply the
 * guards it applies, without invoking the toolchain.
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

/** What `moduleSpecifiers` reports for `require(x)` / `import(x)` with a non-literal argument. */
const COMPUTED = "<computed specifier>";

/**
 * Every module a source text loads: static imports and re-exports,
 * `import x = require()`, `require()` and `import()`. Type-only imports are
 * erased before bundling and are left out.
 *
 * Read from the syntax tree rather than the text: a gene that *talks about*
 * `require(` in a string (vuln-detector's Solidity advice does) loads nothing.
 */
function moduleSpecifiers(source: string, fileName = "gene.ts"): string[] {
  const found: string[] = [];
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const literal = (node: ts.Node | undefined): string =>
    node && ts.isStringLiteralLike(node) ? node.text : COMPUTED;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) found.push(literal(node.moduleSpecifier));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (!node.isTypeOnly) found.push(literal(node.moduleSpecifier));
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      if (!node.isTypeOnly) found.push(literal(node.moduleReference.expression));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads =
        callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
      if (loads) found.push(literal(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** A module the Javy sandbox does not have: any Node built-in, with or without `node:`. */
function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

/**
 * The modules a gene's entry file loads, following its relative imports into
 * the gene's other files the way the bundler would. Returns `specifier (file)`.
 */
function geneModuleLoads(entry: string): string[] {
  const loads: string[] = [];
  const seen = new Set<string>();
  const resolveLocal = (from: string, spec: string): string | null => {
    const base = join(dirname(from), spec);
    const candidates = [base, `${base}.ts`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")];
    return candidates.find((p) => existsSync(p) && statSync(p).isFile()) ?? null;
  };
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of moduleSpecifiers(readFileSync(file, "utf-8"), file)) {
      loads.push(`${spec} (${relative(GENES_DIR, file)})`);
      if (spec.startsWith(".")) {
        const next = resolveLocal(file, spec);
        if (next) walk(next);
      }
    }
  };
  walk(entry);
  return loads;
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
   * A Native gene that loads `node:fs` cannot be built at all: `rotifer
   * compile` stops at "Could not resolve", and the declaration it ships with
   * is false. Two starter genes did exactly that, and `hello --template
   * quality-advisor` then could not export its agent.
   *
   * A gene that genuinely needs the host is Wrapped (no Wasm part) or Hybrid
   * (a Wasm part plus external services) — and says so.
   */
  it("loads no Node built-in module from any Native gene", () => {
    const offenders = genes
      .filter((name) => fidelityOf(name) === "Native")
      .flatMap((name) =>
        geneModuleLoads(findGeneSource(join(GENES_DIR, name))!)
          .filter((load) => {
            const spec = load.slice(0, load.lastIndexOf(" ("));
            return spec === COMPUTED || isNodeBuiltin(spec);
          })
          .map((load) => `${name}: ${load}`),
      );

    expect(offenders).toEqual([]);
  });

  /**
   * The check above is only as good as what it can see. Each form a gene could
   * use to reach a built-in, and the one string that merely mentions one.
   */
  it("sees every way a source loads a module", () => {
    const src = [
      'import { readFileSync } from "node:fs";',
      'import * as path from "path";',
      'import "fs/promises";',
      'import type { Stats } from "node:fs";',
      'export { homedir } from "os";',
      'import cp = require("child_process");',
      'const crypto = require("node:crypto");',
      'const net = await import("net");',
      "const anything = require(name);",
      'const advice = "(bool ok, ) = target.call(...); require(ok);";',
      'import { helper } from "./helper";',
    ].join("\n");

    expect(moduleSpecifiers(src)).toEqual([
      "node:fs",
      "path",
      "fs/promises",
      "os",
      "child_process",
      "node:crypto",
      "net",
      COMPUTED,
      "./helper",
    ]);
    expect(["node:fs", "path", "fs/promises", "os", "child_process", "node:crypto", "net"].every(isNodeBuiltin)).toBe(
      true,
    );
    expect(isNodeBuiltin("./helper")).toBe(false);
    expect(isNodeBuiltin("lodash")).toBe(false);
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
