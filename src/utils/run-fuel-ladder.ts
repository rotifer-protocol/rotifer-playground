import { DEFAULT_SANDBOX_CONSTRAINTS } from "./sandbox-defaults.js";

/**
 * Why a ladder instead of one number: the evaluation harness used to hand every
 * Gene the same 5e8 fuel budget, and a compute-heavy Gene that produced legal
 * output on every input it finished was scored as if it had crashed. Measured
 * on the bundled corpus: the evolve-life family failed admission 1/3, 1/3, 2/3
 * — every failure "resource limit exceeded: fuel exhausted", none a crash —
 * while the sparse-optimised variant scored *worse* for doing more work per
 * generation. The budget is our constant, not the Gene's defect.
 *
 * A ladder keeps both properties we care about:
 *   - completion: a run that dies of fuel alone is retried with more, up to a
 *     hard cap, so "expensive" stops reading as "broken";
 *   - honesty: the fuel actually burned is what lands in resource_cost, and
 *     F(g)'s efficiency term already prices it — a Gene that needs 8e9 fuel
 *     pays for 8e9 fuel. Nothing here makes an expensive Gene look cheap.
 *
 * The cap is finite on purpose: a Gene that exhausts the top rung records a
 * fuel-exhausted failure, because at some point "needs more fuel" is the
 * finding. Wall-clock and memory limits stay fixed at every rung — the ladder
 * raises fuel only.
 */
export const FUEL_LADDER: readonly number[] = [
  DEFAULT_SANDBOX_CONSTRAINTS.max_fuel, // 5e8 — where every run starts
  4_000_000_000,
  // Sized from measurement, not guesswork: evolve-life's dense evaluation
  // inputs (64×64, 100 generations, glider/pulsar) burn ~1.14e10 fuel and
  // finish in ~1.2s of the 60s wall clock. 3.2e10 gives that ~3× headroom;
  // the wall clock stays the backstop against a rung this high running long.
  32_000_000_000,
];

export type RunFailureKind =
  | "fuel-exhausted"
  | "memory-exceeded"
  | "timeout"
  | "crash";

/**
 * Classify a failed run from the sandbox's error message. Returns null for a
 * successful run (no message). Unrecognised messages are "crash": the ledger's
 * job is to separate "ran out of a resource we rationed" from everything else,
 * and only the recognised resource messages earn the distinction.
 */
export function classifyRunFailure(
  errorMessage: string | null | undefined,
): RunFailureKind | null {
  if (!errorMessage) return null;
  const msg = errorMessage.toLowerCase();
  if (msg.includes("fuel exhausted") || msg.includes("all fuel consumed")) {
    return "fuel-exhausted";
  }
  if (msg.includes("memory")) return "memory-exceeded";
  if (msg.includes("timeout") || msg.includes("time limit") || msg.includes("epoch deadline")) {
    return "timeout";
  }
  return "crash";
}

/** The constraints JSON for one rung of the ladder. */
export function constraintsForFuel(maxFuel: number): string {
  return JSON.stringify({ ...DEFAULT_SANDBOX_CONSTRAINTS, max_fuel: maxFuel });
}
