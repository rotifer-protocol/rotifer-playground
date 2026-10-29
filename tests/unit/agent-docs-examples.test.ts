/**
 * The agent examples in the docs describe what the CLI does (#445, #446).
 *
 * #446: copyable `agent create … --composition Seq` examples chained genes
 * whose fields do not meet — search results into a summarizer that needs
 * `text`, a greeting into a formatter that needs `code` and `language` — so
 * the pipeline "succeeds" with empty output. A Seq step can only work if the
 * fields the next gene requires are among the previous gene's outputs, which
 * is what this checks, against the genes' own phenotype.json. The Skill also
 * presented a flat Seq as Seq(Par(…), …) and said nesting works by editing
 * the agent file, which agent run never reads.
 *
 * #445: TryPool was described as a race; the runtime tries the active gene
 * and moves to the next one only on failure (src/runtime/domain-failover.ts).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DomainFailoverEngine } from "../../src/runtime/domain-failover.js";

const ROOT = process.cwd();
const DOCS = [
  "docs/getting-started.md",
  "docs/getting-started.zh.md",
  "skills/rotifer-agent/SKILL.md",
  "skills/rotifer-agent/README.md",
];

/** The tutorial's own gene (getting-started step 3); it is not in genes/. */
const TUTORIAL_GENES: Record<string, { required: string[]; outputs: string[] }> = {
  "hello-world": { required: ["name"], outputs: ["greeting"] },
};

function contract(gene: string): { required: string[]; outputs: string[] } | undefined {
  if (TUTORIAL_GENES[gene]) return TUTORIAL_GENES[gene];
  const path = join(ROOT, "genes", gene, "phenotype.json");
  if (!existsSync(path)) return undefined;
  const p = JSON.parse(readFileSync(path, "utf-8"));
  return {
    required: Array.isArray(p.inputSchema?.required) ? p.inputSchema.required : [],
    outputs: Object.keys(p.outputSchema?.properties ?? {}),
  };
}

/** `rotifer agent create <name> --genes a b c [--composition X]`, joined across `\` lines. */
function agentCreates(markdown: string): { name: string; genes: string[]; composition: string }[] {
  const joined = markdown.replace(/\\\n\s*/g, " ");
  return [...joined.matchAll(/rotifer agent create\s+(\S+)\s+--genes\s+([^\n]+)/g)].map((m) => {
    const rest = m[2];
    const genes = rest.split(/\s--/)[0].trim().split(/\s+/);
    const composition = /--composition\s+(\S+)/.exec(rest)?.[1] ?? "Seq";
    return { name: m[1], genes, composition };
  });
}

describe("Seq examples chain genes whose fields meet (#446)", () => {
  for (const doc of DOCS) {
    const markdown = readFileSync(join(ROOT, doc), "utf-8");
    // `<name>` / `<gene1>` placeholders are syntax, not an example to check.
    const seqs = agentCreates(markdown).filter(
      (a) => a.composition === "Seq" && a.genes.length > 1 && !a.genes.some((g) => g.startsWith("<")),
    );
    for (const agent of seqs) {
      it(`${doc}: ${agent.name}`, () => {
        const gaps: string[] = [];
        for (let i = 1; i < agent.genes.length; i++) {
          const prev = contract(agent.genes[i - 1]);
          const next = contract(agent.genes[i]);
          expect(prev, `${agent.genes[i - 1]} has no phenotype to check`).toBeDefined();
          expect(next, `${agent.genes[i]} has no phenotype to check`).toBeDefined();
          const missing = next!.required.filter((f) => !prev!.outputs.includes(f));
          if (missing.length) gaps.push(`${agent.genes[i - 1]} → ${agent.genes[i]}: missing ${missing.join(", ")}`);
        }
        expect(gaps).toEqual([]);
      });
    }
  }
});

describe("the agent Skill's composition notes", () => {
  const skill = readFileSync(join(ROOT, "skills/rotifer-agent/SKILL.md"), "utf-8");

  it("does not say schema compatibility goes unchecked: agent create warns (#446)", () => {
    expect(skill).not.toMatch(/does not auto-validate/);
  });

  it("does not offer nesting by editing the agent file, which agent run ignores (#446)", () => {
    expect(skill).not.toMatch(/Nested compositions require manual editing/);
  });
});

describe("TryPool is failover, not a race (#445)", () => {
  it("runs only the active gene while it succeeds", async () => {
    const calls: string[] = [];
    const engine = new DomainFailoverEngine();
    for (const name of ["first", "second"]) {
      engine.registerGene(name, "test.pool", async () => {
        calls.push(name);
        return { success: true, output: { from: name }, engine: "node", durationMs: 1 };
      });
    }
    engine.initialize();
    await engine.executeDomain("test.pool", {});
    await engine.executeDomain("test.pool", {});
    expect(calls).toEqual(["first", "first"]);
  });

  for (const doc of ["skills/rotifer-agent/SKILL.md", "skills/rotifer-agent/README.md", "plugin-source/content/root/assistant/SKILL.md"]) {
    it(`${doc} does not describe it as a race`, () => {
      const rows = readFileSync(join(ROOT, doc), "utf-8").split("\n").filter((l) => l.includes("TryPool") && l.startsWith("|"));
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row).not.toMatch(/race|racing|first success|first wins|best of/i);
    });
  }
});
