import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { evaluatePublishGate } from "../../src/testsuite/gate.js";
import type { GeneRunner } from "../../src/testsuite/run.js";
import { publishSingleGene } from "../../src/commands/publish.js";
import type { CloudCredentials } from "../../src/cloud/types.js";

/**
 * spec §47.5 makes T1 a MUST for DRAFT→PUBLISHED. It was unenforced until this
 * gate — which is how 62 Native genes reached the registry, and how two of them
 * were republished on 2026-09-07 still not satisfying it.
 *
 * The criterion the gate applies is ADR-333 (roundtable 5:0, 2026-09-07).
 */

const INPUT_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};
const OUTPUT_SCHEMA = {
  type: "object",
  properties: { score: { type: "number" } },
  required: ["score"],
};
const PHENOTYPE = { inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA };

const refuses: GeneRunner = (input) => {
  const ok =
    typeof input === "object" && input !== null &&
    typeof (input as Record<string, unknown>).text === "string" &&
    Object.keys(input as object).every((k) => k === "text");
  return ok
    ? { success: true, output: { score: 1 } }
    : { success: false, errorMessage: "illegal input" };
};

let dir: string;
beforeEach(() => {
  dir = join(tmpdir(), `t1-gate-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeSuite(body: unknown): void {
  writeFileSync(join(dir, "testsuite.json"), JSON.stringify(body));
}

const GOOD_SUITE = {
  testCases: [{ input: { text: "hi" } }, { input: { text: 42 } }],
  config: { fuzzIterations: 10, seed: 1 },
};

describe("§47.5 T1 publishing gate", () => {
  it("passes a Gene whose suite satisfies all three requirements", () => {
    writeSuite(GOOD_SUITE);
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: refuses });
    expect(v.status).toBe("passed");
  });

  it("blocks a Gene with no testsuite.json", () => {
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: refuses });
    expect(v.status).toBe("blocked");
    expect((v as { reason: string }).reason).toMatch(/no testsuite\.json/);
  });

  it("blocks a Gene whose suite is malformed, naming the field", () => {
    writeSuite({ testCases: [{ input: { text: "hi" }, expectedOutputs: 1 }] });
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: refuses });
    expect(v.status).toBe("blocked");
    expect((v as { guidance: string[] }).guidance.join(" ")).toMatch(/expectedOutputs/);
  });

  it("blocks when the suite exists but nothing could run it", () => {
    // "We could not check" is not "it passed". The alternative publishes on the
    // strength of a file nobody executed.
    writeSuite(GOOD_SUITE);
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: null });
    expect(v.status).toBe("blocked");
    expect((v as { guidance: string[] }).guidance.join(" ")).toMatch(/not been run is not evidence/);
  });

  it("gates Wrapped genes too — §47.5's MUST is not conditional on fidelity", () => {
    // This was an exemption until 2026-09-07, and 35 published Wrapped records
    // went out under it. It surfaced while deciding genesis-file-read's
    // fidelity: it imports node:fs so it can never be Native, and relabelling
    // it Wrapped while Wrapped was exempt would have moved a gene through the
    // gap rather than through the gate.
    writeSuite(GOOD_SUITE);
    const passing = evaluatePublishGate({ geneDir: dir, fidelity: "Wrapped", phenotype: PHENOTYPE, run: refuses });
    expect(passing.status).toBe("passed");

    const noSuite = evaluatePublishGate({ geneDir: `${dir}-absent`, fidelity: "Wrapped", phenotype: PHENOTYPE, run: refuses });
    expect(noSuite.status).toBe("blocked");
  });

  it("blocks a Wrapped gene that fails T1, exactly as a Native one", () => {
    writeSuite(GOOD_SUITE);
    const accepts: GeneRunner = () => ({ success: true, output: { score: 1 } });
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Wrapped", phenotype: PHENOTYPE, run: accepts });
    expect(v.status).toBe("blocked");
  });

  it("blocks the ADR-333 case the criterion exists for: silent acceptance", () => {
    // A Gene that answers illegal input as if it were fine, with no declaration
    // saying that answer is intended. source-linker echoing an illegal value
    // back is the real instance.
    writeSuite(GOOD_SUITE);
    const accepts: GeneRunner = () => ({ success: true, output: { score: 1 } });
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: accepts });
    expect(v.status).toBe("blocked");
    expect((v as { reason: string }).reason).toMatch(/negative/);
  });

  it("passes a Gene that answers illegal input, once the author declares it", () => {
    // The json-validator shape. ADR-333 rejects option B precisely so this can
    // pass: returning { valid: false } is correct handling, not acceptance.
    writeSuite({
      testCases: [
        { input: { text: "hi" } },
        { input: { text: 42 }, expectedOutput: { score: 0 } },
      ],
      config: { fuzzIterations: 10, seed: 1 },
    });
    const validatorLike: GeneRunner = (input) =>
      typeof (input as Record<string, unknown>).text === "string"
        ? { success: true, output: { score: 1 } }
        : { success: true, output: { score: 0 } };
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: validatorLike });
    expect(v.status).toBe("passed");
  });
});

describe("the gate always says what to do next", () => {
  /**
   * ADR-333 records the ecosystem seat's vote as conditional on this: a gate
   * that answers "negative case failed" and stops has told the author nothing
   * they can act on, and an unactionable gate gets routed around rather than
   * satisfied. Asserted here so the condition is mechanical, not a promise.
   */
  const runnableCommand = /rotifer (test|compile)/;

  it("points at --scaffold when the suite is missing", () => {
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: refuses });
    const guidance = (v as { guidance: string[] }).guidance.join("\n");
    expect(guidance).toMatch(/--scaffold/);
    expect(guidance).toMatch(runnableCommand);
  });

  it("points at compile when the Gene could not be executed", () => {
    writeSuite(GOOD_SUITE);
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: null });
    expect((v as { guidance: string[] }).guidance.join("\n")).toMatch(/rotifer compile/);
  });

  it("names each failing check and how to declare intended handling", () => {
    writeSuite(GOOD_SUITE);
    const accepts: GeneRunner = () => ({ success: true, output: { score: 1 } });
    const v = evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: accepts });
    const guidance = (v as { guidance: string[] }).guidance.join("\n");
    expect(guidance).toMatch(/t1-negative-1/);
    expect(guidance).toMatch(/expectedOutput or expectedSchema/);
    expect(guidance).toMatch(runnableCommand);
  });

  it("never blocks without guidance", () => {
    // The invariant behind all three cases above, stated once so a new blocking
    // branch cannot be added without one.
    const blocked = [
      evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: refuses }),
      evaluatePublishGate({ geneDir: dir, fidelity: "Native", phenotype: PHENOTYPE, run: null }),
    ];
    for (const v of blocked) {
      expect(v.status).toBe("blocked");
      expect((v as { guidance: string[] }).guidance.length).toBeGreaterThan(0);
      expect((v as { guidance: string[] }).guidance.join("\n")).toMatch(runnableCommand);
    }
  });
});

describe("publish actually reaches the gate", () => {
  /**
   * The tests above prove the gate decides correctly. They do not prove
   * publish.ts calls it — a module can be right and unreachable. This is the
   * seam where the §47.5 MUST either applies or silently does not, so it gets
   * its own check rather than being inferred from the unit tests.
   *
   * Offline: the gate runs before anything touches the network, and a Native
   * gene with an artifact but no testsuite.json is blocked at the load step,
   * which does not depend on a runtime being present.
   */
  const CREDS: CloudCredentials = {
    access_token: "test-token-not-used-offline",
    refresh_token: "test-refresh-not-used-offline",
    expires_at: Date.now() + 3_600_000,
    provider: "github",
    user: {
      id: "00000000-0000-0000-0000-000000000000",
      username: "offline-test",
      avatar_url: null,
      provider_id: "offline-test",
    },
  };

  it("refuses a Native gene that has its artifact but no TestSuite", async () => {
    writeFileSync(
      join(dir, "phenotype.json"),
      JSON.stringify({ name: "gated", version: "0.1.0", fidelity: "Native", ...PHENOTYPE }),
    );
    writeFileSync(join(dir, "gene.ir.wasm"), "\0asm\x01\x00\x00\x00");

    const result = await publishSingleGene(
      "gated",
      dir,
      CREDS,
      { skipSecurity: true, skipArena: true, skipVg: true },
      true,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/§47\.5 T1 gate/);
    expect(result.error).toMatch(/no testsuite\.json/);
  });

  it("refuses a Wrapped gene with no TestSuite, through the same seam", () => {
    // The Native case above passed while Wrapped was exempt, so it could not
    // have caught the hole. This is the case that would have stayed green while
    // 35 Wrapped records published unchecked.
    writeFileSync(
      join(dir, "phenotype.json"),
      JSON.stringify({ name: "wrapped-gated", version: "0.1.0", fidelity: "Wrapped", ...PHENOTYPE }),
    );
    writeFileSync(join(dir, "index.ts"), "export function express(i) { return { score: 1 }; }\n");

    return publishSingleGene(
      "wrapped-gated",
      dir,
      CREDS,
      { skipSecurity: true, skipArena: true, skipVg: true },
      true,
    ).then((result) => {
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/§47\.5 T1 gate/);
    });
  });
});
