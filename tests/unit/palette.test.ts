import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("palette", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exports hex color constants", async () => {
    const { hex } = await import("../../src/utils/palette.js");
    expect(hex.accent).toBe("#00C9A7");
    expect(hex.error).toBe("#F87171");
    expect(hex.success).toBe("#4ADE80");
    expect(hex.warn).toBe("#FBBF24");
    expect(hex.info).toBe("#6EC6FF");
    expect(hex.muted).toBe("#94A3B8");
  });

  it("exports semantic color functions", async () => {
    const { c } = await import("../../src/utils/palette.js");
    expect(typeof c.accent).toBe("function");
    expect(typeof c.error).toBe("function");
    expect(typeof c.success).toBe("function");
    expect(typeof c.warn).toBe("function");
    expect(typeof c.info).toBe("function");
    expect(typeof c.muted).toBe("function");
    expect(typeof c.bold).toBe("function");
    expect(typeof c.dim).toBe("function");
  });

  it("exports icon constants", async () => {
    const { icon } = await import("../../src/utils/palette.js");
    expect(icon.success).toBe("✓");
    expect(icon.error).toBe("✗");
    expect(icon.warn).toBe("⚠");
    expect(icon.info).toBe("ℹ");
    expect(icon.arrow).toBe("→");
    expect(icon.dash).toBe("─");
  });

  it("fidelityColor returns green for Native", async () => {
    const { fidelityColor } = await import("../../src/utils/palette.js");
    const result = fidelityColor("Native");
    expect(result).toContain("Native");
  });

  it("fidelityColor returns info color for Hybrid", async () => {
    const { fidelityColor } = await import("../../src/utils/palette.js");
    const result = fidelityColor("Hybrid");
    expect(result).toContain("Hybrid");
  });

  it("fidelityColor returns muted for Wrapped", async () => {
    const { fidelityColor } = await import("../../src/utils/palette.js");
    const result = fidelityColor("Wrapped");
    expect(result).toContain("Wrapped");
  });

  it("scoreColor handles null", async () => {
    const { scoreColor } = await import("../../src/utils/palette.js");
    const result = scoreColor(null);
    expect(result).toContain("—");
  });

  it("scoreColor handles high score", async () => {
    const { scoreColor } = await import("../../src/utils/palette.js");
    const result = scoreColor(0.85);
    expect(result).toContain("0.8500");
  });

  it("scoreColor handles medium score", async () => {
    const { scoreColor } = await import("../../src/utils/palette.js");
    const result = scoreColor(0.5);
    expect(result).toContain("0.5000");
  });

  it("scoreColor handles low score", async () => {
    const { scoreColor } = await import("../../src/utils/palette.js");
    const result = scoreColor(0.1);
    expect(result).toContain("0.1000");
  });

  it("c.* getters respect chalk.level changes", async () => {
    const chalk = (await import("chalk")).default;
    const { c } = await import("../../src/utils/palette.js");
    const originalLevel = chalk.level;
    try {
      chalk.level = 0 as typeof chalk.Level;
      const result = c.accent("test");
      expect(result).toBe("test");

      chalk.level = 3 as typeof chalk.Level;
      const colored = c.accent("test");
      expect(colored).not.toBe("test");
      expect(colored).toContain("test");
    } finally {
      chalk.level = originalLevel;
    }
  });
});
