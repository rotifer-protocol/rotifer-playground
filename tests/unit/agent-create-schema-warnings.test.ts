/**
 * agent create checks field compatibility only where fields flow (#446).
 *
 * Only Seq hands one gene's output to the next. Par, Cond and Try give every
 * gene the same input, and TryPool runs one gene of a domain at a time, yet
 * every multi-gene agent got the Seq check — so the getting-started example
 * `--domain search --top 2 --composition TryPool` printed "FAIL — missing:
 * [query]" for a pipeline that never chains.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAgentCore } from "../../src/commands/agent-create.js";

function writeGene(root: string, name: string, required: string[], outputs: string[]) {
  const dir = join(root, "genes", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "phenotype.json"),
    JSON.stringify({
      domain: "test.pool",
      version: "0.1.0",
      fidelity: "Native",
      inputSchema: { type: "object", properties: Object.fromEntries(required.map((f) => [f, { type: "string" }])), required },
      outputSchema: { type: "object", properties: Object.fromEntries(outputs.map((f) => [f, { type: "string" }])) },
    }),
  );
}

describe("schema compatibility warnings by composition", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rotifer-agent-warn-"));
    mkdirSync(join(root, ".rotifer", "agents"), { recursive: true });
    // The second gene needs `query`, which the first does not output.
    writeGene(root, "search-a", ["query"], ["results"]);
    writeGene(root, "search-b", ["query"], ["answer"]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function warningsFor(compositionType: string): string[] {
    let seen: string[] = [];
    createAgentCore({
      root,
      genesDir: "genes",
      agentName: `agent-${compositionType.toLowerCase()}`,
      genome: ["search-a", "search-b"],
      compositionType,
      strategy: "manual",
      onSchemaWarnings: (w: string[]) => {
        seen = w;
      },
    });
    return seen;
  }

  it("warns for Seq, where the first gene's output is the second's input", () => {
    expect(warningsFor("Seq").join("\n")).toContain("missing: [query]");
  });

  it.each(["TryPool", "Par", "Cond", "Try"])("does not warn for %s, where it is not", (composition) => {
    expect(warningsFor(composition)).toEqual([]);
  });
});
