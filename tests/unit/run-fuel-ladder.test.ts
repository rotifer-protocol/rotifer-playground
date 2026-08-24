import { describe, expect, it } from "vitest";
import {
  FUEL_LADDER,
  classifyRunFailure,
  constraintsForFuel,
} from "../../src/utils/run-fuel-ladder.js";
import { DEFAULT_SANDBOX_CONSTRAINTS } from "../../src/utils/sandbox-defaults.js";

describe("classifyRunFailure", () => {
  it("recognises the sandbox's fuel message verbatim", () => {
    // The exact string wasmtime_sandbox.rs produces — the classifier's whole
    // job is to match what the real sandbox says, not a paraphrase.
    expect(classifyRunFailure("resource limit exceeded: fuel exhausted")).toBe("fuel-exhausted");
    expect(classifyRunFailure("E0021: all fuel consumed by WebAssembly")).toBe("fuel-exhausted");
  });

  it("separates the other rationed resources", () => {
    expect(classifyRunFailure("resource limit exceeded: memory limit")).toBe("memory-exceeded");
    expect(classifyRunFailure("execution timeout after 60000ms")).toBe("timeout");
    expect(classifyRunFailure("epoch deadline reached")).toBe("timeout");
  });

  it("everything unrecognised is a crash, not a guess", () => {
    expect(classifyRunFailure("E0007: wasm trap: unreachable")).toBe("crash");
    expect(classifyRunFailure("something entirely new")).toBe("crash");
  });

  it("no message means no failure", () => {
    expect(classifyRunFailure(null)).toBeNull();
    expect(classifyRunFailure(undefined)).toBeNull();
    expect(classifyRunFailure("")).toBeNull();
  });
});

describe("FUEL_LADDER", () => {
  it("starts exactly at the default budget — rung 0 is the status quo", () => {
    expect(FUEL_LADDER[0]).toBe(DEFAULT_SANDBOX_CONSTRAINTS.max_fuel);
  });

  it("is strictly increasing and finite", () => {
    for (let i = 1; i < FUEL_LADDER.length; i++) {
      expect(FUEL_LADDER[i]).toBeGreaterThan(FUEL_LADDER[i - 1]);
    }
    expect(FUEL_LADDER.length).toBeGreaterThanOrEqual(2);
  });
});

describe("constraintsForFuel", () => {
  it("raises fuel only — wall-clock and memory ceilings stay fixed", () => {
    const c = JSON.parse(constraintsForFuel(FUEL_LADDER[2]));
    expect(c.max_fuel).toBe(FUEL_LADDER[2]);
    expect(c.max_memory_bytes).toBe(DEFAULT_SANDBOX_CONSTRAINTS.max_memory_bytes);
    expect(c.max_execution_time_ms).toBe(DEFAULT_SANDBOX_CONSTRAINTS.max_execution_time_ms);
  });
});
