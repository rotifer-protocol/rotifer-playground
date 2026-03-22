import { describe, it, expect, vi, afterEach } from "vitest";

describe("Binding loader", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isNativeAvailable returns boolean", async () => {
    const { isNativeAvailable } = await import("../../src/utils/binding.js");
    const result = isNativeAvailable();
    expect(typeof result).toBe("boolean");
  });

  it("tryLoadBinding returns NativeBinding or null", async () => {
    const { tryLoadBinding } = await import("../../src/utils/binding.js");
    const binding = tryLoadBinding();
    if (binding !== null) {
      expect(typeof binding.compileGeneToFile).toBe("function");
      expect(typeof binding.verifyIrModule).toBe("function");
      expect(typeof binding.buildEchoGeneWasm).toBe("function");
    } else {
      expect(binding).toBeNull();
    }
  });
});
