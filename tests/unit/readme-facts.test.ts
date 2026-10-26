import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The README's first-run section repeats facts the code decides: which genes
 * `init` installs, how many, and each one's fidelity. They were written by
 * hand and drifted — genesis-file-read listed as Native although its phenotype
 * says Wrapped, and "an Arena with 6 genes ranked" when a fresh workspace has 7,
 * none of them evaluated (T-88 item 4). These checks read the same sources the
 * CLI reads, so the README cannot drift from them again without CI going red.
 */

const ROOT = join(__dirname, "..", "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const INIT = readFileSync(join(ROOT, "src", "commands", "init.ts"), "utf8");

function listFromInit(name: string): string[] {
  const m = INIT.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!m) throw new Error(`${name} not found in init.ts`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]);
}

/** Fidelity as the gene declares it; hello-world is written by init itself as Wrapped. */
function declaredFidelity(gene: string): string {
  const p = join(ROOT, "genes", gene, "phenotype.json");
  if (!existsSync(p)) {
    if (gene === "hello-world") return "Wrapped";
    throw new Error(`genes/${gene}/phenotype.json not found`);
  }
  return JSON.parse(readFileSync(p, "utf8")).fidelity;
}

function starterBlockRows(): Array<[string, string]> {
  const start = README.indexOf("  Starter Genes");
  const end = README.indexOf("starter gene(s)", start);
  expect(start, "README has a Starter Genes block").toBeGreaterThan(-1);
  return [...README.slice(start, end).matchAll(/^ {2}([a-z0-9-]+)\s+\S+\s+(Native|Wrapped|Hybrid)\s*$/gm)].map(
    (m) => [m[1], m[2]] as [string, string],
  );
}

describe("README first-run facts match the code", () => {
  it("lists every gene init installs, with the fidelity each one declares", () => {
    const rows = starterBlockRows();
    const installed = [...listFromInit("GENESIS_GENES"), ...listFromInit("RECOMMENDED_TEMPLATE_GENES"), "hello-world"];

    expect(rows.map(([g]) => g).sort()).toEqual([...installed].sort());
    for (const [gene, fidelity] of rows) {
      expect(fidelity, `${gene} fidelity in README`).toBe(declaredFidelity(gene));
    }
  });

  it("states the starter gene count init prints", () => {
    const m = README.match(/(\d+) starter gene\(s\) across (\d+) domain\(s\)/);
    expect(m, "README shows the init summary line").not.toBeNull();
    expect(Number(m![1])).toBe(starterBlockRows().length);
  });

  it("gives each Genesis gene the fidelity its phenotype declares", () => {
    const table = [...README.matchAll(/^\| `(genesis-[a-z0-9-]+)` \| [^|]+ \| (Native|Wrapped|Hybrid) \|/gm)];
    expect(table.map((m) => m[1]).sort()).toEqual([...listFromInit("GENESIS_GENES")].sort());
    for (const [, gene, fidelity] of table) {
      expect(fidelity, `${gene} fidelity in the Genesis table`).toBe(declaredFidelity(gene));
    }
  });

  it("does not promise a ranked Arena right after init — a fresh workspace has nothing evaluated", () => {
    expect(README).not.toMatch(/Arena with \d+ genes ranked/);
  });
});
