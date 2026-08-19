import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
 * Genes that legitimately await, and so cannot be compiled today.
 *
 * They are not oversights — each performs real async I/O. The compiler's own
 * E0025 hint says to "keep it async and run via Node (--no-sandbox) / a Hybrid
 * Gene", but `compile` does not branch on declared fidelity: any gene with an
 * `index.ts` goes through Javy regardless. So the escape hatch the error points
 * at is not currently wired, and these genes have nowhere to go until it is.
 *
 * This list may shrink; it must never grow. A new async gene should fail here
 * rather than quietly join a backlog. Tracked as ADR-319 plan item 2.11.
 */
const AWAITS_REAL_IO = [
  "answer-synthesizer",
  "chain-reader",
  "clawhub-web-search",
  "doc-retrieval",
  "polymarket-scanner",
  "sirchmunk-search",
  "telegram-bot-notifier",
] as const;

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
  it("exports a synchronous express() from every gene that does not do real I/O", () => {
    const offenders = genes
      .filter((name) => !(AWAITS_REAL_IO as readonly string[]).includes(name))
      .map((name) => {
        const src = findGeneSource(join(GENES_DIR, name))!;
        const shape = detectAsyncExpress(readFileSync(src, "utf-8"));
        return shape ? `${name}: ${shape}` : null;
      })
      .filter((x): x is string => x !== null);

    expect(offenders).toEqual([]);
  });

  /** The exemption list must shrink, never grow — so its contents are pinned. */
  it("keeps the async exemption list honest", () => {
    const stillAsync = genes.filter((name) => {
      const src = findGeneSource(join(GENES_DIR, name))!;
      return detectAsyncExpress(readFileSync(src, "utf-8")) !== null;
    });
    expect(stillAsync.sort()).toEqual([...AWAITS_REAL_IO].sort());
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
