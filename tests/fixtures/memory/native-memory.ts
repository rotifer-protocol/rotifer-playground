/**
 * rotifer-napi's AgentMemory for tests that must run against the real store.
 *
 * When the loaded addon has no memory functions (an addon built before
 * v0.9.4), such a suite is skipped — unless ROTIFER_REQUIRE_NATIVE_MEMORY=1,
 * in which case it fails, saying what is missing. Set it wherever the addon
 * is known to carry memory (CI once it builds or installs a v0.9.4 addon; a
 * local run against a freshly built one), so a missing store cannot pass as
 * a skip there.
 */
import { describe, it, expect } from "vitest";
import { tryLoadBinding } from "../../../src/utils/binding.js";
import { hasNativeMemory, type NativeMemoryApi } from "../../../src/memory/backend.js";

export const NATIVE_MEMORY_REQUIRED = process.env.ROTIFER_REQUIRE_NATIVE_MEMORY === "1";

/** A PlaygroundBinding on `projectDir` (store: `<projectDir>/.rotifer/playground.db`), or null. */
export function openNativeMemory(projectDir: string): NativeMemoryApi | null {
  const loaded = tryLoadBinding() as unknown as { constructor?: new (dir: string) => unknown } | null;
  if (!loaded || typeof loaded.constructor !== "function") return null;
  const binding = new loaded.constructor(projectDir);
  return hasNativeMemory(binding) ? binding : null;
}

export const NATIVE_MEMORY_AVAILABLE = (() => {
  const loaded = tryLoadBinding();
  return loaded !== null && hasNativeMemory(loaded);
})();

/** describe() that runs with the native store, is skipped without it, and fails without it when required. */
export function describeWithNativeMemory(name: string, body: () => void): void {
  if (!NATIVE_MEMORY_AVAILABLE && NATIVE_MEMORY_REQUIRED) {
    describe(name, () => {
      it("needs rotifer-napi with AgentMemory (ROTIFER_REQUIRE_NATIVE_MEMORY=1)", () => {
        expect.fail(
          "the loaded rotifer native addon has no memory functions (memoryRead … memoryCreate); build crates/rotifer-napi from this checkout or install a v0.9.4 @rotifer/playground-<platform>",
        );
      });
    });
    return;
  }
  // A conditional skip on a runtime precondition — the addon's memory functions.
  describe.skipIf(!NATIVE_MEMORY_AVAILABLE)(
    NATIVE_MEMORY_AVAILABLE ? name : `${name} (skipped: the loaded rotifer native addon has no AgentMemory)`,
    body,
  );
}
