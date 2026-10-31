/** Helpers for e2e tests that drive the built CLI. */
import { expect } from "vitest";

/** The JSON `agent run` prints after "Final output:" (pretty-printed; it ends at the first column-0 "}"). */
export function finalOutput(stdout: string): unknown {
  const at = stdout.indexOf("Final output:");
  expect(at, stdout).toBeGreaterThan(-1);
  const lines = stdout.slice(stdout.indexOf("\n", at) + 1).split("\n");
  const end = lines.findIndex((l) => l === "}");
  expect(end, stdout).toBeGreaterThan(-1);
  return JSON.parse(lines.slice(0, end + 1).join("\n"));
}

/** The environment e2e runs use: no colour, no telemetry. */
export const cliEnv: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: "0", ROTIFER_TELEMETRY: "0", DO_NOT_TRACK: "1" };
