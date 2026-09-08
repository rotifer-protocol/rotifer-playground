import { pathToFileURL } from "node:url";
import { loadTestSuite } from "./load.js";
import { runT1 } from "./run.js";
import type { GeneRunner, RunOutcome } from "./run.js";

/**
 * spec §47.5 publishing gate, as decided in ADR-333.
 *
 * §47.5 makes T1 a MUST for DRAFT→PUBLISHED. Until this existed the MUST was
 * unenforced, which is how 62 Native genes reached the registry — and how two
 * of them were republished on 2026-09-07 without satisfying it.
 *
 * Kept out of publish.ts so the decision "may this be published" is testable
 * without a publish: the same three requirements, the same verdict, no network.
 */

export type GateVerdict =
  | { status: "passed"; details: string }
  | { status: "blocked"; reason: string; guidance: string[] }
  | { status: "not-applicable"; reason: string };

/**
 * The guidance lines are load-bearing, not decoration.
 *
 * ADR-333 records the ecosystem seat's vote as conditional on exactly this:
 * a gate that answers "negative case failed" and stops has told the author
 * nothing they can act on, and an unactionable gate gets routed around rather
 * than satisfied. `publish-gate.test.ts` asserts these lines survive, so the
 * condition is mechanical rather than a promise.
 */
const MISSING_SUITE_GUIDANCE = [
  "spec §47.5 requires, before DRAFT -> PUBLISHED:",
  "  • at least 1 positive case (input your inputSchema accepts)",
  "  • at least 1 negative case (input it forbids, handled correctly)",
  "  • a schema-legality property test over 10 generated inputs",
  "Generate a starting point:  rotifer test --scaffold <gene>",
  "Then run it:                rotifer test <gene>",
];

export interface GateInput {
  geneDir: string;
  fidelity: string;
  phenotype: { inputSchema?: unknown; outputSchema?: unknown };
  /** Runs one input against the compiled Gene. Null when no runtime is
   * available — see the not-applicable branch. */
  run: GeneRunner | null;
}

export function evaluatePublishGate(input: GateInput): GateVerdict {
  const load = loadTestSuite(input.geneDir);

  if (load.status === "absent") {
    return {
      status: "blocked",
      reason: "no testsuite.json — spec §47.5 T1 is a MUST before publishing",
      guidance: MISSING_SUITE_GUIDANCE,
    };
  }

  if (load.status === "invalid") {
    return {
      status: "blocked",
      reason: "testsuite.json is not valid",
      guidance: [...load.errors, "", "Fix the fields above, then: rotifer test <gene>"],
    };
  }

  if (!input.run) {
    // No runtime, so the suite cannot be executed. Blocking rather than waving
    // it through: "we could not check" is not "it passed", and the alternative
    // publishes on the strength of a file nobody ran.
    return {
      status: "blocked",
      reason: "testsuite.json exists but the Gene could not be executed to run it",
      guidance: [
        "Compile first so the suite can run:  rotifer compile <gene>",
        "A suite that has not been run is not evidence.",
      ],
    };
  }

  const report = runT1(load.suite, {
    inputSchema: (input.phenotype.inputSchema as Record<string, unknown>) ?? null,
    outputSchema: (input.phenotype.outputSchema as Record<string, unknown>) ?? null,
    run: input.run,
  });

  if (report.gatePassed) {
    return {
      status: "passed",
      details: `T1 satisfied — ${report.results.filter((r) => r.passed).length}/${report.results.length} checks`,
    };
  }

  const req = report.requirements;
  const unmet = [
    ...(req.positive ? [] : ["positive"]),
    ...(req.negative ? [] : ["negative"]),
    ...(req.property ? [] : ["property"]),
  ];
  const failures = report.results
    .filter((r) => !r.passed)
    .map((r) => `  ${r.testId}: ${r.failureReason}${r.details ? `\n      ${r.details}` : ""}`);

  return {
    status: "blocked",
    reason: `spec §47.5 T1 not satisfied — unmet: ${unmet.join(", ")}`,
    guidance: [
      ...failures,
      "",
      "Each failure above names what to change. A negative case that returns output",
      "rather than refusing is not automatically wrong — declare the answer you mean",
      "with expectedOutput or expectedSchema (ADR-333).",
      "Re-run locally with:  rotifer test <gene>",
    ],
  };
}

/** Adapter: the sandbox reports every failure alike, so anything that is not a
 * clean return is reported as crashed. See runNegative for why that is the
 * conservative reading rather than a limitation. */
export function outcomeFromSandbox(r: {
  success: boolean;
  output?: unknown;
  errorMessage?: string | null;
  durationMs?: number;
}): RunOutcome {
  return r.success
    ? { success: true, output: r.output, durationMs: r.durationMs }
    : { success: false, crashed: true, errorMessage: r.errorMessage ?? undefined };
}

/**
 * Build a GeneRunner for a Wrapped gene, which has no IR and executes in its
 * native language under Node.
 *
 * This exists because the gate skipping Wrapped was a hole, not a design. §47.5
 * makes T1 a MUST for every DRAFT->PUBLISHED transition, not only Native ones,
 * and 35 published Wrapped records went out under that exemption.
 *
 * It surfaced while deciding genesis-file-read's fidelity: it imports node:fs,
 * so it can never compile to Native, and Wrapped is the honest label. Making
 * that change while Wrapped was exempt would have relabelled a gene straight
 * through the gap — the shape of thing this plan exists to stop. So the hole is
 * closed first, and the relabel then costs what it should.
 *
 * Async because a dynamic import is: the module is loaded once here, and the
 * returned runner is synchronous over the resolved export.
 *
 * The L0 gate is consulted BEFORE the import, not before express(): importing
 * executes module top-level code, so a check afterwards checks nothing.
 */
export async function loadNodeRunner(
  absSourcePath: string,
  l0: { kind: string; detail?: string },
): Promise<{ runner: GeneRunner } | { refusal: string }> {
  if (l0.kind === "violation") {
    return { refusal: `L0 gate blocked this gene: ${l0.detail ?? "no detail"}` };
  }

  let expressFn: (input: unknown) => unknown;
  try {
    const mod = await import(pathToFileURL(absSourcePath).href);
    if (typeof mod.express !== "function") {
      return { refusal: "gene does not export an express() function" };
    }
    expressFn = mod.express as (input: unknown) => unknown;
  } catch (e) {
    return { refusal: `could not load the gene module: ${(e as Error).message}` };
  }

  const runner: GeneRunner = (input) => {
    const started = Date.now();
    try {
      const output = expressFn(input);
      if (output === null || output === undefined) {
        // Distinct from throwing, and worth its own message: a Gene that
        // returns nothing has not refused, it has silently produced no answer.
        return { success: false, crashed: true, errorMessage: "express() returned null/undefined" };
      }
      return { success: true, output, durationMs: Date.now() - started };
    } catch (e) {
      return { success: false, crashed: true, errorMessage: (e as Error).message };
    }
  };

  return { runner };
}
